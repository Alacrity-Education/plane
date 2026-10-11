# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Unit tests for the HTML sanitizer allow-list of editor components."""

import pytest
from bs4 import BeautifulSoup

from plane.utils.content_validator import ALLOWED_TAGS, ATTRIBUTES, validate_html_content

DRAWING_ID = "6c1f5f5e-6b77-4a3c-9a7b-2b6d1f0e8a11"
ASSET_ID = "3f0b6c2e-1d4a-4b8e-9c55-7a2f9e3d1b20"

EXCALIDRAW_HTML = (
    f'<excalidraw-component id="{DRAWING_ID}" src="{ASSET_ID}" width="100%" height="auto" '
    'aspectratio="1.5" alignment="left" status="uploaded"></excalidraw-component>'
)


def _clean(html):
    is_valid, error, clean_html = validate_html_content(html)
    assert is_valid, error
    return clean_html


def _first(html, tag):
    return BeautifulSoup(html, "html.parser").find(tag)


@pytest.mark.unit
class TestExcalidrawComponentSanitization:
    def test_allow_list_entries(self):
        assert "excalidraw-component" in ALLOWED_TAGS
        assert ATTRIBUTES["excalidraw-component"] == {
            "id",
            "src",
            "width",
            "height",
            "aspectRatio",
            "aspectratio",
            "alignment",
            "status",
        }

    def test_component_survives_byte_for_byte(self):
        assert _clean(EXCALIDRAW_HTML) == EXCALIDRAW_HTML

    def test_component_inside_document_survives(self):
        html = f"<p>before</p>{EXCALIDRAW_HTML}<p>after</p>"
        assert _clean(html) == html

    def test_camel_case_aspect_ratio_is_kept(self):
        html = f'<excalidraw-component id="{DRAWING_ID}" src="{ASSET_ID}" aspectRatio="2"></excalidraw-component>'
        element = _first(_clean(html), "excalidraw-component")
        # html5ever lowercases attribute names; the value must survive either way
        assert element.get("aspectratio") == "2"

    def test_unlisted_attributes_are_stripped(self):
        html = (
            f'<excalidraw-component id="{DRAWING_ID}" src="{ASSET_ID}" onload="alert(1)" '
            'data-evil="x" onerror="alert(2)"></excalidraw-component>'
        )
        element = _first(_clean(html), "excalidraw-component")
        assert element is not None
        assert element.get("src") == ASSET_ID
        assert element.get("id") == DRAWING_ID
        for attr in ("onload", "data-evil", "onerror"):
            assert element.get(attr) is None

    def test_script_inside_is_removed(self):
        html = (
            f'<excalidraw-component id="{DRAWING_ID}" src="{ASSET_ID}"><script>alert(1)</script></excalidraw-component>'
        )
        cleaned = _clean(html)
        assert "<script" not in cleaned
        assert "alert(1)" not in cleaned
        assert _first(cleaned, "excalidraw-component").get("src") == ASSET_ID


@pytest.mark.unit
class TestOtherEditorComponentsSanitization:
    def test_image_component_survives(self):
        html = (
            f'<image-component id="{DRAWING_ID}" src="{ASSET_ID}" width="35px" height="auto" '
            'aspectratio="1" alignment="center" status="uploaded"></image-component>'
        )
        assert _clean(html) == html

    def test_mention_component_survives(self):
        html = (
            f'<mention-component id="{DRAWING_ID}" entity_identifier="{ASSET_ID}" '
            'entity_name="user_mention"></mention-component>'
        )
        assert _clean(html) == html

    def test_issue_embed_component_survives(self):
        assert "issue-embed-component" in ALLOWED_TAGS
        html = (
            f'<issue-embed-component entity_identifier="{ASSET_ID}" project_identifier="{DRAWING_ID}" '
            f'workspace_identifier="{DRAWING_ID}" id="{DRAWING_ID}" entity_name="issue"></issue-embed-component>'
        )
        assert _clean(html) == html

    def test_issue_embed_component_strips_unlisted_attributes(self):
        html = f'<issue-embed-component entity_identifier="{ASSET_ID}" onclick="x()"></issue-embed-component>'
        element = _first(_clean(html), "issue-embed-component")
        assert element.get("entity_identifier") == ASSET_ID
        assert element.get("onclick") is None
