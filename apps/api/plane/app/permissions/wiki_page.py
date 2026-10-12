# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db.models import CharField, Exists, OuterRef, Q, Subquery, UUIDField

# Third party imports
from rest_framework.exceptions import NotFound
from rest_framework.permissions import BasePermission, SAFE_METHODS

# Module imports
from plane.app.permissions.base import ROLE
from plane.db.models import DeployBoard, Page, ProjectPage, ProjectWiki, WorkspaceMember


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


# Wiki page visibility
#
# Access is evaluated per page, never inherited from the parent:
# - PUBLIC_ACCESS (0): every active workspace member (admin, member, guest)
# - PRIVATE_ACCESS (1): the owner only (workspace admins included)
# - ADMIN_ACCESS (2): workspace admins and the owner
# A page under a hidden page is reachable only if its own access allows it;
# clients show it at the top of the tree (like children of private pages).


def wiki_access_levels(role):
    """Access levels a workspace member with `role` sees on pages they don't own."""
    if role == ADMIN:
        return (Page.PUBLIC_ACCESS, Page.ADMIN_ACCESS)
    return (Page.PUBLIC_ACCESS,)


def wiki_page_visibility_q(user, role, prefix=""):
    """
    Q for wiki pages visible to `user` with workspace `role`; `prefix` targets
    a relation (e.g. "child_page__"). The single source of the visibility rule.
    """
    return Q(**{f"{prefix}access__in": wiki_access_levels(role)}) | Q(**{f"{prefix}owned_by_id": user.id})


def visible_wiki_pages_queryset(slug, user, role=None):
    """
    Wiki pages of the workspace `user` may see (archived pages included);
    empty for anyone who is not an active member. `role` skips the lookup.
    """
    if role is None:
        role = get_workspace_role(user, slug)
    if not role:
        return wiki_pages_queryset(slug).none()
    return wiki_pages_queryset(slug).filter(wiki_page_visibility_q(user, role))


def hidden_wiki_page_ids(slug, user, role=None):
    """Ids of the workspace's wiki pages `user` may not see (for excluding favorites, recents)."""
    if role is None:
        role = get_workspace_role(user, slug)
    return wiki_pages_queryset(slug).exclude(wiki_page_visibility_q(user, role)).values("id")


def can_view_wiki_page(page, user, role):
    return page.owned_by_id == user.id or page.access in wiki_access_levels(role)


def can_change_wiki_page_access(page, user, role, access):
    """
    The owner (admin or member) may set any access; a workspace admin may
    toggle other users' pages between public and admins-only. Guests never.
    """
    if access == page.access:
        return True
    if role not in (ADMIN, MEMBER):
        return False
    if page.owned_by_id == user.id:
        return True
    admin_levels = {Page.PUBLIC_ACCESS, Page.ADMIN_ACCESS}
    return role == ADMIN and page.access in admin_levels and access in admin_levels


def published_pages_queryset():
    """
    Live DeployBoard rows marking wiki pages as published to the docs site.
    A wiki page is published when a non-deleted
    DeployBoard(entity_name="page", entity_identifier=page.id) of its
    workspace exists.
    """
    return DeployBoard.objects.filter(entity_name="page")


def annotate_is_published(queryset):
    """Annotate pages with `is_published` (one Exists subquery, no N+1)."""
    return queryset.annotate(
        is_published=Exists(
            published_pages_queryset().filter(
                entity_identifier=OuterRef("pk"),
                workspace_id=OuterRef("workspace_id"),
            )
        )
    )


def unpublish_wiki_pages(page_ids, workspace_id):
    """Soft-delete the publish rows of the given pages (no-op when absent)."""
    return published_pages_queryset().filter(workspace_id=workspace_id, entity_identifier__in=page_ids).delete()


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
    - private pages: owner only; admins-only pages: owner and workspace
      admins (404 for everyone else)
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

                # Private / admins-only pages are invisible to everyone else
                if not can_view_wiki_page(page, request.user, role):
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


class WorkspacePagePublishPermission(BasePermission):
    """
    Publishing a wiki page to the docs site (POST) and unpublishing it
    (DELETE): workspace ADMIN and MEMBER only. Guests are refused even on
    pages they own; pages the user can't see stay invisible (404).
    """

    def has_permission(self, request, view):
        if request.user.is_anonymous:
            return False

        slug = view.kwargs.get("slug")
        role = get_workspace_role(request.user, slug)
        if role not in [ADMIN, MEMBER]:
            return False

        page = wiki_pages_queryset(slug).filter(id=view.kwargs.get("page_id")).first()
        if page is not None and not can_view_wiki_page(page, request.user, role):
            raise NotFound("Page not found")
        return True
