# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests that exercise the external asset endpoints with the REAL
``S3Storage`` class (only the boto3 client is faked).

Regression coverage for ``S3Storage(request=..., is_server=True)`` raising
``TypeError`` because ``S3Storage.__init__`` did not accept ``is_server``.
"""

from unittest import mock

import pytest
from rest_framework import status

from plane.db.models import FileAsset
from plane.settings.storage import S3Storage

INTERNAL_ENDPOINT = "http://plane-minio:9000"


@pytest.fixture
def fake_boto_client():
    """Patch boto3.client so the real S3Storage builds a fake client."""
    client = mock.MagicMock()
    client.generate_presigned_url.return_value = "https://signed.example/drawing.png?sig=1"
    client.generate_presigned_post.return_value = {"url": "https://signed.example/", "fields": {"key": "k"}}
    with mock.patch("plane.settings.storage.boto3.client", return_value=client) as factory:
        yield factory, client


@pytest.fixture
def drawing_asset(db, workspace, create_user):
    """An uploaded Excalidraw drawing (PNG with embedded scene) on a page."""
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


@pytest.mark.contract
class TestGenericAssetRealStorage:
    def detail_url(self, slug, asset_id):
        return f"/api/v1/workspaces/{slug}/assets/{asset_id}/"

    def list_url(self, slug):
        return f"/api/v1/workspaces/{slug}/assets/"

    @pytest.mark.django_db
    def test_get_returns_presigned_url_without_type_error(
        self, api_key_client, workspace, drawing_asset, fake_boto_client
    ):
        _, client = fake_boto_client
        response = api_key_client.get(self.detail_url(workspace.slug, drawing_asset.id))

        assert response.status_code == status.HTTP_200_OK, f"Got {response.status_code}: {response.data!r}"
        assert response.data["asset_id"] == str(drawing_asset.id)
        assert response.data["asset_url"] == "https://signed.example/drawing.png?sig=1"
        assert response.data["asset_name"] == "drawing.png"
        assert response.data["asset_type"] == "image/png"

        params = client.generate_presigned_url.call_args.kwargs["Params"]
        assert params["Key"] == drawing_asset.asset.name
        # PNG is not script-capable, so it is served inline
        assert params["ResponseContentDisposition"].startswith("inline")

    @pytest.mark.django_db
    def test_post_returns_upload_data_without_type_error(self, api_key_client, workspace, fake_boto_client):
        payload = {"name": "drawing.png", "type": "image/png", "size": 2048}
        response = api_key_client.post(self.list_url(workspace.slug), payload, format="json")

        assert response.status_code == status.HTTP_200_OK, f"Got {response.status_code}: {response.data!r}"
        assert response.data["upload_data"] == {"url": "https://signed.example/", "fields": {"key": "k"}}
        assert FileAsset.objects.filter(id=response.data["asset_id"], workspace=workspace).exists()

    @pytest.mark.django_db
    def test_user_server_asset_post_without_type_error(self, api_key_client, fake_boto_client):
        payload = {"name": "avatar.png", "type": "image/png", "size": 1024, "entity_type": "USER_AVATAR"}
        response = api_key_client.post("/api/v1/assets/user-assets/server/", payload, format="json")

        assert response.status_code == status.HTTP_200_OK, f"Got {response.status_code}: {response.data!r}"
        assert "upload_data" in response.data


@pytest.mark.contract
class TestS3StorageIsServer:
    """``is_server`` selects the configured (internal) MinIO endpoint instead of
    the request host, mirroring the upstream behaviour."""

    def _endpoint(self, factory):
        return factory.call_args.kwargs["endpoint_url"]

    def test_signature_accepts_is_server(self, fake_boto_client):
        S3Storage(is_server=True)
        S3Storage(request=None, is_server=False)

    def test_minio_request_host_used_by_default(self, fake_boto_client, monkeypatch, rf):
        factory, _ = fake_boto_client
        monkeypatch.setenv("USE_MINIO", "1")
        monkeypatch.delenv("MINIO_ENDPOINT_SSL", raising=False)
        monkeypatch.setenv("AWS_S3_ENDPOINT_URL", INTERNAL_ENDPOINT)
        request = rf.get("/", HTTP_HOST="plane.example.com")

        S3Storage(request=request)

        assert self._endpoint(factory) == "http://plane.example.com"

    def test_minio_is_server_uses_internal_endpoint(self, fake_boto_client, monkeypatch, rf):
        factory, _ = fake_boto_client
        monkeypatch.setenv("USE_MINIO", "1")
        monkeypatch.setenv("AWS_S3_ENDPOINT_URL", INTERNAL_ENDPOINT)
        request = rf.get("/", HTTP_HOST="plane.example.com")

        S3Storage(request=request, is_server=True)

        assert self._endpoint(factory) == INTERNAL_ENDPOINT

    def test_non_minio_ignores_is_server(self, fake_boto_client, monkeypatch, rf):
        factory, _ = fake_boto_client
        monkeypatch.setenv("USE_MINIO", "0")
        monkeypatch.setenv("AWS_S3_ENDPOINT_URL", INTERNAL_ENDPOINT)
        request = rf.get("/", HTTP_HOST="plane.example.com")

        S3Storage(request=request, is_server=True)

        assert self._endpoint(factory) == INTERNAL_ENDPOINT
