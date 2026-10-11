# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Contract tests for the workspace wiki session API (/api/workspaces/<slug>/wiki/).

A wiki page is a project-less Page(is_global=True). These tests pin the role
matrix (ADMIN / MEMBER / GUEST via WorkspaceMember), the isolation from project
pages in both directions, nesting rules and the description / versions /
archive / delete / favourite flows.
"""

import base64
import uuid
from unittest import mock

import pytest
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    Page,
    PageVersion,
    Project,
    ProjectMember,
    ProjectPage,
    User,
    UserFavorite,
    UserRecentVisit,
    WorkspaceMember,
)

SLUG = "test-workspace"
BASE = f"/api/workspaces/{SLUG}/wiki"

LIST_FIELDS = {
    "id",
    "name",
    "owned_by",
    "access",
    "color",
    "parent",
    "is_favorite",
    "is_locked",
    "archived_at",
    "workspace",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "view_props",
    "logo_props",
    "label_ids",
    "project_ids",
    "sort_order",
    "is_global",
    "sub_pages_count",
    "is_published",
}


def _pages_url(page_id=None, suffix=""):
    if page_id is None:
        return f"{BASE}/pages/"
    return f"{BASE}/pages/{page_id}/{suffix}"


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _make_user(prefix):
    unique = uuid.uuid4().hex[:8]
    return User.objects.create(email=f"{prefix}-{unique}@plane.so", username=f"{prefix}_{unique}")


def _member(workspace, role, prefix="member"):
    user = _make_user(prefix)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


def _wiki_page(workspace, owner, **kwargs):
    kwargs.setdefault("name", "Wiki page")
    kwargs.setdefault("access", Page.PUBLIC_ACCESS)
    return Page.objects.create(workspace=workspace, owned_by=owner, is_global=True, **kwargs)


def _project_page(workspace, owner, project, is_global=False):
    page = Page.objects.create(
        workspace=workspace, owned_by=owner, access=Page.PUBLIC_ACCESS, name="Project page", is_global=is_global
    )
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)
    return page


def _ids(response):
    return {item["id"] for item in response.json()}


@pytest.fixture(autouse=True)
def mock_tasks():
    """Keep the background tasks out of the request cycle (and assertable)."""
    module = "plane.app.views.page.workspace"
    with (
        mock.patch(f"{module}.page_transaction") as page_transaction,
        mock.patch(f"{module}.track_page_version") as track_page_version,
        mock.patch(f"{module}.recent_visited_task") as recent_visited_task,
        mock.patch(f"{module}.copy_s3_objects_of_description_and_assets") as copy_s3,
    ):
        yield {
            "page_transaction": page_transaction,
            "track_page_version": track_page_version,
            "recent_visited_task": recent_visited_task,
            "copy_s3": copy_s3,
        }


@pytest.fixture
def project(workspace, create_user):
    project = Project.objects.create(name="Project", identifier="PRJ", workspace=workspace)
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    return project


@pytest.fixture
def member(workspace):
    return _member(workspace, 15, "member")


@pytest.fixture
def guest(workspace):
    return _member(workspace, 5, "guest")


@pytest.mark.contract
class TestWikiPageRoles:
    @pytest.mark.django_db
    def test_admin_create_is_global_without_project_link(self, session_client, workspace, create_user, mock_tasks):
        response = session_client.post(_pages_url(), {"name": "Handbook"}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert set(data.keys()) == LIST_FIELDS | {"description_html"}
        assert data["is_global"] is True
        assert data["project_ids"] == []
        assert data["label_ids"] == []
        assert data["parent"] is None
        assert data["sub_pages_count"] == 0
        assert data["is_favorite"] is False
        assert data["owned_by"] == str(create_user.id)
        page = Page.objects.get(pk=data["id"])
        assert page.is_global is True
        assert page.workspace_id == workspace.id
        assert not ProjectPage.all_objects.filter(page=page).exists()
        mock_tasks["page_transaction"].delay.assert_called_once()

    @pytest.mark.django_db
    def test_member_create(self, workspace, member):
        response = _client_for(member).post(_pages_url(), {"name": "Mine", "access": 1}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert response.json()["access"] == 1
        assert Page.objects.get(pk=response.json()["id"]).owned_by_id == member.id

    @pytest.mark.django_db
    def test_create_sanitizes_description_html(self, session_client, workspace):
        response = session_client.post(
            _pages_url(),
            {"name": "x", "description_html": "<p>ok</p><script>alert(1)</script>"},
            format="json",
        )

        assert response.status_code == status.HTTP_201_CREATED
        assert "<script>" not in Page.objects.get(pk=response.json()["id"]).description_html

    @pytest.mark.django_db
    def test_guest_is_read_only(self, workspace, create_user, guest):
        public = _wiki_page(workspace, create_user)
        private = _wiki_page(workspace, create_user, access=Page.PRIVATE_ACCESS)
        client = _client_for(guest)

        assert client.post(_pages_url(), {"name": "nope"}, format="json").status_code == status.HTTP_403_FORBIDDEN
        assert client.get(_pages_url(public.id)).status_code == status.HTTP_200_OK
        assert _ids(client.get(_pages_url())) == {str(public.id)}
        assert client.get(_pages_url(private.id)).status_code == status.HTTP_404_NOT_FOUND
        assert (
            client.patch(_pages_url(public.id), {"name": "x"}, format="json").status_code == status.HTTP_403_FORBIDDEN
        )
        assert client.post(_pages_url(public.id, "lock/")).status_code == status.HTTP_403_FORBIDDEN
        assert client.post(_pages_url(public.id, "duplicate/")).status_code == status.HTTP_403_FORBIDDEN
        assert client.get(_pages_url(public.id, "description/")).status_code == status.HTTP_200_OK
        assert client.get(_pages_url(public.id, "versions/")).status_code == status.HTTP_200_OK

    @pytest.mark.django_db
    def test_guest_retrieve_unknown_page_is_404(self, workspace, guest):
        response = _client_for(guest).get(_pages_url(uuid.uuid4()))

        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_non_member_forbidden(self, workspace, create_user):
        page = _wiki_page(workspace, create_user)
        client = _client_for(_make_user("outsider"))

        assert client.get(_pages_url()).status_code == status.HTTP_403_FORBIDDEN
        assert client.get(_pages_url(page.id)).status_code == status.HTTP_403_FORBIDDEN
        assert client.get(_pages_url(page.id, "description/")).status_code == status.HTTP_403_FORBIDDEN
        assert client.post(_pages_url(), {"name": "x"}, format="json").status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_inactive_member_forbidden(self, workspace, create_user):
        user = _make_user("inactive")
        WorkspaceMember.objects.create(workspace=workspace, member=user, role=15, is_active=False)

        assert _client_for(user).get(_pages_url()).status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_private_page_is_owner_only(self, session_client, workspace, member):
        private = _wiki_page(workspace, member, access=Page.PRIVATE_ACCESS)

        # Even a workspace admin can't see someone else's private page
        assert session_client.get(_pages_url(private.id)).status_code == status.HTTP_404_NOT_FOUND
        assert str(private.id) not in _ids(session_client.get(_pages_url()))
        assert _client_for(member).get(_pages_url(private.id)).status_code == status.HTTP_200_OK


@pytest.mark.contract
class TestWikiProjectIsolation:
    @pytest.mark.django_db
    def test_project_pages_absent_from_wiki(self, session_client, workspace, create_user, project):
        project_page = _project_page(workspace, create_user, project)
        global_project_page = _project_page(workspace, create_user, project, is_global=True)
        wiki = _wiki_page(workspace, create_user)

        assert _ids(session_client.get(_pages_url())) == {str(wiki.id)}
        for page in (project_page, global_project_page):
            assert session_client.get(_pages_url(page.id)).status_code == status.HTTP_404_NOT_FOUND
            assert (
                session_client.patch(_pages_url(page.id), {"name": "hijack"}, format="json").status_code
                == status.HTTP_404_NOT_FOUND
            )
            assert session_client.get(_pages_url(page.id, "description/")).status_code == status.HTTP_404_NOT_FOUND
            assert session_client.get(_pages_url(page.id, "versions/")).status_code == status.HTTP_404_NOT_FOUND
        assert Page.objects.get(pk=project_page.id).name == "Project page"

    @pytest.mark.django_db
    def test_wiki_pages_absent_from_project_pages(self, session_client, workspace, create_user, project):
        project_page = _project_page(workspace, create_user, project)
        wiki = _wiki_page(workspace, create_user)

        response = session_client.get(f"/api/workspaces/{SLUG}/projects/{project.id}/pages/")

        assert response.status_code == status.HTTP_200_OK
        assert _ids(response) == {str(project_page.id)}
        detail = session_client.get(f"/api/workspaces/{SLUG}/projects/{project.id}/pages/{wiki.id}/")
        assert detail.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_other_workspace_wiki_page_not_reachable(self, session_client, workspace, create_user):
        from plane.db.models import Workspace

        other = Workspace.objects.create(name="Other", slug="other-workspace", owner=create_user)
        WorkspaceMember.objects.create(workspace=other, member=create_user, role=20)
        foreign = _wiki_page(other, create_user)

        assert session_client.get(_pages_url(foreign.id)).status_code == status.HTTP_404_NOT_FOUND
        assert str(foreign.id) not in _ids(session_client.get(_pages_url()))


@pytest.mark.contract
class TestWikiNesting:
    @pytest.mark.django_db
    def test_list_is_flat_with_parent_and_filtered_sub_pages_count(self, session_client, workspace, create_user):
        root = _wiki_page(workspace, create_user, name="root")
        child = _wiki_page(workspace, create_user, name="child", parent=root)
        _wiki_page(workspace, create_user, name="archived child", parent=root, archived_at=timezone.now())
        _wiki_page(workspace, create_user, name="deleted child", parent=root, deleted_at=timezone.now())
        other_private = _wiki_page(
            workspace, _make_user("someone"), name="hidden child", parent=root, access=Page.PRIVATE_ACCESS
        )

        response = session_client.get(_pages_url())

        assert response.status_code == status.HTTP_200_OK
        by_id = {item["id"]: item for item in response.json()}
        assert str(child.id) in by_id
        assert str(other_private.id) not in by_id
        assert by_id[str(child.id)]["parent"] == str(root.id)
        assert by_id[str(root.id)]["sub_pages_count"] == 1
        assert set(by_id[str(root.id)].keys()) == LIST_FIELDS

    @pytest.mark.django_db
    def test_parent_filter(self, session_client, workspace, create_user):
        root = _wiki_page(workspace, create_user, name="root")
        child = _wiki_page(workspace, create_user, name="child", parent=root)

        assert _ids(session_client.get(_pages_url(), {"parent": "null"})) == {str(root.id)}
        assert _ids(session_client.get(_pages_url(), {"parent": str(root.id)})) == {str(child.id)}
        assert session_client.get(_pages_url(), {"parent": "nope"}).status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_type_filter(self, session_client, workspace, create_user):
        public = _wiki_page(workspace, create_user)
        private = _wiki_page(workspace, create_user, access=Page.PRIVATE_ACCESS)
        archived = _wiki_page(workspace, create_user, archived_at=timezone.now())

        assert _ids(session_client.get(_pages_url())) == {str(public.id), str(private.id), str(archived.id)}
        assert _ids(session_client.get(_pages_url(), {"type": "all"})) == {str(public.id), str(private.id)}
        assert _ids(session_client.get(_pages_url(), {"type": "public"})) == {str(public.id)}
        assert _ids(session_client.get(_pages_url(), {"type": "private"})) == {str(private.id)}
        assert _ids(session_client.get(_pages_url(), {"type": "archived"})) == {str(archived.id)}

        summary = session_client.get(f"{BASE}/pages-summary/").json()
        assert summary == {"public_pages": 1, "private_pages": 1, "archived_pages": 1}

    @pytest.mark.django_db
    def test_create_with_parent(self, session_client, workspace, create_user):
        root = _wiki_page(workspace, create_user)

        response = session_client.post(_pages_url(), {"name": "sub", "parent": str(root.id)}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert response.json()["parent"] == str(root.id)

    @pytest.mark.django_db
    def test_parent_must_be_wiki_page(self, session_client, workspace, create_user, project):
        page = _wiki_page(workspace, create_user)
        project_page = _project_page(workspace, create_user, project)

        response = session_client.patch(_pages_url(page.id), {"parent": str(project_page.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

        response = session_client.post(_pages_url(), {"name": "x", "parent": str(project_page.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_parent_cannot_be_self_or_descendant(self, session_client, workspace, create_user):
        root = _wiki_page(workspace, create_user, name="root")
        child = _wiki_page(workspace, create_user, name="child", parent=root)
        grandchild = _wiki_page(workspace, create_user, name="grandchild", parent=child)

        for parent in (root, child, grandchild):
            response = session_client.patch(_pages_url(root.id), {"parent": str(parent.id)}, format="json")
            assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert Page.objects.get(pk=root.id).parent_id is None

        # Moving a leaf to the root (and back under another page) is fine
        response = session_client.patch(_pages_url(grandchild.id), {"parent": None}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["parent"] is None
        response = session_client.patch(_pages_url(grandchild.id), {"parent": str(root.id)}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert Page.objects.get(pk=grandchild.id).parent_id == root.id

    @pytest.mark.django_db
    def test_sort_order_is_writable_and_ordered(self, session_client, workspace, create_user):
        first = _wiki_page(workspace, create_user, name="first", sort_order=100)
        second = _wiki_page(workspace, create_user, name="second", sort_order=200)

        response = session_client.patch(_pages_url(second.id), {"sort_order": 50.5}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["sort_order"] == 50.5
        assert Page.objects.get(pk=second.id).sort_order == 50.5
        listed = [item["id"] for item in session_client.get(_pages_url(), {"order_by": "sort_order"}).json()]
        assert listed == [str(second.id), str(first.id)]
        assert (
            session_client.patch(_pages_url(second.id), {"sort_order": -1}, format="json").status_code
            == status.HTTP_400_BAD_REQUEST
        )


@pytest.mark.contract
class TestWikiPageUpdates:
    @pytest.mark.django_db
    def test_patch_locked_page_rejected(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user, is_locked=True)

        response = session_client.patch(_pages_url(page.id), {"name": "x"}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_member_edits_public_page(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user)

        response = _client_for(member).patch(_pages_url(page.id), {"name": "Renamed"}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["name"] == "Renamed"
        assert set(response.json().keys()) == LIST_FIELDS | {"description_html"}

    @pytest.mark.django_db
    def test_access_change_by_non_owner_forbidden(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user)
        client = _client_for(member)

        response = client.patch(_pages_url(page.id), {"access": 1}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN
        response = client.post(_pages_url(page.id, "access/"), {"access": 1}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert Page.objects.get(pk=page.id).access == Page.PUBLIC_ACCESS

    @pytest.mark.django_db
    def test_owner_changes_access(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user)

        response = session_client.post(_pages_url(page.id, "access/"), {"access": 1}, format="json")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert Page.objects.get(pk=page.id).access == Page.PRIVATE_ACCESS

    @pytest.mark.django_db
    def test_lock_unlock(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user)

        assert session_client.post(_pages_url(page.id, "lock/")).status_code == status.HTTP_204_NO_CONTENT
        assert Page.objects.get(pk=page.id).is_locked is True
        assert session_client.delete(_pages_url(page.id, "lock/")).status_code == status.HTTP_204_NO_CONTENT
        assert Page.objects.get(pk=page.id).is_locked is False

    @pytest.mark.django_db
    def test_retrieve_tracks_visit_without_project(self, session_client, workspace, create_user, mock_tasks):
        page = _wiki_page(workspace, create_user)

        response = session_client.get(_pages_url(page.id))

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["issue_ids"] == []
        assert "description_html" in response.json()
        assert mock_tasks["recent_visited_task"].delay.call_args.kwargs["project_id"] is None

        mock_tasks["recent_visited_task"].reset_mock()
        session_client.get(_pages_url(page.id), {"track_visit": "false"})
        mock_tasks["recent_visited_task"].delay.assert_not_called()


@pytest.mark.contract
class TestWikiArchiveAndDelete:
    @pytest.mark.django_db
    def test_member_cannot_archive_others_page(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user)

        response = _client_for(member).post(_pages_url(page.id, "archive/"))

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert Page.objects.get(pk=page.id).archived_at is None

    @pytest.mark.django_db
    def test_admin_archives_and_restores_recursively(self, session_client, workspace, create_user, member):
        root = _wiki_page(workspace, member, name="root")
        child = _wiki_page(workspace, member, name="child", parent=root)
        grandchild = _wiki_page(workspace, member, name="grandchild", parent=child)
        UserFavorite.objects.create(
            workspace=workspace, user=member, entity_type="page", entity_identifier=root.id, project=None
        )

        response = session_client.post(_pages_url(root.id, "archive/"))

        assert response.status_code == status.HTTP_200_OK
        assert "archived_at" in response.json()
        for page in (root, child, grandchild):
            assert Page.objects.get(pk=page.id).archived_at is not None
        assert not UserFavorite.objects.filter(entity_identifier=root.id).exists()

        response = session_client.delete(_pages_url(root.id, "archive/"))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        for page in (root, child, grandchild):
            restored = Page.objects.get(pk=page.id)
            assert restored.archived_at is None
        assert Page.objects.get(pk=child.id).parent_id == root.id
        assert Page.objects.get(pk=grandchild.id).parent_id == child.id

    @pytest.mark.django_db
    def test_unarchive_detaches_from_archived_parent(self, session_client, workspace, create_user):
        root = _wiki_page(workspace, create_user, name="root")
        child = _wiki_page(workspace, create_user, name="child", parent=root)
        session_client.post(_pages_url(root.id, "archive/"))

        response = session_client.delete(_pages_url(child.id, "archive/"))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        child.refresh_from_db()
        assert child.archived_at is None
        assert child.parent_id is None
        assert Page.objects.get(pk=root.id).archived_at is not None

    @pytest.mark.django_db
    def test_destroy_requires_archived(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user)

        response = session_client.delete(_pages_url(page.id))

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert Page.objects.filter(pk=page.id).exists()

    @pytest.mark.django_db
    def test_member_owner_deletes_own_archived_page(self, workspace, member):
        page = _wiki_page(workspace, member, archived_at=timezone.now())
        child = _wiki_page(workspace, member, parent=page, archived_at=timezone.now())
        UserFavorite.objects.create(
            workspace=workspace, user=member, entity_type="page", entity_identifier=page.id, project=None
        )
        UserRecentVisit.objects.create(
            workspace=workspace, user=member, entity_name="page", entity_identifier=page.id, project=None
        )

        response = _client_for(member).delete(_pages_url(page.id))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Page.objects.filter(pk=page.id).exists()
        assert Page.objects.get(pk=child.id).parent_id is None
        assert not UserFavorite.all_objects.filter(entity_identifier=page.id).exists()
        assert not UserRecentVisit.all_objects.filter(entity_identifier=page.id).exists()

    @pytest.mark.django_db
    def test_member_non_owner_cannot_delete(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user, archived_at=timezone.now())

        response = _client_for(member).delete(_pages_url(page.id))

        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert Page.objects.filter(pk=page.id).exists()

    @pytest.mark.django_db
    def test_admin_deletes_others_archived_page(self, session_client, workspace, member):
        page = _wiki_page(workspace, member, archived_at=timezone.now())

        response = session_client.delete(_pages_url(page.id))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Page.objects.filter(pk=page.id).exists()


@pytest.mark.contract
class TestWikiDescription:
    @pytest.mark.django_db
    def test_get_returns_octet_stream(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user, description_binary=b"\x01\x02\x03\x04")

        response = session_client.get(_pages_url(page.id, "description/"))

        assert response.status_code == status.HTTP_200_OK
        assert response["Content-Type"] == "application/octet-stream"
        assert b"".join(response.streaming_content) == b"\x01\x02\x03\x04"

    @pytest.mark.django_db
    def test_patch_updates_description(self, session_client, workspace, create_user, mock_tasks):
        page = _wiki_page(workspace, create_user)
        payload = {
            "description_binary": base64.b64encode(b"\x05\x06\x07\x08").decode(),
            "description_html": "<p>hello</p>",
            "description_json": {"type": "doc"},
        }

        response = session_client.patch(_pages_url(page.id, "description/"), payload, format="json")

        assert response.status_code == status.HTTP_200_OK
        page.refresh_from_db()
        assert bytes(page.description_binary) == b"\x05\x06\x07\x08"
        assert page.description_html == "<p>hello</p>"
        mock_tasks["track_page_version"].delay.assert_called_once()
        mock_tasks["page_transaction"].delay.assert_called_once()

    @pytest.mark.django_db
    def test_patch_locked_and_archived_error_codes(self, session_client, workspace, create_user):
        locked = _wiki_page(workspace, create_user, is_locked=True)
        archived = _wiki_page(workspace, create_user, archived_at=timezone.now())
        payload = {"description_html": "<p>x</p>"}

        response = session_client.patch(_pages_url(locked.id, "description/"), payload, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json() == {"error_code": 4701, "error_message": "PAGE_LOCKED"}

        response = session_client.patch(_pages_url(archived.id, "description/"), payload, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json() == {"error_code": 4702, "error_message": "PAGE_ARCHIVED"}

    @pytest.mark.django_db
    def test_patch_invalid_base64(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user)

        response = session_client.patch(_pages_url(page.id, "description/"), {"description_binary": "a"}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_member_patches_public_page(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user)

        response = _client_for(member).patch(
            _pages_url(page.id, "description/"), {"description_html": "<p>m</p>"}, format="json"
        )

        assert response.status_code == status.HTTP_200_OK

    @pytest.mark.django_db
    def test_guest_cannot_write_description(self, workspace, create_user, guest):
        # Guests are read-only, including the binary write-back the live server
        # attempts on a page's first open (live tolerates that failure).
        opened = _wiki_page(workspace, create_user, description_binary=b"\x01\x02\x03\x04")
        fresh = _wiki_page(workspace, create_user)
        client = _client_for(guest)
        binary = base64.b64encode(b"\x09\x0a\x0b\x0c").decode()

        response = client.patch(_pages_url(opened.id, "description/"), {"description_binary": binary}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN
        response = client.patch(_pages_url(fresh.id, "description/"), {"description_binary": binary}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN
        response = client.patch(_pages_url(fresh.id, "description/"), {"description_html": "<p>x</p>"}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert Page.objects.get(pk=opened.id).description_binary == b"\x01\x02\x03\x04"
        assert Page.objects.get(pk=fresh.id).description_binary is None


@pytest.mark.contract
class TestWikiVersions:
    @pytest.mark.django_db
    def test_versions_scoped_to_wiki_page(self, session_client, workspace, create_user, project):
        wiki = _wiki_page(workspace, create_user)
        project_page = _project_page(workspace, create_user, project)
        wiki_version = PageVersion.objects.create(workspace=workspace, page=wiki, owned_by=create_user)
        project_version = PageVersion.objects.create(workspace=workspace, page=project_page, owned_by=create_user)

        response = session_client.get(_pages_url(wiki.id, "versions/"))
        assert response.status_code == status.HTTP_200_OK
        assert _ids(response) == {str(wiki_version.id)}

        response = session_client.get(_pages_url(wiki.id, f"versions/{wiki_version.id}/"))
        assert response.status_code == status.HTTP_200_OK
        assert "description_html" in response.json()

        response = session_client.get(_pages_url(wiki.id, f"versions/{project_version.id}/"))
        assert response.status_code == status.HTTP_404_NOT_FOUND
        response = session_client.get(_pages_url(project_page.id, f"versions/{project_version.id}/"))
        assert response.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestWikiDuplicate:
    @pytest.mark.django_db
    def test_duplicate_keeps_parent_and_scope(self, workspace, create_user, member, mock_tasks):
        root = _wiki_page(workspace, create_user)
        page = _wiki_page(workspace, create_user, name="Doc", parent=root)

        response = _client_for(member).post(_pages_url(page.id, "duplicate/"))

        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["name"] == "Doc (Copy)"
        assert data["parent"] == str(root.id)
        assert data["owned_by"] == str(member.id)
        assert data["is_global"] is True
        copy = Page.objects.get(pk=data["id"])
        assert copy.id != page.id
        assert not ProjectPage.all_objects.filter(page=copy).exists()
        assert mock_tasks["copy_s3"].delay.call_args.kwargs["project_id"] is None

    @pytest.mark.django_db
    def test_duplicate_others_private_page_denied(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user, access=Page.PRIVATE_ACCESS)

        response = _client_for(member).post(_pages_url(page.id, "duplicate/"))

        assert response.status_code in (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)
        assert Page.objects.filter(name__endswith="(Copy)").count() == 0


@pytest.mark.contract
class TestWikiFavorites:
    @pytest.mark.django_db
    def test_project_less_page_favorite_listed(self, session_client, workspace, create_user):
        page = _wiki_page(workspace, create_user, name="Fav")

        response = session_client.post(
            f"/api/workspaces/{SLUG}/user-favorites/",
            {"entity_type": "page", "entity_identifier": str(page.id), "project_id": None},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        favorite = UserFavorite.objects.get(entity_identifier=page.id)
        assert favorite.workspace_id == workspace.id
        assert favorite.project_id is None

        listed = session_client.get(f"/api/workspaces/{SLUG}/user-favorites/").json()
        entry = next(item for item in listed if item["entity_identifier"] == str(page.id))
        assert entry["project_id"] is None
        assert entry["entity_data"]["name"] == "Fav"
        assert entry["entity_data"]["project_id"] is None

        listed_pages = session_client.get(_pages_url()).json()
        assert next(item for item in listed_pages if item["id"] == str(page.id))["is_favorite"] is True
