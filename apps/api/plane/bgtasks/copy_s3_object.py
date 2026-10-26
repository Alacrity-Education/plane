# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import uuid
import base64
import requests
from bs4 import BeautifulSoup

# Django imports
from django.conf import settings

# Module imports
from plane.db.models import FileAsset, Page, Issue
from plane.utils.exception_logger import log_exception
from plane.settings.storage import S3Storage
from celery import shared_task
from plane.utils.url import normalize_url_path
from plane.utils.uuid import is_valid_uuid


def get_entity_id_field(entity_type, entity_id):
    entity_mapping = {
        FileAsset.EntityTypeContext.WORKSPACE_LOGO: {"workspace_id": entity_id},
        FileAsset.EntityTypeContext.PROJECT_COVER: {"project_id": entity_id},
        FileAsset.EntityTypeContext.USER_AVATAR: {"user_id": entity_id},
        FileAsset.EntityTypeContext.USER_COVER: {"user_id": entity_id},
        FileAsset.EntityTypeContext.ISSUE_ATTACHMENT: {"issue_id": entity_id},
        FileAsset.EntityTypeContext.ISSUE_DESCRIPTION: {"issue_id": entity_id},
        FileAsset.EntityTypeContext.PAGE_DESCRIPTION: {"page_id": entity_id},
        FileAsset.EntityTypeContext.COMMENT_DESCRIPTION: {"comment_id": entity_id},
        FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION: {"draft_issue_id": entity_id},
    }
    return entity_mapping.get(entity_type, {})


# Editor components whose attributes reference FileAsset ids, per tag.
# `excalidraw-component.src` is the PNG (with the embedded scene) of a drawing.
ASSET_ATTRS = {
    "image-component": ["src"],
    "excalidraw-component": ["src"],
}


def extract_all_asset_ids(html, asset_attrs=None):
    """Return the asset ids referenced by any asset-bearing component, in
    document order and without duplicates."""
    asset_attrs = ASSET_ATTRS if asset_attrs is None else asset_attrs
    try:
        soup = BeautifulSoup(html or "", "html.parser")
        asset_ids = []
        for element in soup.find_all(list(asset_attrs.keys())):
            for attr in asset_attrs.get(element.name, []):
                value = element.get(attr)
                # Only uploaded assets carry a UUID src; external image URLs must not reach id__in
                if value and is_valid_uuid(value) and value not in asset_ids:
                    asset_ids.append(value)
        return asset_ids
    except Exception as e:
        log_exception(e)
        return []


def replace_all_asset_ids(html, duplicated_assets, asset_attrs=None):
    """Rewrite every asset-bearing attribute from old to new asset ids."""
    asset_attrs = ASSET_ATTRS if asset_attrs is None else asset_attrs
    try:
        id_map = {asset["old_asset_id"]: asset["new_asset_id"] for asset in duplicated_assets}
        soup = BeautifulSoup(html or "", "html.parser")
        for element in soup.find_all(list(asset_attrs.keys())):
            for attr in asset_attrs.get(element.name, []):
                value = element.get(attr)
                if value in id_map:
                    element[attr] = id_map[value]
        return str(soup)
    except Exception as e:
        log_exception(e)
        return html


def extract_asset_ids(html, tag):
    """Backwards-compatible single-tag wrapper around extract_all_asset_ids."""
    return extract_all_asset_ids(html, {tag: ASSET_ATTRS.get(tag, ["src"])})


def replace_asset_ids(html, tag, duplicated_assets):
    """Backwards-compatible single-tag wrapper around replace_all_asset_ids."""
    return replace_all_asset_ids(html, duplicated_assets, {tag: ASSET_ATTRS.get(tag, ["src"])})


def update_description(entity, duplicated_assets, tag=None):
    """Rewrite the entity's description_html with the duplicated asset ids.

    With ``tag=None`` every component in ASSET_ATTRS is rewritten.
    """
    if tag is None:
        updated_html = replace_all_asset_ids(entity.description_html, duplicated_assets)
    else:
        updated_html = replace_asset_ids(entity.description_html, tag, duplicated_assets)
    entity.description_html = updated_html
    entity.save()
    return updated_html


# Get the description binary and description from the live server
def sync_with_external_service(entity_name, description_html):
    try:
        data = {
            "description_html": description_html,
            "variant": "rich" if entity_name == "PAGE" else "document",
        }

        live_url = settings.LIVE_URL
        if not live_url:
            return {}

        url = normalize_url_path(f"{live_url}/convert-document/")

        response = requests.post(url, json=data, headers=None)
        if response.status_code == 200:
            return response.json()
    except requests.RequestException as e:
        log_exception(e)
    return {}


def copy_assets(entity, entity_identifier, project_id, asset_ids, user_id):
    duplicated_assets = []
    workspace = entity.workspace
    storage = S3Storage()
    # Ignore non-UUID src values (e.g. legacy external image URLs) so one bad
    # reference cannot make the whole lookup raise.
    valid_asset_ids = []
    for asset_id in asset_ids:
        try:
            valid_asset_ids.append(uuid.UUID(str(asset_id)))
        except ValueError:
            continue
    original_assets = FileAsset.objects.filter(workspace=workspace, project_id=project_id, id__in=valid_asset_ids)

    for original_asset in original_assets:
        destination_key = f"{workspace.id}/{uuid.uuid4().hex}-{original_asset.attributes.get('name')}"
        duplicated_asset = FileAsset.objects.create(
            attributes={
                "name": original_asset.attributes.get("name"),
                "type": original_asset.attributes.get("type"),
                "size": original_asset.attributes.get("size"),
            },
            asset=destination_key,
            size=original_asset.size,
            workspace=workspace,
            created_by_id=user_id,
            entity_type=original_asset.entity_type,
            project_id=project_id,
            storage_metadata=original_asset.storage_metadata,
            **get_entity_id_field(original_asset.entity_type, entity_identifier),
        )
        storage.copy_object(original_asset.asset, destination_key)
        duplicated_assets.append(
            {
                "new_asset_id": str(duplicated_asset.id),
                "old_asset_id": str(original_asset.id),
            }
        )
    if duplicated_assets:
        FileAsset.objects.filter(pk__in=[item["new_asset_id"] for item in duplicated_assets]).update(is_uploaded=True)

    return duplicated_assets


@shared_task
def copy_s3_objects_of_description_and_assets(entity_name, entity_identifier, project_id, slug, user_id):
    """
    Step 1: Extract asset ids from the description_html of the entity
    Step 2: Duplicate the assets
    Step 3: Update the description_html of the entity with the new asset ids (the src of image/excalidraw components)
    Step 4: Request the live server to generate the description_binary and description for the entity

    """
    try:
        model_class = {"PAGE": Page, "ISSUE": Issue}.get(entity_name)
        if not model_class:
            raise ValueError(f"Unsupported entity_name: {entity_name}")

        entity = model_class.objects.get(id=entity_identifier)
        asset_ids = extract_all_asset_ids(entity.description_html)

        duplicated_assets = copy_assets(entity, entity_identifier, project_id, asset_ids, user_id)

        updated_html = update_description(entity, duplicated_assets)

        external_data = sync_with_external_service(entity_name, updated_html)

        if external_data:
            entity.description_json = external_data.get("description_json")
            entity.description_binary = base64.b64decode(external_data.get("description_binary"))
            entity.save()

        return
    except Exception as e:
        log_exception(e)
        return []
