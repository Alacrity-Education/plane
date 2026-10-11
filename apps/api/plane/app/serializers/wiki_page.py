# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db.models import Q

# Third party imports
from rest_framework import serializers

# Module imports
from plane.app.permissions.wiki_page import project_wiki_data, wiki_pages_queryset
from plane.app.serializers.page import PageSerializer
from plane.db.models import Page, PageLabel, ProjectWiki
from plane.utils.content_validator import validate_html_content

# Guard against corrupt (cyclic) parent chains when walking up the tree
MAX_PAGE_DEPTH = 1000


class WorkspacePageSerializer(PageSerializer):
    """
    Workspace wiki page: a project-less Page(is_global=True). Output keeps the
    project PageSerializer shape (project_ids is always []) plus the nesting
    fields used by the wiki tree.
    """

    parent = serializers.PrimaryKeyRelatedField(queryset=Page.objects.all(), required=False, allow_null=True)
    sort_order = serializers.FloatField(required=False)
    sub_pages_count = serializers.IntegerField(read_only=True)
    is_published = serializers.BooleanField(read_only=True)
    # Annotation-backed; labels are written through `labels`
    label_ids = serializers.ListField(child=serializers.UUIDField(), read_only=True)
    project_ids = serializers.ListField(child=serializers.UUIDField(), read_only=True)
    # Project whose wiki section this page roots ({project_id, identifier, name}) or null
    project_wiki = serializers.SerializerMethodField()

    class Meta(PageSerializer.Meta):
        fields = PageSerializer.Meta.fields + [
            "sort_order",
            "is_global",
            "sub_pages_count",
            "is_published",
            "project_wiki",
        ]
        read_only_fields = ["workspace", "owned_by", "is_global"]

    def get_project_wiki(self, obj):
        return project_wiki_data(obj)

    def validate(self, attrs):
        # A project wiki root stays a top-level page
        if (
            self.instance is not None
            and attrs.get("parent") is not None
            and ProjectWiki.objects.filter(root_page_id=self.instance.pk).exists()
        ):
            raise serializers.ValidationError({"parent": ["project wiki root cannot be moved"]})
        return super().validate(attrs)

    def validate_sort_order(self, value):
        if value <= 0:
            raise serializers.ValidationError("sort_order must be greater than 0")
        return value

    def validate_labels(self, value):
        workspace_id = self.instance.workspace_id if self.instance else self.context.get("workspace_id")
        for label in value:
            if str(label.workspace_id) != str(workspace_id):
                raise serializers.ValidationError("Labels must belong to the page workspace")
        return value

    def validate_parent(self, value):
        if value is None:
            return value

        slug = self.context.get("slug")
        user_id = self.context.get("owned_by_id")
        # The parent must be a wiki page of the same workspace that the
        # requesting user can see
        parent_qs = wiki_pages_queryset(slug).filter(pk=value.pk)
        if user_id:
            parent_qs = parent_qs.filter(Q(owned_by_id=user_id) | Q(access=Page.PUBLIC_ACCESS))
        if not parent_qs.exists():
            raise serializers.ValidationError("Parent must be a wiki page of this workspace")

        if value.archived_at is not None:
            raise serializers.ValidationError("Parent page is archived")

        # A page cannot become its own ancestor
        if self.instance is not None:
            ancestor_id = value.pk
            depth = 0
            while ancestor_id is not None and depth < MAX_PAGE_DEPTH:
                if str(ancestor_id) == str(self.instance.pk):
                    raise serializers.ValidationError("A page cannot be moved under itself or its sub-pages")
                ancestor_id = Page.all_objects.filter(pk=ancestor_id).values_list("parent_id", flat=True).first()
                depth += 1
        return value

    def create(self, validated_data):
        labels = validated_data.pop("labels", None)

        # Create the page without any ProjectPage link
        page = Page.objects.create(
            **validated_data,
            description_json=self.context["description_json"],
            description_binary=self.context["description_binary"],
            description_html=self.context["description_html"],
            owned_by_id=self.context["owned_by_id"],
            workspace_id=self.context["workspace_id"],
            is_global=True,
        )

        # Create page labels
        if labels is not None:
            PageLabel.objects.bulk_create(
                [
                    PageLabel(
                        label=label,
                        page=page,
                        workspace_id=page.workspace_id,
                        created_by_id=page.created_by_id,
                        updated_by_id=page.updated_by_id,
                    )
                    for label in labels
                ],
                batch_size=10,
            )
        return page


class WorkspacePageDetailSerializer(WorkspacePageSerializer):
    description_html = serializers.CharField(required=False, allow_blank=True)

    class Meta(WorkspacePageSerializer.Meta):
        fields = WorkspacePageSerializer.Meta.fields + ["description_html"]

    def validate_description_html(self, value):
        if not value:
            return value
        is_valid, error_message, sanitized_html = validate_html_content(value)
        if not is_valid:
            raise serializers.ValidationError(error_message)
        return sanitized_html if sanitized_html is not None else value


class ProjectWikiSerializer(serializers.ModelSerializer):
    """A project's wiki section: the link from a project to its root wiki page."""

    project_identifier = serializers.CharField(source="project.identifier", read_only=True)
    project_name = serializers.CharField(source="project.name", read_only=True)
    root_page_name = serializers.CharField(source="root_page.name", read_only=True)

    class Meta:
        model = ProjectWiki
        fields = [
            "id",
            "project",
            "project_identifier",
            "project_name",
            "root_page",
            "root_page_name",
            "created_at",
        ]
        read_only_fields = fields
