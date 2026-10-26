# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import uuid

import pytest
from bs4 import BeautifulSoup
from django.test import override_settings
from plane.db.models import Project, ProjectMember, Issue, FileAsset, Page, ProjectPage
from unittest.mock import patch, MagicMock
from plane.bgtasks.copy_s3_object import (
    copy_s3_objects_of_description_and_assets,
    copy_assets,
    extract_all_asset_ids,
    extract_asset_ids,
    replace_all_asset_ids,
    replace_asset_ids,
)
import base64


@pytest.mark.unit
class TestCopyS3Objects:
    """Test the copy_s3_objects_of_description_and_assets function"""

    @pytest.fixture
    def project(self, create_user, workspace):
        project = Project.objects.create(name="Test Project", identifier="test-project", workspace=workspace)

        ProjectMember.objects.create(project=project, member=create_user)
        return project

    @pytest.fixture
    def issue(self, workspace, project):
        return Issue.objects.create(
            name="Test Issue",
            workspace=workspace,
            project_id=project.id,
            description_html='<div><image-component src="35e8b958-6ee5-43ce-ae56-fb0e776f421e"></image-component><image-component src="97988198-274f-4dfe-aa7a-4c0ffc684214"></image-component></div>',  # noqa: E501
        )

    @pytest.fixture
    def file_asset(self, workspace, project, issue):
        return FileAsset.objects.create(
            issue=issue,
            workspace=workspace,
            project=project,
            asset="workspace1/test-asset-1.jpg",
            attributes={
                "name": "test-asset-1.jpg",
                "size": 100,
                "type": "image/jpeg",
            },
            id="35e8b958-6ee5-43ce-ae56-fb0e776f421e",
            entity_type="ISSUE_DESCRIPTION",
        )

    @pytest.mark.django_db
    @patch("plane.bgtasks.copy_s3_object.S3Storage")
    def test_copy_s3_objects_of_description_and_assets(
        self, mock_s3_storage, create_user, workspace, project, issue, file_asset
    ):
        FileAsset.objects.create(
            issue=issue,
            workspace=workspace,
            project=project,
            asset="workspace1/test-asset-2.pdf",
            attributes={
                "name": "test-asset-2.pdf",
                "size": 100,
                "type": "application/pdf",
            },
            id="97988198-274f-4dfe-aa7a-4c0ffc684214",
            entity_type="ISSUE_DESCRIPTION",
        )

        issue.save()

        # Set up mock S3 storage
        mock_storage_instance = MagicMock()
        mock_s3_storage.return_value = mock_storage_instance

        # Mock the external service call to avoid actual HTTP requests
        with patch("plane.bgtasks.copy_s3_object.sync_with_external_service") as mock_sync:
            mock_sync.return_value = {
                "description": "test description",
                "description_binary": base64.b64encode(b"test binary").decode(),
                "description_json": {"type": "doc", "content": []},
            }

            # Call the actual function (not .delay())
            copy_s3_objects_of_description_and_assets("ISSUE", issue.id, project.id, "test-workspace", create_user.id)

        # Assert that copy_object was called for each asset
        assert mock_storage_instance.copy_object.call_count == 2

        # Get the updated issue and its new assets
        updated_issue = Issue.objects.get(id=issue.id)
        new_assets = FileAsset.objects.filter(
            issue=updated_issue,
            entity_type="ISSUE_DESCRIPTION",
        )

        # Verify new assets were created
        assert new_assets.count() == 4  # 2 original + 2 copied

    @pytest.mark.django_db
    @patch("plane.bgtasks.copy_s3_object.S3Storage")
    def test_copy_assets_successful(self, mock_s3_storage, workspace, project, issue, file_asset):
        """Test successful copying of assets"""
        # Arrange
        mock_storage_instance = MagicMock()
        mock_s3_storage.return_value = mock_storage_instance

        # Act
        result = copy_assets(
            entity=issue,
            entity_identifier=issue.id,
            project_id=project.id,
            asset_ids=[file_asset.id],
            user_id=issue.created_by_id,
        )

        # Assert
        # Verify S3 copy was called
        mock_storage_instance.copy_object.assert_called_once()

        # Verify new asset was created
        assert len(result) == 1
        new_asset_id = result[0]["new_asset_id"]
        new_asset = FileAsset.objects.get(id=new_asset_id)

        # Verify asset properties were copied correctly
        assert new_asset.workspace == workspace
        assert new_asset.project_id == project.id
        assert new_asset.entity_type == file_asset.entity_type
        assert new_asset.attributes == file_asset.attributes
        assert new_asset.size == file_asset.size
        assert new_asset.is_uploaded is True

    @pytest.mark.django_db
    @patch("plane.bgtasks.copy_s3_object.S3Storage")
    def test_copy_assets_empty_asset_ids(self, mock_s3_storage, workspace, project, issue):
        """Test copying with empty asset_ids list"""
        # Arrange
        mock_storage_instance = MagicMock()
        mock_s3_storage.return_value = mock_storage_instance

        # Act
        result = copy_assets(
            entity=issue,
            entity_identifier=issue.id,
            project_id=project.id,
            asset_ids=[],
            user_id=issue.created_by_id,
        )

        # Assert
        assert result == []
        mock_storage_instance.copy_object.assert_not_called()

    @pytest.mark.django_db
    @patch("plane.bgtasks.copy_s3_object.S3Storage")
    def test_copy_assets_nonexistent_asset(self, mock_s3_storage, workspace, project, issue):
        """Test copying with non-existent asset ID"""
        # Arrange
        mock_storage_instance = MagicMock()
        mock_s3_storage.return_value = mock_storage_instance
        non_existent_id = "00000000-0000-0000-0000-000000000000"

        # Act
        result = copy_assets(
            entity=issue,
            entity_identifier=issue.id,
            project_id=project.id,
            asset_ids=[non_existent_id],
            user_id=issue.created_by_id,
        )

        # Assert
        assert result == []
        mock_storage_instance.copy_object.assert_not_called()


