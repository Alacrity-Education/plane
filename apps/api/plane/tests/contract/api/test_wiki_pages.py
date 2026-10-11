# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from datetime import timedelta
from uuid import uuid4

import pytest
from django.urls import resolve
from django.utils import timezone
from rest_framework import status

from plane.api.views import WikiPageDetailAPIEndpoint, WikiPageListAPIEndpoint
from plane.db.models import (
    FileAsset,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    ProjectWiki,
    User,
    WorkspaceMember,
)


LIST_FIELDS = {
    "id",
    "name",
    "parent",
    "sort_order",
    "access",
    "is_locked",
    "archived_at",
    "logo_props",
    "color",
    "owned_by",
    "label_ids",
    "sub_pages_count",
    "description_stripped",
    "created_at",
    "updated_at",
    "workspace",
    "project_wiki",
}


def list_url(slug):
    return f"/api/v1/workspaces/{slug}/wiki/pages/"


def detail_url(slug, page_id):
    return f"/api/v1/workspaces/{slug}/wiki/pages/{page_id}/"


def make_page(workspace, owner, **kwargs):
    defaults = {
        "workspace": workspace,
        "owned_by": owner,
        "is_global": True,
        "access": Page.PUBLIC_ACCESS,
        "name": "Wiki page",
    }
    defaults.update(kwargs)
    return Page.objects.create(**defaults)


def result_ids(response):
    return {str(item["id"]) for item in response.data["results"]}


@pytest.fixture
def root_page(db, workspace, create_user):
    return make_page(
        workspace,
        create_user,
        name="Root",
        sort_order=1000,
        description_html="<h1>Hello</h1><p>World</p>",
    )


@pytest.fixture
def child_page(db, workspace, create_user, root_page):
    return make_page(workspace, create_user, name="Child", parent=root_page, sort_order=2000)


@pytest.fixture
def other_user(db, workspace):
    user = User.objects.create(email="other@plane.so", username="other-wiki-user")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.mark.contract
