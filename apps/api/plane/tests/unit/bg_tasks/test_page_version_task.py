# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Unit tests for track_page_version.

Page.description was renamed to description_json (migration 0117) but the task
kept reading ``page.description``; the AttributeError was swallowed by the
task's broad except, so no PageVersion rows were ever written.
"""

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from plane.bgtasks.page_version_task import track_page_version
from plane.db.models import Page, PageVersion
from plane.tests.factories import UserFactory, WorkspaceFactory


DESCRIPTION_JSON = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}]}


def _existing(html):
    return json.dumps({"description_html": html})


@pytest.fixture
def page(db):
    owner = UserFactory()
    workspace = WorkspaceFactory(owner=owner)
    return Page.objects.create(
        workspace=workspace,
        owned_by=owner,
        name="Versioned",
        description_html="<p>hi</p>",
        description_json=DESCRIPTION_JSON,
        description_binary=b"\x01\x02\x03\x04",
    )


@pytest.mark.unit
class TestTrackPageVersion:
    @pytest.mark.django_db
    def test_creates_version_with_description_json(self, page):
        track_page_version(page_id=page.id, existing_instance=_existing("<p></p>"), user_id=page.owned_by_id)

        versions = PageVersion.objects.filter(page=page)
        assert versions.count() == 1
        version = versions.get()
        assert version.description_json == DESCRIPTION_JSON
        assert version.description_html == "<p>hi</p>"
        assert bytes(version.description_binary) == b"\x01\x02\x03\x04"
        assert version.owned_by_id == page.owned_by_id

    @pytest.mark.django_db
    def test_unchanged_html_creates_no_version(self, page):
        track_page_version(page_id=page.id, existing_instance=_existing("<p>hi</p>"), user_id=page.owned_by_id)

        assert not PageVersion.objects.filter(page=page).exists()

    @pytest.mark.django_db
    def test_second_save_within_window_merges(self, page):
        track_page_version(page_id=page.id, existing_instance=_existing("<p></p>"), user_id=page.owned_by_id)

        new_json = {"type": "doc", "content": []}
        page.description_html = "<p>hi again</p>"
        page.description_json = new_json
        page.save()
        track_page_version(page_id=page.id, existing_instance=_existing("<p>hi</p>"), user_id=page.owned_by_id)

        versions = PageVersion.objects.filter(page=page)
        assert versions.count() == 1
        assert versions.get().description_json == new_json
        assert versions.get().description_html == "<p>hi again</p>"

    @pytest.mark.django_db
    def test_versions_are_trimmed_to_twenty(self, page):
        old = timezone.now() - timedelta(days=1)
        for i in range(20):
            PageVersion.objects.create(
                workspace=page.workspace,
                page=page,
                owned_by=page.owned_by,
                description_html=f"<p>{i}</p>",
                last_saved_at=old + timedelta(seconds=i),
            )
        oldest = PageVersion.objects.filter(page=page).order_by("last_saved_at").first()

        track_page_version(page_id=page.id, existing_instance=_existing("<p></p>"), user_id=page.owned_by_id)

        versions = PageVersion.objects.filter(page=page)
        assert versions.count() == 20
        assert not versions.filter(pk=oldest.pk).exists()
        assert versions.filter(description_json=DESCRIPTION_JSON).exists()
