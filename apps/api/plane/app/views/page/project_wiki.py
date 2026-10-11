# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Project wiki sections: each project can link ONE top-level wiki page as the
root of its section of the workspace wiki
(/api/workspaces/<slug>/projects/<project_id>/wiki/). The section only links
the project to the page; pages keep normal wiki visibility rules.
"""

# Django imports
from django.db import IntegrityError, transaction
from django.db.models import Q

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.wiki_page import ProjectWikiSerializer
from plane.app.views.base import BaseAPIView
from plane.db.models import Page, Project, ProjectWiki


def _live_sections(slug, project_id):
    """Section rows of the project whose root page is still an active wiki page."""
    return ProjectWiki.objects.filter(
        workspace__slug=slug,
        project_id=project_id,
        project__deleted_at__isnull=True,
        root_page__archived_at__isnull=True,
        root_page__deleted_at__isnull=True,
    ).select_related("project", "root_page")


class ProjectWikiEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, project_id):
        # The root page follows wiki visibility: private roots are owner-only
        section = (
            _live_sections(slug, project_id)
            .filter(Q(root_page__access=Page.PUBLIC_ACCESS) | Q(root_page__owned_by=request.user))
            .first()
        )
        if section is None:
            return Response({"error": "Project wiki not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(ProjectWikiSerializer(section).data, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="PROJECT")
    def post(self, request, slug, project_id):
        project = Project.objects.filter(workspace__slug=slug, pk=project_id).first()
        if project is None:
            return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

        if _live_sections(slug, project_id).exists():
            return Response(
                {"error": "This project already has a wiki section"},
                status=status.HTTP_409_CONFLICT,
            )

        try:
            with transaction.atomic():
                # A link whose root page was archived or deleted counts as gone;
                # retire it so the new one satisfies the uniqueness constraint
                ProjectWiki.objects.filter(project_id=project_id).delete()

                root_page = Page.objects.create(
                    workspace_id=project.workspace_id,
                    is_global=True,
                    access=Page.PUBLIC_ACCESS,
                    parent=None,
                    name=project.name,
                    owned_by=request.user,
                    logo_props=project.logo_props or {},
                )
                section = ProjectWiki.objects.create(
                    workspace_id=project.workspace_id,
                    project=project,
                    root_page=root_page,
                )
        except IntegrityError:
            # Concurrent create for the same project
            return Response(
                {"error": "This project already has a wiki section"},
                status=status.HTTP_409_CONFLICT,
            )

        section = _live_sections(slug, project_id).get(pk=section.pk)
        return Response(ProjectWikiSerializer(section).data, status=status.HTTP_201_CREATED)

    @allow_permission([ROLE.ADMIN], level="PROJECT")
    def delete(self, request, slug, project_id):
        # Only the link goes away; the pages stay as ordinary wiki pages
        ProjectWiki.objects.filter(workspace__slug=slug, project_id=project_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
