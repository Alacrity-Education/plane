# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db.models import CharField, Exists, OuterRef, Subquery, UUIDField

# Third party imports
from rest_framework.exceptions import NotFound
from rest_framework.permissions import BasePermission, SAFE_METHODS

# Module imports
from plane.app.permissions.base import ROLE
from plane.db.models import Page, ProjectPage, ProjectWiki, WorkspaceMember


# Permission Mappings for workspace members
ADMIN = ROLE.ADMIN.value
MEMBER = ROLE.MEMBER.value
GUEST = ROLE.GUEST.value


def wiki_pages_queryset(slug):
    """
    Base queryset of workspace wiki pages: global pages of the URL workspace
    that are not linked to any project. Every wiki lookup must go through this
    (never by page id alone) so project pages can't be reached via wiki URLs.
    """
    return (
        Page.objects.filter(workspace__slug=slug, is_global=True)
        .annotate(has_project=Exists(ProjectPage.objects.filter(page_id=OuterRef("pk"))))
        .filter(has_project=False)
    )


def annotate_project_wiki(queryset):
    """
    Annotate wiki pages with the project whose wiki section they are the root
    of (project_wiki_project_id / _identifier / _name, all NULL for ordinary
    pages). Read by project_wiki_data() so serializers avoid an N+1.
    """
    sections = ProjectWiki.objects.filter(root_page_id=OuterRef("pk"), project__deleted_at__isnull=True).order_by()
    return queryset.annotate(
        project_wiki_project_id=Subquery(sections.values("project_id")[:1], output_field=UUIDField()),
        project_wiki_identifier=Subquery(sections.values("project__identifier")[:1], output_field=CharField()),
        project_wiki_name=Subquery(sections.values("project__name")[:1], output_field=CharField()),
    )


def project_wiki_data(page):
    """
    `{"project_id", "identifier", "name"}` of the project whose wiki section
    the page roots, or None. Uses the annotate_project_wiki() annotations when
    present and falls back to a query otherwise.
    """
    if hasattr(page, "project_wiki_project_id"):
        if page.project_wiki_project_id is None:
            return None
        return {
            "project_id": str(page.project_wiki_project_id),
            "identifier": page.project_wiki_identifier,
            "name": page.project_wiki_name,
        }
    section = (
        ProjectWiki.objects.filter(root_page_id=page.pk, project__deleted_at__isnull=True)
        .values("project_id", "project__identifier", "project__name")
        .first()
    )
    if section is None:
        return None
    return {
        "project_id": str(section["project_id"]),
        "identifier": section["project__identifier"],
        "name": section["project__name"],
    }


def get_workspace_role(user, slug):
    return (
        WorkspaceMember.objects.filter(member=user, workspace__slug=slug, is_active=True)
        .values_list("role", flat=True)
        .first()
    )


class WorkspacePagePermission(BasePermission):
    """
    Access control for workspace wiki pages, keyed on the WorkspaceMember role
    (mirrors ProjectPagePermission):
    - SAFE methods: all active workspace members (GUEST is read-only)
    - POST / PUT / PATCH: ADMIN and MEMBER
    - DELETE: ADMIN (the page owner always passes)
    - private pages: owner only (404 for everyone else)
    """

    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False

        slug = view.kwargs.get("slug")
        page_id = view.kwargs.get("page_id")

        role = get_workspace_role(request.user, slug)
        if not role:
            return False

        if page_id:
            # Unknown pages (or project pages) fall through to the role check;
            # the views resolve the page through the same wiki scope and 404.
            page = wiki_pages_queryset(slug).filter(id=page_id).first()
            if page is not None:
                # Allow access if the user is the owner of the page
                if page.owned_by_id == request.user.id:
                    return True

                # Private pages are owner-only and invisible to everyone else
                if page.access == Page.PRIVATE_ACCESS:
                    raise NotFound("Page not found")

        return self._check_workspace_action_access(request, role)

    def _check_workspace_action_access(self, request, role):
        method = request.method

        if method in SAFE_METHODS:
            return role in [ADMIN, MEMBER, GUEST]

        if method in ["POST", "PUT", "PATCH"]:
            return role in [ADMIN, MEMBER]

        if method == "DELETE":
            return role == ADMIN

        # Deny by default
        return False
