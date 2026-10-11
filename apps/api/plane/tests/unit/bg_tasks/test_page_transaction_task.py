# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""PageLog tracking of embedded components (images and Excalidraw drawings)."""

import uuid

import pytest

from plane.bgtasks.page_transaction_task import extract_all_components, page_transaction
from plane.db.models import Page, PageLog

DRAWING_NODE_ID = str(uuid.uuid4())
DRAWING_ASSET_ID = str(uuid.uuid4())
IMAGE_NODE_ID = str(uuid.uuid4())
IMAGE_ASSET_ID = str(uuid.uuid4())

DRAWING_HTML = (
    f'<excalidraw-component id="{DRAWING_NODE_ID}" src="{DRAWING_ASSET_ID}" width="100%" '
    'height="auto" aspectratio="1.5" alignment="left" status="uploaded"></excalidraw-component>'
)
IMAGE_HTML = f'<image-component id="{IMAGE_NODE_ID}" src="{IMAGE_ASSET_ID}"></image-component>'


@pytest.fixture
def page(db, workspace, create_user):
    return Page.objects.create(name="Drawing page", workspace=workspace, owned_by=create_user)


@pytest.mark.unit
class TestPageTransactionExcalidraw:
    def test_extracts_excalidraw_component(self):
        components = extract_all_components(f"<p>x</p>{DRAWING_HTML}")
        assert components["excalidraw-component"] == [{"id": DRAWING_NODE_ID, "src": DRAWING_ASSET_ID}]

    @pytest.mark.django_db
    def test_adding_drawing_creates_page_log(self, page):
        page_transaction(f"<p>hi</p>{DRAWING_HTML}", "<p>hi</p>", page.id)

        log = PageLog.objects.get(page_id=page.id, transaction=DRAWING_NODE_ID)
        assert log.entity_name == "excalidraw"
        assert str(log.entity_identifier) == DRAWING_ASSET_ID
        assert log.entity_type is None
        assert log.workspace_id == page.workspace_id

    @pytest.mark.django_db
    def test_drawing_and_image_tracked_independently(self, page):
        page_transaction(f"{IMAGE_HTML}{DRAWING_HTML}", None, page.id)

        names = dict(PageLog.objects.filter(page_id=page.id).values_list("entity_name", "entity_identifier"))
        assert {k: str(v) for k, v in names.items()} == {
            "image": IMAGE_ASSET_ID,
            "excalidraw": DRAWING_ASSET_ID,
        }

    @pytest.mark.django_db
    def test_removing_drawing_deletes_page_log(self, page):
        page_transaction(f"{IMAGE_HTML}{DRAWING_HTML}", None, page.id)
        assert PageLog.objects.filter(page_id=page.id).count() == 2

        page_transaction(IMAGE_HTML, f"{IMAGE_HTML}{DRAWING_HTML}", page.id)

        assert not PageLog.objects.filter(page_id=page.id, transaction=DRAWING_NODE_ID).exists()
        assert PageLog.objects.filter(page_id=page.id, transaction=IMAGE_NODE_ID, entity_name="image").exists()

    @pytest.mark.django_db
    def test_unchanged_drawing_is_not_duplicated(self, page):
        page_transaction(DRAWING_HTML, None, page.id)
        page_transaction(f"<p>edit</p>{DRAWING_HTML}", DRAWING_HTML, page.id)
        assert PageLog.objects.filter(page_id=page.id, transaction=DRAWING_NODE_ID).count() == 1
