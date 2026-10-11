# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Contract tests for project wiki sections
(/api/workspaces/<slug>/projects/<project_id>/wiki/): a project links one
top-level wiki page as the root of its section of the workspace wiki.
"""

import uuid
from unittest import mock

import pytest
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import Page, Project, ProjectMember, ProjectPage, ProjectWiki, User, WorkspaceMember

SLUG = "test-workspace"
WIKI_PAGES = f"/api/workspaces/{SLUG}/wiki/pages/"
SECTION_FIELDS = {"id", "project", "project_identifier", "project_name", "root_page", "root_page_name", "created_at"}


def _section_url(project_id):
    return f"/api/workspaces/{SLUG}/projects/{project_id}/wiki/"


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _make_user(prefix):
    unique = uuid.uuid4().hex[:8]
    return User.objects.create(email=f"{prefix}-{unique}@plane.so", username=f"{prefix}_{unique}")


def _workspace_member(workspace, role, prefix):
    user = _make_user(prefix)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


@pytest.fixture(autouse=True)
def mock_tasks():
    module = "plane.app.views.page.workspace"
    with (
        mock.patch(f"{module}.page_transaction"),
        mock.patch(f"{module}.track_page_version"),
        mock.patch(f"{module}.recent_visited_task"),
        mock.patch(f"{module}.copy_s3_objects_of_description_and_assets"),
    ):
        yield


@pytest.fixture
def project(workspace, create_user):
    project = Project.objects.create(
        name="Apollo", identifier="APO", workspace=workspace, logo_props={"in_use": "emoji", "emoji": {"value": "1"}}
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    return project


@pytest.fixture
def project_member(workspace, project):
    user = _workspace_member(workspace, 15, "pmember")
    ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=15)
    return user


@pytest.fixture
def guest(workspace):
    return _workspace_member(workspace, 5, "guest")


def _create_section(client, project):
    response = client.post(_section_url(project.id), format="json")
    assert response.status_code == status.HTTP_201_CREATED, response.content
    return response.json()


@pytest.mark.contract
class TestProjectWikiSection:
    @pytest.mark.django_db
    def test_create_makes_global_root_page(self, session_client, workspace, create_user, project):
        data = _create_section(session_client, project)

        assert set(data.keys()) == SECTION_FIELDS
        assert data["project"] == str(project.id)
        assert data["project_identifier"] == "APO"
        assert data["project_name"] == "Apollo"
        assert data["root_page_name"] == "Apollo"
        root = Page.objects.get(pk=data["root_page"])
        assert root.is_global is True
        assert root.parent_id is None
        assert root.access == Page.PUBLIC_ACCESS
        assert root.owned_by_id == create_user.id
        assert root.workspace_id == workspace.id
        assert root.logo_props == project.logo_props
        assert not ProjectPage.all_objects.filter(page=root).exists()
        assert ProjectWiki.objects.filter(project=project, root_page=root).count() == 1

    @pytest.mark.django_db
    def test_second_create_conflicts(self, session_client, project):
        _create_section(session_client, project)

        response = session_client.post(_section_url(project.id), format="json")

        assert response.status_code == status.HTTP_409_CONFLICT
        assert ProjectWiki.objects.filter(project=project).count() == 1

    @pytest.mark.django_db
    def test_project_member_can_create(self, project, project_member):
        data = _create_section(_client_for(project_member), project)

        assert Page.objects.get(pk=data["root_page"]).owned_by_id == project_member.id

    @pytest.mark.django_db
    def test_non_project_member_cannot_create(self, workspace, project):
        outsider = _workspace_member(workspace, 15, "noproj")

        response = _client_for(outsider).post(_section_url(project.id), format="json")

        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert not ProjectWiki.objects.filter(project=project).exists()

    @pytest.mark.django_db
    def test_guest_can_read(self, session_client, project, guest):
        data = _create_section(session_client, project)

        response = _client_for(guest).get(_section_url(project.id))

        assert response.status_code == status.HTTP_200_OK
        assert response.json() == data
        assert _client_for(guest).post(_section_url(project.id)).status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_get_without_section_is_404(self, session_client, project):
        assert session_client.get(_section_url(project.id)).status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_non_workspace_member_forbidden(self, session_client, project):
        _create_section(session_client, project)

        response = _client_for(_make_user("outsider")).get(_section_url(project.id))

        assert response.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_delete_removes_link_only(self, session_client, project, project_member):
        data = _create_section(session_client, project)

        assert _client_for(project_member).delete(_section_url(project.id)).status_code == status.HTTP_403_FORBIDDEN
        response = session_client.delete(_section_url(project.id))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert session_client.get(_section_url(project.id)).status_code == status.HTTP_404_NOT_FOUND
        pages = {item["id"]: item for item in session_client.get(WIKI_PAGES).json()}
        assert data["root_page"] in pages
        assert pages[data["root_page"]]["project_wiki"] is None
        # A new section can be created after unlinking
        assert session_client.post(_section_url(project.id)).status_code == status.HTTP_201_CREATED

    @pytest.mark.django_db
    def test_archived_root_hides_section(self, session_client, project):
        data = _create_section(session_client, project)
        Page.objects.filter(pk=data["root_page"]).update(archived_at=timezone.now())

        assert session_client.get(_section_url(project.id)).status_code == status.HTTP_404_NOT_FOUND
        # The stale link does not block a new section
        new = _create_section(session_client, project)
        assert new["root_page"] != data["root_page"]

    @pytest.mark.django_db
    def test_deleted_root_hides_section(self, session_client, project):
        data = _create_section(session_client, project)
        Page.objects.filter(pk=data["root_page"]).update(deleted_at=timezone.now())

        assert session_client.get(_section_url(project.id)).status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_private_root_hidden_from_others(self, session_client, project, guest):
        data = _create_section(session_client, project)
        Page.objects.filter(pk=data["root_page"]).update(access=Page.PRIVATE_ACCESS)

        assert session_client.get(_section_url(project.id)).status_code == status.HTTP_200_OK
        assert _client_for(guest).get(_section_url(project.id)).status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestProjectWikiOnWikiPages:
    @pytest.mark.django_db
    def test_root_cannot_be_moved(self, session_client, workspace, create_user, project):
        data = _create_section(session_client, project)
        other = Page.objects.create(workspace=workspace, owned_by=create_user, is_global=True, name="Other")

        response = session_client.patch(f"{WIKI_PAGES}{data['root_page']}/", {"parent": str(other.id)}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "project wiki root cannot be moved" in str(response.json())
        assert Page.objects.get(pk=data["root_page"]).parent_id is None
        # Other edits on the root still work, and pages can go under the root
        assert (
            session_client.patch(f"{WIKI_PAGES}{data['root_page']}/", {"name": "Renamed"}, format="json").status_code
            == status.HTTP_200_OK
        )
        moved = session_client.patch(f"{WIKI_PAGES}{other.id}/", {"parent": data["root_page"]}, format="json")
        assert moved.status_code == status.HTTP_200_OK

    @pytest.mark.django_db
    def test_list_and_detail_expose_project_wiki(self, session_client, workspace, create_user, project):
        data = _create_section(session_client, project)
        child = Page.objects.create(
            workspace=workspace, owned_by=create_user, is_global=True, name="Child", parent_id=data["root_page"]
        )
        expected = {"project_id": str(project.id), "identifier": "APO", "name": "Apollo"}

        response = session_client.get(WIKI_PAGES)

        assert response.status_code == status.HTTP_200_OK
        by_id = {item["id"]: item for item in response.json()}
        assert by_id[data["root_page"]]["project_wiki"] == expected
        assert by_id[str(child.id)]["project_wiki"] is None
        assert session_client.get(f"{WIKI_PAGES}{data['root_page']}/").json()["project_wiki"] == expected
        assert session_client.get(f"{WIKI_PAGES}{child.id}/").json()["project_wiki"] is None