IMAGE_ASSET_ID = "4a6e1c36-0d6b-4d0e-9a0e-0f9a3c1b2d11"
DRAWING_ASSET_ID = "8b1d2e47-5c3f-4e2a-b7d9-1c2b3a4d5e22"
DRAWING_NODE_ID = "c9e8d7f6-1a2b-4c3d-8e9f-0a1b2c3d4e33"


def _page_html():
    return (
        "<p>intro</p>"
        f'<image-component id="img-node" src="{IMAGE_ASSET_ID}" width="35px" status="uploaded"></image-component>'
        f'<excalidraw-component id="{DRAWING_NODE_ID}" src="{DRAWING_ASSET_ID}" width="100%" height="auto" '
        'aspectratio="1.5" alignment="left" status="uploaded"></excalidraw-component>'
    )


@pytest.mark.unit
class TestCopyPageAssets:
    """Page duplication copies both image and Excalidraw drawing assets."""

    @pytest.fixture
    def project(self, create_user, workspace):
        project = Project.objects.create(name="Wiki Project", identifier="WIKIP", workspace=workspace)
        ProjectMember.objects.create(project=project, member=create_user)
        return project

    def _create_pages_with_assets(self, workspace, user, project=None):
        original = Page.objects.create(
            name="Original", workspace=workspace, owned_by=user, description_html=_page_html()
        )
        for asset_id, key, mime in (
            (IMAGE_ASSET_ID, "photo.jpg", "image/jpeg"),
            (DRAWING_ASSET_ID, "drawing.png", "image/png"),
        ):
            FileAsset.objects.create(
                id=asset_id,
                page=original,
                workspace=workspace,
                project=project,
                asset=f"{workspace.id}/{key}",
                attributes={"name": key, "size": 100, "type": mime},
                size=100,
                entity_type=FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
                is_uploaded=True,
            )
        duplicate = Page.objects.create(
            name="Original (Copy)", workspace=workspace, owned_by=user, description_html=original.description_html
        )
        if project is not None:
            ProjectPage.objects.create(project=project, page=original, workspace=workspace)
            ProjectPage.objects.create(project=project, page=duplicate, workspace=workspace)
        return original, duplicate

    def _run_copy(self, duplicate, project_id, user):
        live_response = MagicMock(status_code=200)
        live_response.json.return_value = {
            "description_binary": base64.b64encode(b"yjs-binary").decode(),
            "description_json": {"type": "doc", "content": []},
        }
        with (
            patch("plane.bgtasks.copy_s3_object.S3Storage") as mock_s3_storage,
            patch("plane.bgtasks.copy_s3_object.requests.post", return_value=live_response) as mock_post,
            override_settings(LIVE_URL="http://live.test"),
        ):
            storage = MagicMock()
            mock_s3_storage.return_value = storage
            copy_s3_objects_of_description_and_assets("PAGE", duplicate.id, project_id, "test-workspace", user.id)
        return storage, mock_post

    def _assert_duplicated(self, original, duplicate, storage, mock_post, project_id):
        assert storage.copy_object.call_count == 2
        copied_sources = sorted(str(c.args[0]) for c in storage.copy_object.call_args_list)
        assert copied_sources == sorted([f"{original.workspace_id}/photo.jpg", f"{original.workspace_id}/drawing.png"])

        new_assets = FileAsset.objects.filter(page_id=duplicate.id)
        assert new_assets.count() == 2
        assert all(a.is_uploaded for a in new_assets)
        assert all(a.project_id == project_id for a in new_assets)
        assert all(a.entity_type == FileAsset.EntityTypeContext.PAGE_DESCRIPTION for a in new_assets)
        new_by_type = {a.attributes["type"]: str(a.id) for a in new_assets}
        assert set(new_by_type) == {"image/jpeg", "image/png"}

        # originals untouched
        assert FileAsset.objects.filter(page_id=original.id).count() == 2

        duplicate.refresh_from_db()
        soup = BeautifulSoup(duplicate.description_html, "html.parser")
        assert soup.find("image-component")["src"] == new_by_type["image/jpeg"]
        drawing = soup.find("excalidraw-component")
        assert drawing["src"] == new_by_type["image/png"]
        assert drawing["id"] == DRAWING_NODE_ID
        assert drawing["aspectratio"] == "1.5"
        assert IMAGE_ASSET_ID not in duplicate.description_html
        assert DRAWING_ASSET_ID not in duplicate.description_html

        # the rewritten HTML is what gets sent to the live server
        mock_post.assert_called_once()
        sent_html = mock_post.call_args.kwargs["json"]["description_html"]
        assert new_by_type["image/png"] in sent_html
        assert bytes(duplicate.description_binary) == b"yjs-binary"

    @pytest.mark.django_db
    def test_project_page_copies_image_and_drawing(self, create_user, workspace, project):
        original, duplicate = self._create_pages_with_assets(workspace, create_user, project)
        storage, mock_post = self._run_copy(duplicate, project.id, create_user)
        self._assert_duplicated(original, duplicate, storage, mock_post, project.id)

    @pytest.mark.django_db
    def test_workspace_wiki_page_copies_image_and_drawing(self, create_user, workspace):
        original, duplicate = self._create_pages_with_assets(workspace, create_user, project=None)
        storage, mock_post = self._run_copy(duplicate, None, create_user)
        self._assert_duplicated(original, duplicate, storage, mock_post, None)

    @pytest.mark.django_db
    def test_non_uuid_src_is_ignored(self, create_user, workspace):
        original, duplicate = self._create_pages_with_assets(workspace, create_user, project=None)
        duplicate.description_html += '<image-component src="https://example.com/x.png"></image-component>'
        duplicate.save()
        storage, _ = self._run_copy(duplicate, None, create_user)
        assert storage.copy_object.call_count == 2
        duplicate.refresh_from_db()
        assert 'src="https://example.com/x.png"' in duplicate.description_html


