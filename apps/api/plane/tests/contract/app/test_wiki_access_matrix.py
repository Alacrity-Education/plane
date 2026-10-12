# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
The workspace wiki access matrix: who sees a page of each access level.

               public(0)  private(1)  admins(2)  members(3)
    admin         yes      owner        yes        yes
    member        yes      owner        owner      yes
    guest         yes      owner        owner      owner

Checked on list, detail, pages-summary and global search; plus the v1 docs
feed (public + published only), publish rejection and unpublish on access
change for the members-only level.
"""

import uuid
from unittest import mock

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import DeployBoard, Page, User, WorkspaceMember

SLUG = "test-workspace"
BASE = f"/api/workspaces/{SLUG}/wiki"
ROLES = {"admin": 20, "member": 15, "guest": 5}
LEVELS = {
    "public": Page.PUBLIC_ACCESS,
    "private": Page.PRIVATE_ACCESS,
    "admins": Page.ADMIN_ACCESS,
    "members": Page.MEMBERS_ACCESS,
}
# role -> levels visible on pages owned by someone else
VISIBLE = {
    "admin": {"public", "admins", "members"},
    "member": {"public", "members"},
    "guest": {"public"},
}


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _member(workspace, role):
    unique = uuid.uuid4().hex[:8]
    user = User.objects.create(email=f"{role}-{unique}@plane.so", username=f"{role}_{unique}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=ROLES[role])
    return user


def _pages(workspace, owner, prefix):
    return {
        level: Page.objects.create(
            workspace=workspace, owned_by=owner, is_global=True, access=access, name=f"{prefix} matrix {level}"
        )
        for level, access in LEVELS.items()
    }


def _search_ids(client, query):
    response = client.get(f"/api/workspaces/{SLUG}/search/", {"search": query, "entities": "page"})
    assert response.status_code == status.HTTP_200_OK
    return {item["id"] for item in response.json()["results"]["page"]}


@pytest.fixture(autouse=True)
def mock_tasks():
    module = "plane.app.views.page.workspace"
    with (
        mock.patch(f"{module}.page_transaction"),
        mock.patch(f"{module}.track_page_version"),
        mock.patch(f"{module}.recent_visited_task"),
    ):
        yield


@pytest.mark.contract
class TestWikiAccessMatrix:
    @pytest.mark.django_db
    @pytest.mark.parametrize("role", ["admin", "member", "guest"])
    def test_pages_of_others(self, workspace, create_user, role):
        pages = _pages(workspace, create_user, "Others")
        client = _client_for(_member(workspace, role))

        listed = {item["id"] for item in client.get(f"{BASE}/pages/").json()}
        found = _search_ids(client, "Others matrix")
        for level, page in pages.items():
            visible = level in VISIBLE[role]
            assert (str(page.id) in listed) is visible, (role, level)
            assert (str(page.id) in found) is visible, (role, level)
            expected = status.HTTP_200_OK if visible else status.HTTP_404_NOT_FOUND
            assert client.get(f"{BASE}/pages/{page.id}/").status_code == expected, (role, level)

        summary = client.get(f"{BASE}/pages-summary/").json()
        assert summary["public_pages"] == 1
        assert summary["private_pages"] == 0
        assert summary["admin_pages"] == (1 if role == "admin" else 0)
        assert summary["members_pages"] == (1 if role in ("admin", "member") else 0)

    @pytest.mark.django_db
    @pytest.mark.parametrize("role", ["admin", "member", "guest"])
    def test_owner_sees_all_own_pages(self, workspace, role):
        owner = _member(workspace, role)
        pages = _pages(workspace, owner, "Own")
        client = _client_for(owner)

        listed = {item["id"] for item in client.get(f"{BASE}/pages/").json()}
        assert {str(page.id) for page in pages.values()} <= listed
        for page in pages.values():
            assert client.get(f"{BASE}/pages/{page.id}/").status_code == status.HTTP_200_OK
        summary = client.get(f"{BASE}/pages-summary/").json()
        assert (summary["public_pages"], summary["private_pages"]) == (1, 1)
        assert (summary["admin_pages"], summary["members_pages"]) == (1, 1)

    @pytest.mark.django_db
    def test_type_filter_members(self, session_client, workspace, create_user):
        pages = _pages(workspace, create_user, "Tab")
        response = session_client.get(f"{BASE}/pages/", {"type": "members"})
        assert {item["id"] for item in response.json()} == {str(pages["members"].id)}

    @pytest.mark.django_db
    def test_v1_feed_only_public_published(self, workspace, create_user, api_token):
        pages = _pages(workspace, create_user, "Feed")
        # Stale publish rows on every page: only the public one is exported
        for page in pages.values():
            DeployBoard.objects.create(entity_name="page", entity_identifier=page.id, workspace=workspace)
        feed = APIClient()
        feed.credentials(HTTP_X_API_KEY=api_token.token)

        ids = {item["id"] for item in feed.get(f"/api/v1/workspaces/{SLUG}/wiki/pages/").json()["results"]}
        assert {str(page.id) for page in pages.values()} & ids == {str(pages["public"].id)}

    @pytest.mark.django_db
    @pytest.mark.parametrize("level", ["private", "admins", "members"])
    def test_publish_rejected_for_non_public(self, session_client, workspace, create_user, level):
        page = _pages(workspace, create_user, "Pub")[level]
        assert session_client.post(f"{BASE}/pages/{page.id}/publish/").status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    @pytest.mark.parametrize("level", ["private", "admins", "members"])
    def test_access_change_unpublishes(self, session_client, workspace, create_user, level):
        page = _pages(workspace, create_user, "Unpub")["public"]
        DeployBoard.objects.create(entity_name="page", entity_identifier=page.id, workspace=workspace)

        response = session_client.post(f"{BASE}/pages/{page.id}/access/", {"access": LEVELS[level]}, format="json")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not DeployBoard.objects.filter(entity_name="page", entity_identifier=page.id).exists()

    @pytest.mark.django_db
    def test_member_owner_sets_members_only_guest_owner_cannot(self, workspace):
        member, guest = _member(workspace, "member"), _member(workspace, "guest")
        own = Page.objects.create(workspace=workspace, owned_by=member, is_global=True, name="m")
        guest_own = Page.objects.create(workspace=workspace, owned_by=guest, is_global=True, name="g")

        response = _client_for(member).patch(f"{BASE}/pages/{own.id}/", {"access": 3}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["access"] == Page.MEMBERS_ACCESS
        response = _client_for(guest).post(f"{BASE}/pages/{guest_own.id}/access/", {"access": 3}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_admin_moves_others_page_between_shared_levels(self, session_client, workspace):
        member = _member(workspace, "member")
        page = Page.objects.create(workspace=workspace, owned_by=member, is_global=True, name="p")
        for access in (Page.MEMBERS_ACCESS, Page.ADMIN_ACCESS, Page.PUBLIC_ACCESS):
            response = session_client.post(f"{BASE}/pages/{page.id}/access/", {"access": access}, format="json")
            assert response.status_code == status.HTTP_204_NO_CONTENT

    @pytest.mark.django_db
    def test_project_pages_reject_members_only(self, session_client, workspace, create_user):
        from plane.db.models import Project, ProjectMember, ProjectPage

        project = Project.objects.create(name="Project", identifier="PRJ", workspace=workspace)
        ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
        page = Page.objects.create(workspace=workspace, owned_by=create_user, name="P")
        ProjectPage.objects.create(workspace=workspace, project=project, page=page)
        base = f"/api/workspaces/{SLUG}/projects/{project.id}/pages/"

        assert (
            session_client.post(f"{base}{page.id}/access/", {"access": 3}, format="json").status_code
            == status.HTTP_400_BAD_REQUEST
        )
        with mock.patch("plane.app.views.page.base.page_transaction"):
            response = session_client.patch(f"{base}{page.id}/", {"access": 3}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
