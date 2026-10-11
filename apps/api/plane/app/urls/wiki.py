# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path


from plane.app.views.page.workspace import (
    WorkspacePageViewSet,
    WorkspacePagesDescriptionViewSet,
    WorkspacePageVersionEndpoint,
    WorkspacePageDuplicateEndpoint,
)
from plane.app.views.page.project_wiki import ProjectWikiEndpoint


urlpatterns = [
    path(
        "workspaces/<str:slug>/wiki/pages-summary/",
        WorkspacePageViewSet.as_view({"get": "summary"}),
        name="wiki-pages-summary",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/",
        WorkspacePageViewSet.as_view({"get": "list", "post": "create"}),
        name="wiki-pages",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/",
        WorkspacePageViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="wiki-pages",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/archive/",
        WorkspacePageViewSet.as_view({"post": "archive", "delete": "unarchive"}),
        name="wiki-page-archive-unarchive",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/lock/",
        WorkspacePageViewSet.as_view({"post": "lock", "delete": "unlock"}),
        name="wiki-page-lock-unlock",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/access/",
        WorkspacePageViewSet.as_view({"post": "access"}),
        name="wiki-page-access",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/description/",
        WorkspacePagesDescriptionViewSet.as_view({"get": "retrieve", "patch": "partial_update"}),
        name="wiki-page-description",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/versions/",
        WorkspacePageVersionEndpoint.as_view(),
        name="wiki-page-versions",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/versions/<uuid:pk>/",
        WorkspacePageVersionEndpoint.as_view(),
        name="wiki-page-versions",
    ),
    path(
        "workspaces/<str:slug>/wiki/pages/<uuid:page_id>/duplicate/",
        WorkspacePageDuplicateEndpoint.as_view(),
        name="wiki-page-duplicate",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/wiki/",
        ProjectWikiEndpoint.as_view(),
        name="project-wiki",
    ),
]
