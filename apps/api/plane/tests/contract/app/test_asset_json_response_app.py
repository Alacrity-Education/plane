# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
``?response=json`` on the v2 asset GET endpoints returns the signed URL instead
of redirecting to it, so a browser can fetch the bytes anonymously (the
Excalidraw editor reloads a drawing's scene this way).
"""

from unittest import mock

import pytest
from rest_framework import status

from plane.db.models import FileAsset, Project, ProjectMember

S3_STORAGE_PATH = "plane.app.views.asset.v2.S3Storage"
SIGNED_URL = "https://storage.example.com/signed/drawing.png"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Test Project", identifier="TP", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def workspace_drawing_asset(db, workspace, create_user):
    return FileAsset.objects.create(
        attributes={"name": "drawing.png", "type": "image/png", "size": 2048},
        asset=f"{workspace.id}/drawing.png",
        size=2048,
        workspace=workspace,
        created_by=create_user,
        entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
        is_uploaded=True,
        storage_metadata={"size": 2048},
    )


@pytest.fixture
def project_drawing_asset(db, workspace, project, create_user):
    return FileAsset.objects.create(
        attributes={"name": "drawing.png", "type": "image/png", "size": 2048},
        asset=f"{workspace.id}/project-drawing.png",
        size=2048,
        workspace=workspace,
        project=project,
        created_by=create_user,
        entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
        is_uploaded=True,
        storage_metadata={"size": 2048},
    )


@pytest.mark.contract
class TestAssetJsonResponse:
    @pytest.mark.django_db
    def test_workspace_asset_json_response(self, session_client, workspace, workspace_drawing_asset):
        with mock.patch(S3_STORAGE_PATH) as mock_storage:
            mock_storage.return_value.generate_presigned_url.return_value = SIGNED_URL
            response = session_client.get(
                f"/api/assets/v2/workspaces/{workspace.slug}/{workspace_drawing_asset.id}/?response=json"
            )

        assert response.status_code == status.HTTP_200_OK
        assert response.json() == {
            "asset_id": str(workspace_drawing_asset.id),
            "asset_url": SIGNED_URL,
            "asset_name": "drawing.png",
            "asset_type": "image/png",
        }

    @pytest.mark.django_db
    def test_workspace_asset_still_redirects_by_default(self, session_client, workspace, workspace_drawing_asset):
        with mock.patch(S3_STORAGE_PATH) as mock_storage:
            mock_storage.return_value.generate_presigned_url.return_value = SIGNED_URL
            response = session_client.get(f"/api/assets/v2/workspaces/{workspace.slug}/{workspace_drawing_asset.id}/")

        assert response.status_code == status.HTTP_302_FOUND
        assert response["Location"] == SIGNED_URL

    @pytest.mark.django_db
    def test_project_asset_json_response(self, session_client, workspace, project, project_drawing_asset):
        with mock.patch(S3_STORAGE_PATH) as mock_storage:
            mock_storage.return_value.generate_presigned_url.return_value = SIGNED_URL
            response = session_client.get(
                f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{project_drawing_asset.id}/?response=json"
            )

        assert response.status_code == status.HTTP_200_OK
        assert response.json()["asset_url"] == SIGNED_URL
        assert response.json()["asset_id"] == str(project_drawing_asset.id)

    @pytest.mark.django_db
    def test_json_response_requires_uploaded_asset(self, session_client, workspace, workspace_drawing_asset):
        workspace_drawing_asset.is_uploaded = False
        workspace_drawing_asset.save(update_fields=["is_uploaded"])

        with mock.patch(S3_STORAGE_PATH):
            response = session_client.get(
                f"/api/assets/v2/workspaces/{workspace.slug}/{workspace_drawing_asset.id}/?response=json"
            )

        assert response.status_code == status.HTTP_404_NOT_FOUND
