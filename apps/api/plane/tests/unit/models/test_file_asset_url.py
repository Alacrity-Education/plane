# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Unit tests for FileAsset.asset_url.

Description assets uploaded through the workspace-level endpoint (e.g. images
in a workspace wiki page) have no project, so they must resolve through
/api/assets/v2/workspaces/<slug>/<id>/ instead of a /projects/None/ URL.
"""

import pytest

from plane.db.models import FileAsset, Project
from plane.tests.factories import UserFactory, WorkspaceFactory


@pytest.fixture
def workspace(db):
    return WorkspaceFactory(owner=UserFactory(), slug="asset-url-ws")


def _asset(workspace, entity_type, project=None):
    return FileAsset.objects.create(
        workspace=workspace,
        project=project,
        entity_type=entity_type,
        asset="asset-url-ws/file.png",
        attributes={"name": "file.png", "type": "image/png", "size": 10},
    )


@pytest.mark.unit
class TestFileAssetUrl:
    @pytest.mark.django_db
    @pytest.mark.parametrize(
        "entity_type",
        [
            FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
            FileAsset.EntityTypeContext.ISSUE_DESCRIPTION,
            FileAsset.EntityTypeContext.COMMENT_DESCRIPTION,
            FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION,
        ],
    )
    def test_project_less_description_asset_uses_workspace_url(self, workspace, entity_type):
        asset = _asset(workspace, entity_type)

        assert asset.asset_url == f"/api/assets/v2/workspaces/{workspace.slug}/{asset.id}/"
        assert "None" not in asset.asset_url

    @pytest.mark.django_db
    def test_project_description_asset_url_unchanged(self, workspace):
        project = Project.objects.create(name="P", identifier="PRJ", workspace=workspace)
        asset = _asset(workspace, FileAsset.EntityTypeContext.PAGE_DESCRIPTION, project=project)

        assert asset.asset_url == f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/"

    @pytest.mark.django_db
    def test_static_asset_url_unchanged(self, workspace):
        asset = _asset(workspace, FileAsset.EntityTypeContext.WORKSPACE_LOGO)

        assert asset.asset_url == f"/api/assets/v2/static/{asset.id}/"