@pytest.mark.unit
class TestAssetIdHelpers:
    def test_extract_all_asset_ids_covers_both_components(self):
        assert extract_all_asset_ids(_page_html()) == [IMAGE_ASSET_ID, DRAWING_ASSET_ID]

    def test_extract_asset_ids_single_tag_wrapper(self):
        assert extract_asset_ids(_page_html(), "image-component") == [IMAGE_ASSET_ID]
        assert extract_asset_ids(_page_html(), "excalidraw-component") == [DRAWING_ASSET_ID]

    def test_extract_dedupes_and_handles_empty(self):
        html = _page_html() + f'<excalidraw-component src="{DRAWING_ASSET_ID}"></excalidraw-component>'
        assert extract_all_asset_ids(html) == [IMAGE_ASSET_ID, DRAWING_ASSET_ID]
        assert extract_all_asset_ids("") == []
        assert extract_all_asset_ids(None) == []

    def test_replace_all_asset_ids(self):
        mapping = [
            {"old_asset_id": IMAGE_ASSET_ID, "new_asset_id": "new-img"},
            {"old_asset_id": DRAWING_ASSET_ID, "new_asset_id": "new-drawing"},
        ]
        soup = BeautifulSoup(replace_all_asset_ids(_page_html(), mapping), "html.parser")
        assert soup.find("image-component")["src"] == "new-img"
        assert soup.find("excalidraw-component")["src"] == "new-drawing"

    def test_replace_asset_ids_single_tag_wrapper_only_touches_that_tag(self):
        mapping = [
            {"old_asset_id": IMAGE_ASSET_ID, "new_asset_id": "new-img"},
            {"old_asset_id": DRAWING_ASSET_ID, "new_asset_id": "new-drawing"},
        ]
        soup = BeautifulSoup(replace_asset_ids(_page_html(), "image-component", mapping), "html.parser")
        assert soup.find("image-component")["src"] == "new-img"
        assert soup.find("excalidraw-component")["src"] == DRAWING_ASSET_ID


@pytest.mark.unit
def test_extract_asset_ids_skips_external_urls():
    """External image srcs used to reach ``FileAsset.objects.filter(id__in=...)`` and
    raise "is not a valid UUID", aborting the whole asset copy on page duplicate."""
    asset_id = str(uuid.uuid4())
    html = (
        f'<image-component src="{asset_id}"></image-component>'
        '<image-component src="https://media.docs.plane.so/seed_assets/31.png"></image-component>'
        "<image-component></image-component>"
    )

    assert extract_asset_ids(html, "image-component") == [asset_id]
