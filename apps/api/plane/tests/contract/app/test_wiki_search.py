# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Contract tests for workspace wiki pages in search.

Wiki pages (Page(is_global=True) without a ProjectPage link) must be found by
the global search (Cmd+K) and the entity search (mentions / page embeds) for
workspace members, without leaking private pages of other users, archived
pages, or project pages of projects the user is not a member of.
"""

import uuid

import pytest
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import Page, Project, ProjectMember, ProjectPage, User, WorkspaceMember

SLUG = "test-workspace"
GLOBAL_SEARCH = f"/api/workspaces/{SLUG}/search/"
ENTITY_SEARCH = f"/api/workspaces/{SLUG}/entity-search/"


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _make_user(prefix):
    unique = uuid.uuid4().hex[:8]
    return User.objects.create(email=f"{prefix}-{unique}@plane.so", username=f"{prefix}_{unique}")


def _member(workspace, role=15, prefix="member"):
    user = _make_user(prefix)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


def _wiki_page(workspace, owner, **kwargs):
    kwargs.setdefault("name", "Wiki page")
    kwargs.setdefault("access", Page.PUBLIC_ACCESS)
    return Page.objects.create(workspace=workspace, owned_by=owner, is_global=True, **kwargs)


def _global_pages(client, search):
    response = client.get(GLOBAL_SEARCH, {"search": search, "entities": "page"})
    assert response.status_code == status.HTTP_200_OK
    return response.json()["results"]["page"]


def _global_ids(client, search):
    return {item["id"] for item in _global_pages(client, search)}


def _entity_ids(client, query, **params):
    response = client.get(ENTITY_SEARCH, {"query": query, "query_type": "page", **params})
    assert response.status_code == status.HTTP_200_OK
    return {item["id"] for item in response.json()["page"]}


@pytest.fixture
def member(workspace):
    return _member(workspace)


@pytest.fixture
def project(workspace, create_user):
    project = Project.objects.create(name="Project", identifier="PRJ", workspace=workspace)
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    return project


@pytest.mark.contract
class TestWikiGlobalSearch:
    @pytest.mark.django_db
    def test_member_finds_public_wiki_page(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user, name="Engineering Handbook")
        _wiki_page(workspace, create_user, name="Unrelated")

        results = _global_pages(_client_for(member), "handbook")

        assert results == [
            {
                "name": "Engineering Handbook",
                "id": str(page.id),
                "project_ids": [],
                "project_identifiers": [],
                "workspace__slug": SLUG,
            }
        ]

    @pytest.mark.django_db
    def test_private_wiki_page_only_for_owner(self, session_client, workspace, create_user, member):
        page = _wiki_page(workspace, create_user, name="Secret plans", access=Page.PRIVATE_ACCESS)

        assert _global_ids(session_client, "secret") == {str(page.id)}
        assert _global_ids(_client_for(member), "secret") == set()

    @pytest.mark.django_db
    def test_archived_and_deleted_wiki_pages_are_hidden(self, session_client, workspace, create_user):
        _wiki_page(workspace, create_user, name="Old archived", archived_at=timezone.now().date())
        deleted = _wiki_page(workspace, create_user, name="Old deleted")
        deleted.delete()

        assert _global_ids(session_client, "old") == set()

    @pytest.mark.django_db
    def test_project_pages_still_require_project_membership(self, session_client, workspace, create_user, project):
        page = Page.objects.create(workspace=workspace, owned_by=create_user, access=Page.PUBLIC_ACCESS, name="Roadmap")
        ProjectPage.objects.create(workspace=workspace, project=project, page=page)
        # A global page linked to a project is a project page, not a wiki page
        global_project_page = Page.objects.create(
            workspace=workspace, owned_by=create_user, access=Page.PUBLIC_ACCESS, name="Roadmap 2", is_global=True
        )
        ProjectPage.objects.create(workspace=workspace, project=project, page=global_project_page)
        outsider = _member(workspace, prefix="outsider")

        assert _global_ids(_client_for(outsider), "roadmap") == set()

        results = _global_pages(session_client, "roadmap")
        assert {item["id"] for item in results} == {str(page.id), str(global_project_page.id)}
        assert len(results) == 2
        for item in results:
            assert item["project_ids"] == [str(project.id)]

    @pytest.mark.django_db
    def test_wiki_and_project_pages_together_without_duplicates(self, session_client, workspace, create_user, project):
        wiki = _wiki_page(workspace, create_user, name="Docs wiki")
        project_page = Page.objects.create(
            workspace=workspace, owned_by=create_user, access=Page.PUBLIC_ACCESS, name="Docs project"
        )
        ProjectPage.objects.create(workspace=workspace, project=project, page=project_page)

        results = _global_pages(session_client, "docs")

        assert len(results) == 2
        by_id = {item["id"]: item for item in results}
        assert by_id[str(wiki.id)]["project_ids"] == []
        assert by_id[str(project_page.id)]["project_ids"] == [str(project.id)]

    @pytest.mark.django_db
    def test_wiki_pages_of_other_workspaces_are_hidden(self, session_client, workspace, create_user):
        from plane.db.models import Workspace

        other = Workspace.objects.create(name="Other", owner=create_user, slug="other-workspace")
        WorkspaceMember.objects.create(workspace=other, member=create_user, role=20)
        _wiki_page(other, create_user, name="Foreign wiki")

        assert _global_ids(session_client, "foreign") == set()

    @pytest.mark.django_db
    def test_non_member_gets_nothing(self, workspace, create_user):
        _wiki_page(workspace, create_user, name="Public wiki")
        outsider = _make_user("outsider")

        assert _global_ids(_client_for(outsider), "wiki") == set()

    @pytest.mark.django_db
    def test_inactive_member_gets_nothing(self, workspace, create_user):
        _wiki_page(workspace, create_user, name="Public wiki")
        former = _member(workspace, prefix="former")
        WorkspaceMember.objects.filter(member=former).update(is_active=False)

        assert _global_ids(_client_for(former), "wiki") == set()


@pytest.mark.contract
class TestWikiEntitySearch:
    @pytest.mark.django_db
    def test_without_project_returns_public_wiki_page(self, workspace, create_user, member):
        page = _wiki_page(workspace, create_user, name="Onboarding")

        response = _client_for(member).get(ENTITY_SEARCH, {"query": "onboard", "query_type": "page"})

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["page"] == [
            {
                "name": "Onboarding",
                "id": str(page.id),
                "logo_props": {},
                "projects__id": None,
                "workspace__slug": SLUG,
            }
        ]

    @pytest.mark.django_db
    def test_with_project_excludes_wiki_pages(self, session_client, workspace, create_user, project):
        _wiki_page(workspace, create_user, name="Onboarding wiki")
        project_page = Page.objects.create(
            workspace=workspace, owned_by=create_user, access=Page.PUBLIC_ACCESS, name="Onboarding project"
        )
        ProjectPage.objects.create(workspace=workspace, project=project, page=project_page)

        assert _entity_ids(session_client, "onboarding", project_id=str(project.id)) == {str(project_page.id)}

    @pytest.mark.django_db
    def test_hides_private_archived_and_deleted_wiki_pages(self, session_client, workspace, create_user, member):
        private = _wiki_page(workspace, member, name="Note private", access=Page.PRIVATE_ACCESS)
        _wiki_page(workspace, create_user, name="Note archived", archived_at=timezone.now().date())
        _wiki_page(workspace, create_user, name="Note deleted").delete()
        visible = _wiki_page(workspace, create_user, name="Note public")

        assert _entity_ids(session_client, "note") == {str(visible.id)}
        # Like project pages, entity search only offers public pages for embeds/mentions
        assert str(private.id) not in _entity_ids(_client_for(member), "note")

    @pytest.mark.django_db
    def test_non_member_is_forbidden(self, workspace, create_user):
        _wiki_page(workspace, create_user, name="Onboarding")
        response = _client_for(_make_user("outsider")).get(ENTITY_SEARCH, {"query": "onboard", "query_type": "page"})

        assert response.status_code == status.HTTP_403_FORBIDDEN