class TestWikiPageListAPIEndpoint:
    @pytest.mark.django_db
    def test_list_returns_paginated_envelope(self, api_key_client, workspace, root_page, child_page):
        response = api_key_client.get(list_url(workspace.slug))

        assert response.status_code == status.HTTP_200_OK
        for key in ("results", "next_cursor", "prev_cursor", "total_count", "next_page_results"):
            assert key in response.data
        assert response.data["total_count"] == 2
        assert result_ids(response) == {str(root_page.id), str(child_page.id)}
        for item in response.data["results"]:
            assert set(item.keys()) == LIST_FIELDS

    @pytest.mark.django_db
    def test_default_order_is_sort_order(self, api_key_client, workspace, create_user):
        late = make_page(workspace, create_user, name="Late", sort_order=3000)
        early = make_page(workspace, create_user, name="Early", sort_order=1000)

        response = api_key_client.get(list_url(workspace.slug))

        assert [str(i["id"]) for i in response.data["results"]] == [str(early.id), str(late.id)]

    @pytest.mark.django_db
    def test_child_carries_parent_and_root_counts_children(self, api_key_client, workspace, root_page, child_page):
        response = api_key_client.get(list_url(workspace.slug))

        by_id = {str(i["id"]): i for i in response.data["results"]}
        assert str(by_id[str(child_page.id)]["parent"]) == str(root_page.id)
        assert by_id[str(root_page.id)]["parent"] is None
        assert by_id[str(root_page.id)]["sub_pages_count"] == 1
        assert by_id[str(child_page.id)]["sub_pages_count"] == 0

    @pytest.mark.django_db
    def test_sub_pages_count_ignores_archived_and_deleted_children(
        self, api_key_client, workspace, create_user, root_page, child_page
    ):
        make_page(workspace, create_user, name="Archived child", parent=root_page, archived_at=timezone.now().date())
        deleted = make_page(workspace, create_user, name="Deleted child", parent=root_page)
        Page.objects.filter(pk=deleted.pk).update(deleted_at=timezone.now())

        response = api_key_client.get(list_url(workspace.slug))

        by_id = {str(i["id"]): i for i in response.data["results"]}
        assert by_id[str(root_page.id)]["sub_pages_count"] == 1

    @pytest.mark.django_db
    def test_excludes_non_wiki_private_archived_and_deleted_pages(
        self, api_key_client, workspace, create_user, other_user, root_page
    ):
        project = Project.objects.create(name="Proj", identifier="PRJ", workspace=workspace, created_by=create_user)
        ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)
        project_page = make_page(workspace, create_user, name="Project page", is_global=False)
        ProjectPage.objects.create(project=project, page=project_page, workspace=workspace)
        linked_global = make_page(workspace, create_user, name="Global but project-linked")
        ProjectPage.objects.create(project=project, page=linked_global, workspace=workspace)
        own_private = make_page(workspace, create_user, name="Own private", access=Page.PRIVATE_ACCESS)
        others_private = make_page(workspace, other_user, name="Other private", access=Page.PRIVATE_ACCESS)
        archived = make_page(workspace, create_user, name="Archived", archived_at=timezone.now().date())
        deleted = make_page(workspace, create_user, name="Deleted")
        Page.objects.filter(pk=deleted.pk).update(deleted_at=timezone.now())

        response = api_key_client.get(list_url(workspace.slug))

        assert response.status_code == status.HTTP_200_OK
        assert result_ids(response) == {str(root_page.id)}
        for excluded in (project_page, linked_global, own_private, others_private, archived, deleted):
            detail = api_key_client.get(detail_url(workspace.slug, excluded.id))
            assert detail.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_updated_since_filter(self, api_key_client, workspace, create_user, root_page):
        old = make_page(workspace, create_user, name="Old")
        Page.objects.filter(pk=old.pk).update(updated_at=timezone.now() - timedelta(days=10))
        since = (timezone.now() - timedelta(days=1)).isoformat()

        response = api_key_client.get(list_url(workspace.slug), {"updated_since": since})

        assert response.status_code == status.HTTP_200_OK
        assert result_ids(response) == {str(root_page.id)}

        response = api_key_client.get(list_url(workspace.slug), {"updated_since": "2000-01-01"})
        assert result_ids(response) == {str(root_page.id), str(old.id)}

    @pytest.mark.django_db
    def test_updated_since_invalid_returns_400(self, api_key_client, workspace):
        response = api_key_client.get(list_url(workspace.slug), {"updated_since": "yesterday"})
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_parent_filter(self, api_key_client, workspace, root_page, child_page):
        response = api_key_client.get(list_url(workspace.slug), {"parent": str(root_page.id)})
        assert result_ids(response) == {str(child_page.id)}

        response = api_key_client.get(list_url(workspace.slug), {"parent": "null"})
        assert result_ids(response) == {str(root_page.id)}

        response = api_key_client.get(list_url(workspace.slug), {"parent": "not-a-uuid"})
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_order_by_allowlist(self, api_key_client, workspace, create_user):
        b = make_page(workspace, create_user, name="B", sort_order=1000)
        a = make_page(workspace, create_user, name="A", sort_order=2000)

        response = api_key_client.get(list_url(workspace.slug), {"order_by": "-name"})
        assert [str(i["id"]) for i in response.data["results"]] == [str(b.id), str(a.id)]

        response = api_key_client.get(list_url(workspace.slug), {"order_by": "description_html"})
        assert response.status_code == status.HTTP_200_OK
        assert [str(i["id"]) for i in response.data["results"]] == [str(b.id), str(a.id)]

        response = api_key_client.get(list_url(workspace.slug), {"order_by": "owned_by__password"})
        assert response.status_code == status.HTTP_200_OK

    @pytest.mark.django_db
    def test_cursor_pagination(self, api_key_client, workspace, create_user):
        pages = [make_page(workspace, create_user, name=f"P{i}", sort_order=1000 * (i + 1)) for i in range(3)]

        first = api_key_client.get(list_url(workspace.slug), {"per_page": 2})
        assert first.data["total_count"] == 3
        assert first.data["next_page_results"] is True
        second = api_key_client.get(list_url(workspace.slug), {"per_page": 2, "cursor": first.data["next_cursor"]})
        assert second.data["next_page_results"] is False

        seen = [str(i["id"]) for i in first.data["results"] + second.data["results"]]
        assert seen == [str(p.id) for p in pages]

    @pytest.mark.django_db
    def test_expand_parent_is_ignored(self, api_key_client, workspace, root_page, child_page):
        response = api_key_client.get(list_url(workspace.slug), {"expand": "parent"})

        assert response.status_code == status.HTTP_200_OK
        by_id = {str(i["id"]): i for i in response.data["results"]}
        assert str(by_id[str(child_page.id)]["parent"]) == str(root_page.id)

    @pytest.mark.django_db
    def test_requires_api_key(self, api_client, workspace):
        response = api_client.get(list_url(workspace.slug))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    @pytest.mark.django_db
    def test_unknown_workspace(self, api_key_client, workspace):
        response = api_key_client.get(list_url("does-not-exist"))
        assert response.status_code in (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)

    @pytest.mark.django_db
    def test_non_member_forbidden(self, api_key_client, workspace, root_page):
        WorkspaceMember.objects.filter(workspace=workspace).update(is_active=False)
        response = api_key_client.get(list_url(workspace.slug))
        assert response.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_write_methods_not_allowed(self, api_key_client, workspace):
        response = api_key_client.post(list_url(workspace.slug), {"name": "x"}, format="json")
        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED


