# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

# Module imports
from plane.app.permissions.wiki_page import project_wiki_data
from plane.db.models import FileAsset, Page
from .base import BaseSerializer


class WikiPageProjectWikiSerializer(serializers.Serializer):
    """Project whose wiki section a page is the root of (schema only)."""

    project_id = serializers.UUIDField()
    identifier = serializers.CharField()
    name = serializers.CharField()


class WikiPageSerializer(BaseSerializer):
    """
    Read-only representation of a workspace wiki page without its body.

    `parent` is exposed as a plain UUID (`source="parent_id"`) so that it stays
    out of BaseSerializer's `expand` map, which would otherwise try to render a
    Page through IssueLiteSerializer. `label_ids` and `sub_pages_count` come
    from queryset annotations. `project_wiki` is set on the root page of a
    project's wiki section and null on every other page.
    """

    parent = serializers.UUIDField(source="parent_id", read_only=True, allow_null=True)
    label_ids = serializers.ListField(child=serializers.UUIDField(), read_only=True)
    sub_pages_count = serializers.IntegerField(read_only=True)
    # Always true in the feed, which only lists published pages
    is_published = serializers.BooleanField(read_only=True)
    project_wiki = serializers.SerializerMethodField()

    class Meta:
        model = Page
        fields = [
            "id",
            "name",
            "parent",
            "sort_order",
            "access",
            "is_locked",
            "archived_at",
            "logo_props",
            "color",
            "owned_by",
            "label_ids",
            "sub_pages_count",
            "description_stripped",
            "created_at",
            "updated_at",
            "workspace",
            "is_published",
            "project_wiki",
        ]
        read_only_fields = fields

    @extend_schema_field(WikiPageProjectWikiSerializer(allow_null=True))
    def get_project_wiki(self, obj):
        return project_wiki_data(obj)


class WikiPageAssetSerializer(serializers.Serializer):
    """Uploaded file embedded in a wiki page body (schema only)."""

    id = serializers.UUIDField()
    name = serializers.CharField(allow_null=True)
    type = serializers.CharField(allow_null=True)
    size = serializers.FloatField()


class WikiPageDetailSerializer(WikiPageSerializer):
    """
    Wiki page with its HTML body and the uploaded assets embedded in it.

    `assets` lists the page's uploaded PAGE_DESCRIPTION file assets so that an
    exporter can download the images referenced by `description_html` (through
    the existing workspace asset endpoint) without parsing the HTML first.
    """

    description_html = serializers.CharField(read_only=True)
    assets = serializers.SerializerMethodField()

    class Meta(WikiPageSerializer.Meta):
        fields = WikiPageSerializer.Meta.fields + ["description_html", "assets"]
        read_only_fields = fields

    @extend_schema_field(WikiPageAssetSerializer(many=True))
    def get_assets(self, obj):
        assets = FileAsset.objects.filter(
            page_id=obj.id,
            workspace_id=obj.workspace_id,
            entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
            is_uploaded=True,
            is_deleted=False,
        ).order_by("created_at")
        return [
            {
                "id": str(asset.id),
                "name": (asset.attributes or {}).get("name"),
                "type": (asset.attributes or {}).get("type"),
                "size": asset.size,
            }
            for asset in assets
        ]
