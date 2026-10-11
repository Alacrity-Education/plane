# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Workspace wiki pages: project-less Page(is_global=True) rows served under
/api/workspaces/<slug>/wiki/. Mirrors the project page views in base.py, with
the ProjectMember checks replaced by WorkspaceMember roles.
"""

# Python imports
import json
import uuid
from datetime import datetime
from django.core.serializers.json import DjangoJSONEncoder

# Django imports
from django.db.models import (
    Case,
    Count,
    Exists,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    UUIDField,
    Value,
    When,
)
from django.db.models.functions import Cast, Coalesce
from django.contrib.postgres.aggregates import ArrayAgg
from django.contrib.postgres.fields import ArrayField
from django.http import StreamingHttpResponse

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions.wiki_page import (
    ADMIN,
    WorkspacePagePermission,
    get_workspace_role,
    wiki_pages_queryset,
)
from plane.app.serializers.page import (
    PageBinaryUpdateSerializer,
    PageVersionDetailSerializer,
    PageVersionSerializer,
)
from plane.app.serializers.wiki_page import (
    WorkspacePageDetailSerializer,
    WorkspacePageSerializer,
)
from plane.app.views.base import BaseAPIView, BaseViewSet
from plane.app.views.page.base import unarchive_archive_page_and_descendants
from plane.bgtasks.copy_s3_object import copy_s3_objects_of_description_and_assets
from plane.bgtasks.page_transaction_task import page_transaction
from plane.bgtasks.page_version_task import track_page_version
from plane.bgtasks.recent_visited_task import recent_visited_task
from plane.db.models import (
    DeployBoard,
    Page,
    PageLog,
    PageVersion,
    UserFavorite,
    UserRecentVisit,
    Workspace,
)
from plane.utils.content_validator import validate_html_content
from plane.utils.error_codes import ERROR_CODES
from plane.utils.order_queryset import PAGE_ORDER_BY_ALLOWLIST, sanitize_order_by

# Payload keys the live server sends when it writes back the binary converted
# from description_html on the first open of a page


def _visible_wiki_pages(slug, user):
    return wiki_pages_queryset(slug).filter(Q(owned_by=user) | Q(access=Page.PUBLIC_ACCESS))


def annotated_wiki_pages(slug, user, order_by=None):
    """
    Visible wiki pages annotated to match the project PageSerializer output
    (is_favorite, label_ids, project_ids=[]) plus the nesting fields.
    """
    favorite_subquery = UserFavorite.objects.filter(
        user=user,
        entity_type="page",
        entity_identifier=OuterRef("pk"),
        workspace__slug=slug,
    )
    # Sub pages the user can see (archived and soft-deleted excluded)
    sub_pages_subquery = (
        Page.objects.filter(parent_id=OuterRef("pk"), archived_at__isnull=True)
        .filter(Q(owned_by=user) | Q(access=Page.PUBLIC_ACCESS))
        .order_by()
        .values("parent_id")
        .annotate(count=Count("id"))
        .values("count")
    )
    return (
        _visible_wiki_pages(slug, user)
        .select_related("workspace")
        .select_related("owned_by")
        .prefetch_related("labels")
        .annotate(
            is_favorite=Exists(favorite_subquery),
            is_published=Exists(
                DeployBoard.objects.filter(
                    entity_name="page",
                    entity_identifier=OuterRef("pk"),
                    workspace__slug=slug,
                )
            ),
            sub_pages_count=Coalesce(
                Subquery(sub_pages_subquery, output_field=IntegerField()),
                Value(0),
            ),
        )
        # Favourites stay pinned first; the sanitized user ordering is the
        # secondary sort, with id as a stable tiebreak.
        .order_by(
            "-is_favorite",
            sanitize_order_by(order_by, PAGE_ORDER_BY_ALLOWLIST, default="sort_order"),
            "id",
        )
        .annotate(
            label_ids=Coalesce(
                ArrayAgg(
                    "page_labels__label_id",
                    distinct=True,
                    filter=Q(
                        page_labels__label_id__isnull=False,
                        page_labels__deleted_at__isnull=True,
                    ),
                ),
                Value([], output_field=ArrayField(UUIDField())),
            ),
            # Wiki pages never belong to a project; keep the TPage shape
            project_ids=Cast(
                Value([], output_field=ArrayField(UUIDField())),
                output_field=ArrayField(UUIDField()),
            ),
        )
        .distinct()
    )


class WorkspacePageViewSet(BaseViewSet):
    serializer_class = WorkspacePageSerializer
    model = Page
    permission_classes = [WorkspacePagePermission]
    search_fields = ["name"]

    def get_queryset(self):
        return self.filter_queryset(
            annotated_wiki_pages(self.kwargs.get("slug"), self.request.user, self.request.GET.get("order_by"))
        )

    def _get_page(self, slug, page_id):
        return wiki_pages_queryset(slug).get(pk=page_id)

    def _serializer_context(self, slug, workspace_id=None):
        return {
            "slug": slug,
            "workspace_id": workspace_id,
            "owned_by_id": self.request.user.id,
        }

    def list(self, request, slug):
        queryset = self.get_queryset()

        page_type = request.GET.get("type")
        if page_type == "all":
            queryset = queryset.filter(archived_at__isnull=True)
        elif page_type == "public":
            queryset = queryset.filter(access=Page.PUBLIC_ACCESS, archived_at__isnull=True)
        elif page_type == "private":
            queryset = queryset.filter(access=Page.PRIVATE_ACCESS, archived_at__isnull=True)
        elif page_type == "archived":
            queryset = queryset.filter(archived_at__isnull=False)

        parent = request.GET.get("parent")
        if parent is not None:
            if parent in ("", "null"):
                queryset = queryset.filter(parent__isnull=True)
            else:
                try:
                    queryset = queryset.filter(parent_id=uuid.UUID(parent))
                except ValueError:
                    return Response({"error": "Invalid parent"}, status=status.HTTP_400_BAD_REQUEST)

        pages = WorkspacePageSerializer(queryset, many=True).data
        return Response(pages, status=status.HTTP_200_OK)

    def create(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)

        description_html = request.data.get("description_html") or "<p></p>"
        is_valid, error_message, sanitized_html = validate_html_content(description_html)
        if not is_valid:
            return Response({"description_html": [error_message]}, status=status.HTTP_400_BAD_REQUEST)
        if sanitized_html is not None:
            description_html = sanitized_html

        description_binary = None
        if request.data.get("description_binary"):
            binary_serializer = PageBinaryUpdateSerializer(
                data={"description_binary": request.data.get("description_binary")}
            )
            if not binary_serializer.is_valid():
                return Response(binary_serializer.errors, status=status.HTTP_400_BAD_REQUEST)
            description_binary = binary_serializer.validated_data.get("description_binary")

        serializer = WorkspacePageSerializer(
            data=request.data,
            context={
                **self._serializer_context(slug, workspace.id),
                "description_json": request.data.get("description_json") or {},
                "description_binary": description_binary,
                "description_html": description_html,
            },
        )

        if serializer.is_valid():
            page = serializer.save()
            # capture the page transaction
            page_transaction.delay(
                new_description_html=description_html,
                old_description_html=None,
                page_id=page.id,
            )
            page = self.get_queryset().get(pk=page.id)
            serializer = WorkspacePageDetailSerializer(page)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def partial_update(self, request, slug, page_id):
        page = self._get_page(slug, page_id)

        if page.is_locked:
            return Response({"error": "Page is locked"}, status=status.HTTP_400_BAD_REQUEST)

        # Only the page owner can change the access
        if (
            "access" in request.data
            and page.access != request.data.get("access")
            and page.owned_by_id != request.user.id
        ):
            return Response(
                {"error": "Access cannot be updated since this page is owned by someone else"},
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = WorkspacePageDetailSerializer(
            page,
            data=request.data,
            partial=True,
            context=self._serializer_context(slug, page.workspace_id),
        )
        page_description = page.description_html
        if serializer.is_valid():
            serializer.save()
            # capture the page transaction
            if request.data.get("description_html"):
                page_transaction.delay(
                    new_description_html=serializer.instance.description_html,
                    old_description_html=page_description,
                    page_id=page_id,
                )

            page = self.get_queryset().get(pk=page_id)
            return Response(WorkspacePageDetailSerializer(page).data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def retrieve(self, request, slug, page_id=None):
        page = self.get_queryset().filter(pk=page_id).first()
        if page is None:
            return Response({"error": "Page not found"}, status=status.HTTP_404_NOT_FOUND)

        track_visit = request.query_params.get("track_visit", "true").lower() == "true"
        issue_ids = PageLog.objects.filter(page_id=page_id, entity_name="issue").values_list(
            "entity_identifier", flat=True
        )
        data = WorkspacePageDetailSerializer(page).data
        data["issue_ids"] = issue_ids
        if track_visit:
            recent_visited_task.delay(
                slug=slug,
                entity_name="page",
                entity_identifier=page_id,
                user_id=request.user.id,
                project_id=None,
            )
        return Response(data, status=status.HTTP_200_OK)

    def lock(self, request, slug, page_id):
        page = self._get_page(slug, page_id)
        page.is_locked = True
        page.save()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def unlock(self, request, slug, page_id):
        page = self._get_page(slug, page_id)
        page.is_locked = False
        page.save()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def access(self, request, slug, page_id):
        access = request.data.get("access", 0)
        if access not in (Page.PUBLIC_ACCESS, Page.PRIVATE_ACCESS):
            return Response({"error": "Invalid access"}, status=status.HTTP_400_BAD_REQUEST)

        page = self._get_page(slug, page_id)

        # Only the page owner can change the access
        if page.access != access and page.owned_by_id != request.user.id:
            return Response(
                {"error": "Access cannot be updated since this page is owned by someone else"},
                status=status.HTTP_403_FORBIDDEN,
            )

        page.access = access
        page.save()

        # A private page can't stay published
        if access == Page.PRIVATE_ACCESS:
            DeployBoard.objects.filter(entity_name="page", entity_identifier=page.id, workspace__slug=slug).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _is_owner_or_admin(self, request, slug, page):
        return page.owned_by_id == request.user.id or get_workspace_role(request.user, slug) == ADMIN

    def archive(self, request, slug, page_id):
        page = self._get_page(slug, page_id)

        # only the owner or admin can archive the page
        if not self._is_owner_or_admin(request, slug, page):
            return Response(
                {"error": "Only the owner or admin can archive the page"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        UserFavorite.objects.filter(entity_type="page", entity_identifier=page_id, workspace__slug=slug).delete()
        DeployBoard.objects.filter(entity_name="page", entity_identifier=page_id, workspace__slug=slug).delete()

        # Archives the page and all its descendants
        unarchive_archive_page_and_descendants(page_id, datetime.now())

        return Response({"archived_at": str(datetime.now())}, status=status.HTTP_200_OK)

    def unarchive(self, request, slug, page_id):
        page = self._get_page(slug, page_id)

        # only the owner or admin can un archive the page
        if not self._is_owner_or_admin(request, slug, page):
            return Response(
                {"error": "Only the owner or admin can un archive the page"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # if parent archived then page will be un archived breaking hierarchy
        if page.parent_id and page.parent.archived_at:
            page.parent = None
            page.save(update_fields=["parent"])

        # Restores the page and all its descendants
        unarchive_archive_page_and_descendants(page_id, None)

        return Response(status=status.HTTP_204_NO_CONTENT)

    def destroy(self, request, slug, page_id):
        page = self._get_page(slug, page_id)

        if page.archived_at is None:
            return Response(
                {"error": "The page should be archived before deleting"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not self._is_owner_or_admin(request, slug, page):
            return Response(
                {"error": "Only admin or owner can delete the page"},
                status=status.HTTP_403_FORBIDDEN,
            )

        # remove parent from all the children so they are not cascaded
        _ = Page.objects.filter(parent_id=page_id, workspace__slug=slug).update(parent=None)

        page.delete()
        # Delete the user favorite page
        UserFavorite.objects.filter(
            workspace__slug=slug,
            entity_identifier=page_id,
            entity_type="page",
        ).delete(soft=False)
        # Delete the page from recent visit
        UserRecentVisit.objects.filter(
            project_id__isnull=True,
            workspace__slug=slug,
            entity_identifier=page_id,
            entity_name="page",
        ).delete(soft=False)
        return Response(status=status.HTTP_204_NO_CONTENT)

    def summary(self, request, slug):
        queryset = _visible_wiki_pages(slug, request.user)

        stats = queryset.aggregate(
            public_pages=Count(
                Case(
                    When(access=Page.PUBLIC_ACCESS, archived_at__isnull=True, then=1),
                    output_field=IntegerField(),
                )
            ),
            private_pages=Count(
                Case(
                    When(access=Page.PRIVATE_ACCESS, archived_at__isnull=True, then=1),
                    output_field=IntegerField(),
                )
            ),
            archived_pages=Count(Case(When(archived_at__isnull=False, then=1), output_field=IntegerField())),
        )

        return Response(stats, status=status.HTTP_200_OK)


class WorkspacePagesDescriptionViewSet(BaseViewSet):
    permission_classes = [WorkspacePagePermission]

    def retrieve(self, request, slug, page_id):
        page = _visible_wiki_pages(slug, request.user).get(pk=page_id)
        binary_data = page.description_binary

        def stream_data():
            if binary_data:
                yield binary_data
            else:
                yield b""

        response = StreamingHttpResponse(stream_data(), content_type="application/octet-stream")
        response["Content-Disposition"] = 'attachment; filename="page_description.bin"'
        return response

    def partial_update(self, request, slug, page_id):
        page = _visible_wiki_pages(slug, request.user).get(pk=page_id)

        if page.is_locked:
            return Response(
                {
                    "error_code": ERROR_CODES["PAGE_LOCKED"],
                    "error_message": "PAGE_LOCKED",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if page.archived_at:
            return Response(
                {
                    "error_code": ERROR_CODES["PAGE_ARCHIVED"],
                    "error_message": "PAGE_ARCHIVED",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Store the old description_html before saving (needed for both tasks)
        old_description_html = page.description_html

        # Serialize the existing instance
        existing_instance = json.dumps({"description_html": old_description_html}, cls=DjangoJSONEncoder)

        # Use serializer for validation and update
        serializer = PageBinaryUpdateSerializer(page, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()

            # Capture the page transaction
            if request.data.get("description_html"):
                page_transaction.delay(
                    new_description_html=request.data.get("description_html", "<p></p>"),
                    old_description_html=old_description_html,
                    page_id=page_id,
                )

            # Run background tasks
            track_page_version.delay(
                page_id=page_id,
                existing_instance=existing_instance,
                user_id=request.user.id,
            )
            return Response({"message": "Updated successfully"})
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class WorkspacePageVersionEndpoint(BaseAPIView):
    permission_classes = [WorkspacePagePermission]

    def get(self, request, slug, page_id, pk=None):
        # Scope versions to a wiki page of the URL workspace the user can see
        page = _visible_wiki_pages(slug, request.user).get(pk=page_id)
        page_versions = PageVersion.objects.filter(workspace__slug=slug, page_id=page.id)
        if pk:
            page_version = page_versions.get(pk=pk)
            serializer = PageVersionDetailSerializer(page_version)
            return Response(serializer.data, status=status.HTTP_200_OK)

        serializer = PageVersionSerializer(page_versions, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)


class WorkspacePageDuplicateEndpoint(BaseAPIView):
    permission_classes = [WorkspacePagePermission]

    def post(self, request, slug, page_id):
        page = wiki_pages_queryset(slug).get(pk=page_id)

        # check for permission
        if page.access == Page.PRIVATE_ACCESS and page.owned_by_id != request.user.id:
            return Response({"error": "Permission denied"}, status=status.HTTP_403_FORBIDDEN)

        # The copy keeps parent, sort_order and is_global; no ProjectPage rows
        page.pk = None
        page.name = f"{page.name} (Copy)"
        page.description_binary = None
        page.owned_by = request.user
        page.created_by = request.user
        page.updated_by = request.user
        page.save()

        page_transaction.delay(
            new_description_html=page.description_html,
            old_description_html=None,
            page_id=page.id,
        )

        # Copy the s3 objects uploaded in the page
        copy_s3_objects_of_description_and_assets.delay(
            entity_name="PAGE",
            entity_identifier=page.id,
            project_id=None,
            slug=slug,
            user_id=request.user.id,
        )

        page = annotated_wiki_pages(slug, request.user).get(pk=page.id)
        serializer = WorkspacePageDetailSerializer(page)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