@pytest.mark.contract
class TestWikiPageDetailAPIEndpoint:
    @pytest.mark.django_db
    def test_retrieve_includes_body_and_assets(self, api_key_client, workspace, create_user, root_page, child_page):
        asset = FileAsset.objects.create(
            attributes={"name": "diagram.png", "type": "image/png", "size": 2048},
            asset=f"{workspace.id}/diagram.png",
            size=2048,
            workspace=workspace,
            project=None,
            page=root_page,
            entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
            entity_identifier=str(root_page.id),
            created_by=create_user,
            is_uploaded=True,
        )
        # Not uploaded yet, deleted, or of a different entity type: never listed.
        FileAsset.objects.create(
            attributes={"name": "pending.png", "type": "image/png"},
            asset=f"{workspace.id}/pending.png",
            workspace=workspace,
            page=root_page,
            entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
            is_uploaded=False,
        )
        FileAsset.objects.create(
            attributes={"name": "gone.png", "type": "image/png"},
            asset=f"{workspace.id}/gone.png",
            workspace=workspace,
            page=root_page,
            entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
            is_uploaded=True,
            is_deleted=True,
        )
        FileAsset.objects.create(
            attributes={"name": "cover.png", "type": "image/png"},
            asset=f"{workspace.id}/cover.png",
            workspace=workspace,
            page=root_page,
            entity_type=FileAsset.EntityTypeContext.PROJECT_COVER,
            is_uploaded=True,
        )

        response = api_key_client.get(detail_url(workspace.slug, root_page.id))

        assert response.status_code == status.HTTP_200_OK
        assert set(response.data.keys()) == LIST_FIELDS | {"description_html", "assets"}
        assert response.data["description_html"] == "<h1>Hello</h1><p>World</p>"
        assert "Hello" in response.data["description_stripped"]
        assert response.data["sub_pages_count"] == 1
        assert response.data["parent"] is None
        assert response.data["assets"] == [
            {"id": str(asset.id), "name": "diagram.png", "type": "image/png", "size": 2048.0}
        ]

    @pytest.mark.django_db
    def test_retrieve_child_carries_parent(self, api_key_client, workspace, root_page, child_page):
        response = api_key_client.get(detail_url(workspace.slug, child_page.id), {"expand": "parent"})

        assert response.status_code == status.HTTP_200_OK
        assert str(response.data["parent"]) == str(root_page.id)
        assert response.data["assets"] == []

    @pytest.mark.django_db
    def test_retrieve_unknown_page(self, api_key_client, workspace):
        response = api_key_client.get(detail_url(workspace.slug, uuid4()))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_retrieve_requires_api_key(self, api_client, workspace, root_page):
        response = api_client.get(detail_url(workspace.slug, root_page.id))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    @pytest.mark.django_db
    def test_retrieve_page_of_other_workspace(self, api_key_client, workspace, create_user):
        from plane.db.models import Workspace

        other_ws = Workspace.objects.create(name="Other", owner=create_user, slug="other-wiki-ws")
        foreign = make_page(other_ws, create_user, name="Foreign")

        response = api_key_client.get(detail_url(workspace.slug, foreign.id))
        assert response.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestWikiPageProjectWiki:
    @pytest.mark.django_db
    def test_project_wiki_on_root_and_null_elsewhere(self, api_key_client, workspace, root_page, child_page):
        project = Project.objects.create(name="Feed Project", identifier="FEED", workspace=workspace)
        ProjectWiki.objects.create(workspace=workspace, project=project, root_page=root_page)
        expected = {"project_id": str(project.id), "identifier": "FEED", "name": "Feed Project"}

        response = api_key_client.get(list_url(workspace.slug))

        assert response.status_code == status.HTTP_200_OK
        by_id = {str(item["id"]): item for item in response.data["results"]}
        assert by_id[str(root_page.id)]["project_wiki"] == expected
        assert by_id[str(child_page.id)]["project_wiki"] is None

        detail = api_key_client.get(detail_url(workspace.slug, root_page.id))
        assert detail.status_code == status.HTTP_200_OK
        assert detail.data["project_wiki"] == expected
        assert api_key_client.get(detail_url(workspace.slug, child_page.id)).data["project_wiki"] is None


@pytest.mark.contract
class TestWikiPageRouting:
    def test_urls_resolve_to_read_replica_get_only_views(self):
        page_id = uuid4()
        list_match = resolve(list_url("test-workspace"))
        detail_match = resolve(detail_url("test-workspace", page_id))

        assert list_match.url_name == "wiki-pages"
        assert detail_match.url_name == "wiki-page"
        assert list_match.func.view_class is WikiPageListAPIEndpoint
        assert detail_match.func.view_class is WikiPageDetailAPIEndpoint
        for match in (list_match, detail_match):
            assert match.func.view_class.use_read_replica is True
            assert match.func.view_initkwargs["http_method_names"] == ["get"]
