# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Contract tests for the admins-only access level of workspace wiki pages
(Page.ADMIN_ACCESS): visible to workspace admins and the page owner only,
everywhere a wiki page can surface (list, detail, tree counts, summary,
search, favorites, recents, project wiki sections, the v1 docs feed), never
published, and rejected by the project page endpoints.
"""

import uuid
from unittest import mock

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    DeployBoard,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    ProjectWiki,
    User,
    UserFavorite,
    UserRecentVisit,
    WorkspaceMember,
)

SLUG = "test-workspace"
BASE = f"/api/workspaces/{SLUG}/wiki"
ADMIN, MEMBER, GUEST = 20, 15, 5


def _pages_url(page_id=None, suffix=""):
    if page_id is None:
        return f"{BASE}/pages/"
    return f"{BASE}/pages/{page_id}/{suffix}"


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _member(workspace, role, prefix="member"):
    unique = uuid.uuid4().hex[:8]
    user = User.objects.create(email=f"{prefix}-{unique}@plane.so", username=f"{prefix}_{unique}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


def _wiki_page(workspace, owner, **kwargs):
    kwargs.setdefault("name", "Wiki page")
    kwargs.setdefault("access", Page.PUBLIC_ACCESS)
    return Page.objects.create(workspace=workspace, owned_by=owner, is_global=True, **kwargs)


def _admin_page(workspace, owner, **kwargs):
    return _wiki_page(workspace, owner, access=Page.ADMIN_ACCESS, **kwargs)


def _publish_row(page):
    return DeployBoard.objects.create(entity_name="page", entity_identifier=page.id, workspace=page.workspace)


def _is_published(page):
    return DeployBoard.objects.filter(entity_name="page", entity_identifier=page.id).exists()


def _ids(response):
    assert response.status_code == status.HTTP_200_OK
    return {item["id"] for item in response.json()}


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
def member(workspace):
    return _member(workspace, MEMBER, "member")


@pytest.fixture
def guest(workspace):
    return _member(workspace, GUEST, "guest")


@pytest.fixture
def admin2(workspace):
    return _member(workspace, ADMIN, "admin")


@pytest.mark.contract
class TestAdminsOnlyVisibility:
    @pytest.mark.django_db
    def test_admin_sees_member_does_not(self, session_client, workspace, create_user, member, admin2):
        page = _admin_page(workspace, create_user, name="Board minutes")

        assert str(page.id) in _ids(session_client.get(_pages_url()))
        assert str(page.id) in _ids(_client_for(admin2).get(_pages_url()))
        assert _client_for(admin2).get(_pages_url(page.id)).status_code == status.HTTP_200_OK

        member_client = _client_for(member)
        assert str(page.id) not in _ids(member_client.get(_pages_url()))
        assert member_client.get(_pages_url(page.id)).status_code == status.HTTP_404_NOT_FOUND
        assert member_client.get(_pages_url(page.id, "description/")).status_code == status.HTTP_404_NOT_FOUND
        assert member_client.get(_pages_url(page.id, "versions/")).status_code == status.HTTP_404_NOT_FOUND
        assert (
            member_client.patch(_pages_url(page.id), {"name": "x"}, format="json").status_code
            == status.HTTP_404_NOT_FOUND
        )
        assert member_client.post(_pages_url(page.id, "duplicate/")).status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_guest_does_not_see(self, workspace, create_user, guest):
        page = _admin_page(workspace, create_user)
        guest_client = _client_for(guest)

        assert str(page.id) not in _ids(guest_client.get(_pages_url()))
        assert guest_client.get(_pages_url(page.id)).status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_member_owner_sees_own_admins_only_page(self, workspace, member):
        member_client = _client_for(member)
        created = member_client.post(_pages_url(), {"name": "Mine", "access": Page.ADMIN_ACCESS}, format="json")
        assert created.status_code == status.HTTP_201_CREATED
        assert created.json()["access"] == Page.ADMIN_ACCESS

        page_id = created.json()["id"]
        assert page_id in _ids(member_client.get(_pages_url()))
        assert member_client.get(_pages_url(page_id)).status_code == status.HTTP_200_OK

    @pytest.mark.django_db
    def test_admins_do_not_see_others_private_pages(self, session_client, workspace, member):
        page = _wiki_page(workspace, member, access=Page.PRIVATE_ACCESS)

        assert str(page.id) not in _ids(session_client.get(_pages_url()))
        assert session_client.get(_pages_url(page.id)).status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_type_filter_and_children_counts(self, session_client, workspace, create_user, member):
        parent = _wiki_page(workspace, create_user, name="Parent")
        hidden_child = _admin_page(workspace, create_user, parent=parent)
        public_child = _wiki_page(workspace, create_user, parent=parent)

        assert _ids(session_client.get(_pages_url(), {"type": "admins"})) == {str(hidden_child.id)}
        assert _ids(_client_for(member).get(_pages_url(), {"type": "admins"})) == set()

        def count(client):
            return next(p for p in client.get(_pages_url()).json() if p["id"] == str(parent.id))["sub_pages_count"]

        assert count(session_client) == 2
        assert count(_client_for(member)) == 1
        assert _ids(_client_for(member).get(_pages_url(), {"parent": str(parent.id)})) == {str(public_child.id)}

    @pytest.mark.django_db
    def test_child_of_admins_only_page_follows_its_own_access(self, workspace, create_user, member):
        parent = _admin_page(workspace, create_user)
        child = _wiki_page(workspace, create_user, parent=parent)

        member_client = _client_for(member)
        assert str(child.id) in _ids(member_client.get(_pages_url()))
        assert str(parent.id) not in _ids(member_client.get(_pages_url()))
        # ...but a member can't nest new pages under the hidden parent
        response = member_client.post(_pages_url(), {"name": "x", "parent": str(parent.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_summary_counts(self, session_client, workspace, create_user, member):
        _wiki_page(workspace, create_user)
        _admin_page(workspace, create_user)
        _admin_page(workspace, create_user)
        _admin_page(workspace, member)

        admin_stats = session_client.get(f"{BASE}/pages-summary/").json()
        assert admin_stats["public_pages"] == 1
        assert admin_stats["admin_pages"] == 3
        assert admin_stats["private_pages"] == 0

        member_stats = _client_for(member).get(f"{BASE}/pages-summary/").json()
        assert member_stats["public_pages"] == 1
        assert member_stats["admin_pages"] == 1

    @pytest.mark.django_db
    def test_favorites_and_recents_hide_page_from_member(self, workspace, create_user, member):
        page = _admin_page(workspace, create_user, name="Hidden fav")
        UserFavorite.objects.create(user=member, workspace=workspace, entity_type="page", entity_identifier=page.id)
        UserRecentVisit.objects.create(user=member, workspace=workspace, entity_name="page", entity_identifier=page.id)
        member_client = _client_for(member)

        favorites = member_client.get(f"/api/workspaces/{SLUG}/user-favorites/").json()
        assert str(page.id) not in {item["entity_identifier"] for item in favorites}
        recents = member_client.get(f"/api/workspaces/{SLUG}/recent-visits/").json()
        assert str(page.id) not in {item["entity_identifier"] for item in recents}

        page.access = Page.PUBLIC_ACCESS
        page.save()
        favorites = member_client.get(f"/api/workspaces/{SLUG}/user-favorites/").json()
        assert str(page.id) in {item["entity_identifier"] for item in favorites}

    @pytest.mark.django_db
    def test_project_wiki_section_follows_root_access(self, session_client, workspace, create_user, member):
        project = Project.objects.create(name="Project", identifier="PRJ", workspace=workspace)
        root = _admin_page(workspace, create_user, name="Project")
        ProjectWiki.objects.create(workspace=workspace, project=project, root_page=root)
        url = f"/api/workspaces/{SLUG}/projects/{project.id}/wiki/"

        assert session_client.get(url).status_code == status.HTTP_200_OK
        assert _client_for(member).get(url).status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestAdminsOnlySearch:
    @pytest.mark.django_db
    def test_global_and_entity_search(self, session_client, workspace, create_user, member):
        page = _admin_page(workspace, create_user, name="Quarterly board pack")

        def global_ids(client):
            response = client.get(f"/api/workspaces/{SLUG}/search/", {"search": "board pack", "entities": "page"})
            assert response.status_code == status.HTTP_200_OK
            return {item["id"] for item in response.json()["results"]["page"]}

        def entity_ids(client):
            response = client.get(
                f"/api/workspaces/{SLUG}/entity-search/", {"query": "board pack", "query_type": "page"}
            )
            assert response.status_code == status.HTTP_200_OK
            return {item["id"] for item in response.json()["page"]}

        assert global_ids(session_client) == {str(page.id)}
        assert global_ids(_client_for(member)) == set()
        assert str(page.id) not in entity_ids(_client_for(member))


@pytest.mark.contract
class TestAdminsOnlyAccessChanges:
    @pytest.mark.django_db
    def test_owner_member_sets_admins_only_via_access_endpoint(self, workspace, member):
        page = _wiki_page(workspace, member)
        response = _client_for(member).post(_pages_url(page.id, "access/"), {"access": 2}, format="json")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        page.refresh_from_db()
        assert page.access == Page.ADMIN_ACCESS

    @pytest.mark.django_db
    def test_admin_toggles_others_page_between_public_and_admins_only(self, session_client, workspace, member):
        page = _wiki_page(workspace, member)

        response = session_client.patch(_pages_url(page.id), {"access": Page.ADMIN_ACCESS}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["access"] == Page.ADMIN_ACCESS

        response = session_client.post(_pages_url(page.id, "access/"), {"access": Page.PUBLIC_ACCESS}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT

        # ...but can't make someone else's page private
        response = session_client.post(_pages_url(page.id, "access/"), {"access": Page.PRIVATE_ACCESS}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_member_cannot_set_others_page_admins_only(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user)
        member_client = _client_for(member)

        assert (
            member_client.post(_pages_url(page.id, "access/"), {"access": 2}, format="json").status_code
            == status.HTTP_403_FORBIDDEN
        )
        assert (
            member_client.patch(_pages_url(page.id), {"access": 2}, format="json").status_code
            == status.HTTP_403_FORBIDDEN
        )
        page.refresh_from_db()
        assert page.access == Page.PUBLIC_ACCESS

    @pytest.mark.django_db
    def test_invalid_access_rejected(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user)

        assert (
            session_client.post(_pages_url(page.id, "access/"), {"access": 9}, format="json").status_code
            == status.HTTP_400_BAD_REQUEST
        )
        assert (
            session_client.patch(_pages_url(page.id), {"access": 9}, format="json").status_code
            == status.HTTP_400_BAD_REQUEST
        )
        assert (
            session_client.post(_pages_url(), {"name": "x", "access": 9}, format="json").status_code
            == status.HTTP_400_BAD_REQUEST
        )

    @pytest.mark.django_db
    @pytest.mark.parametrize("via", ["access", "patch"])
    def test_admins_only_unpublishes(self, session_client, workspace, create_user, via):
        page = _wiki_page(workspace, create_user)
        _publish_row(page)

        if via == "access":
            response = session_client.post(_pages_url(page.id, "access/"), {"access": 2}, format="json")
        else:
            response = session_client.patch(_pages_url(page.id), {"access": 2}, format="json")

        assert response.status_code in (status.HTTP_200_OK, status.HTTP_204_NO_CONTENT)
        assert not _is_published(page)

    @pytest.mark.django_db
    def test_publish_rejected(self, session_client, workspace, create_user, member):
        page = _admin_page(workspace, create_user)

        response = session_client.post(_pages_url(page.id, "publish/"))
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert not _is_published(page)

        # Members don't even learn the page exists
        assert _client_for(member).post(_pages_url(page.id, "publish/")).status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestAdminsOnlyV1Feed:
    @pytest.mark.django_db
    def test_feed_never_includes_admins_only_pages(self, workspace, create_user, api_token):
        page = _admin_page(workspace, create_user, name="Board")
        # Even a stale publish row doesn't expose it
        _publish_row(page)
        feed = APIClient()
        feed.credentials(HTTP_X_API_KEY=api_token.token)
        feed_url = f"/api/v1/workspaces/{SLUG}/wiki/pages/"

        assert str(page.id) not in {item["id"] for item in feed.get(feed_url).json()["results"]}
        assert feed.get(f"{feed_url}{page.id}/").status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestProjectPagesRejectAdminsOnly:
    @pytest.fixture
    def project(self, workspace, create_user):
        project = Project.objects.create(name="Project", identifier="PRJ", workspace=workspace)
        ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=ADMIN)
        return project

    @pytest.mark.django_db
    def test_project_page_endpoints_reject_access_2(self, session_client, workspace, create_user, project):
        base = f"/api/workspaces/{SLUG}/projects/{project.id}/pages/"
        page = Page.objects.create(workspace=workspace, owned_by=create_user, access=Page.PUBLIC_ACCESS, name="P")
        ProjectPage.objects.create(workspace=workspace, project=project, page=page)

        with mock.patch("plane.app.views.page.base.page_transaction"):
            created = session_client.post(base, {"name": "x", "access": 2}, format="json")
            patched = session_client.patch(f"{base}{page.id}/", {"access": 2}, format="json")
        assert created.status_code == status.HTTP_400_BAD_REQUEST
        assert patched.status_code == status.HTTP_400_BAD_REQUEST

        response = session_client.post(f"{base}{page.id}/access/", {"access": 2}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        page.refresh_from_db()
        assert page.access == Page.PUBLIC_ACCESS

        # The two project access levels keep working
        response = session_client.post(f"{base}{page.id}/access/", {"access": 1}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT
