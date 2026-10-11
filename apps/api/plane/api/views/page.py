# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import uuid
from datetime import datetime, time, timezone as dt_timezone

# Django imports
from django.contrib.postgres.aggregates import ArrayAgg
from django.contrib.postgres.fields import ArrayField
from django.db.models import Count, Exists, OuterRef, Q, UUIDField, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

# Third party imports
from rest_framework import status
from rest_framework.response import Response
from drf_spectacular.utils import OpenApiResponse

# Module imports
from plane.api.serializers import WikiPageSerializer, WikiPageDetailSerializer
from plane.app.permissions import WorkspaceEntityPermission
from plane.db.models import Page, ProjectPage
from plane.utils.order_queryset import PAGE_ORDER_BY_ALLOWLIST, sanitize_order_by
from plane.utils.openapi import (
    wiki_page_docs,
    PAGE_ID_PARAMETER,
    CURSOR_PARAMETER,
    PER_PAGE_PARAMETER,
    ORDER_BY_PARAMETER,
    FIELDS_PARAMETER,
    UPDATED_SINCE_PARAMETER,
    PARENT_PARAMETER,
    INVALID_REQUEST_RESPONSE,
    create_paginated_response,
    WIKI_PAGE_EXAMPLE,
)
from .base import BaseAPIView


def _parse_updated_since(value):
    """Parse an ISO 8601 datetime (or bare date) into an aware datetime, or None if invalid."""
    # An unencoded '+' in a query string arrives as a space (e.g. "...T10:00:00 02:00").
    value = value.strip().replace(" ", "+")
    try:
        parsed = parse_datetime(value)
        if parsed is None:
            parsed_date = parse_date(value)
            if parsed_date is None:
                return None
            parsed = datetime.combine(parsed_date, time.min)
    except ValueError:
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, dt_timezone.utc)
    return parsed


class WikiPageBaseAPIEndpoint(BaseAPIView):
    """Shared scope for the read-only workspace wiki feed.

    Only public, non-archived workspace wiki pages (``is_global=True`` without a
    project link) are ever exposed, whoever owns the API token.
    """

    model = Page
    permission_classes = [WorkspaceEntityPermission]
    use_read_replica = True

    def get_queryset(self):
        return (
            Page.objects.filter(workspace__slug=self.kwargs.get("slug"))
            .filter(is_global=True, access=Page.PUBLIC_ACCESS, archived_at__isnull=True)
            .filter(~Exists(ProjectPage.objects.filter(page_id=OuterRef("pk"))))
            .annotate(
                sub_pages_count=Count(
                    "child_page",
                    filter=Q(
                        child_page__deleted_at__isnull=True,
                        child_page__archived_at__isnull=True,
                    ),
                    distinct=True,
                ),
                label_ids=Coalesce(
                    ArrayAgg(
                        "page_labels__label_id",
                        distinct=True,
                        filter=Q(
                            page_labels__deleted_at__isnull=True,
                            page_labels__label_id__isnull=False,
                        ),
                    ),
                    Value([], output_field=ArrayField(UUIDField())),
                ),
            )
        )


class WikiPageListAPIEndpoint(WikiPageBaseAPIEndpoint):
    """Wiki Page List Endpoint"""

    serializer_class = WikiPageSerializer

    @wiki_page_docs(
        operation_id="list_wiki_pages",
        summary="List wiki pages",
        description=(
            "Retrieve all public, non-archived pages of the workspace wiki as a flat list. "
            "Rebuild the tree from each page's `parent` and `sort_order`."
        ),
        parameters=[
            CURSOR_PARAMETER,
            PER_PAGE_PARAMETER,
            ORDER_BY_PARAMETER,
            FIELDS_PARAMETER,
            PARENT_PARAMETER,
            UPDATED_SINCE_PARAMETER,
        ],
        responses={
            200: create_paginated_response(
                WikiPageSerializer,
                "PaginatedWikiPageResponse",
                "Paginated list of wiki pages",
                "Paginated Wiki Pages",
            ),
            400: INVALID_REQUEST_RESPONSE,
        },
    )
    def get(self, request, slug):
        """List wiki pages

        Retrieve the public, non-archived pages of the workspace wiki.
        Supports filtering by parent page and by last update time.
        """
        pages = self.get_queryset()

        parent = request.GET.get("parent")
        if parent is not None:
            if parent.lower() in ("null", "none", ""):
                pages = pages.filter(parent__isnull=True)
            else:
                try:
                    pages = pages.filter(parent_id=uuid.UUID(parent))
                except ValueError:
                    return Response(
                        {"error": "parent must be a page ID or null"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

        updated_since = request.GET.get("updated_since")
        if updated_since:
            updated_since_value = _parse_updated_since(updated_since)
            if updated_since_value is None:
                return Response(
                    {"error": "updated_since must be an ISO 8601 datetime"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            pages = pages.filter(updated_at__gte=updated_since_value)

        order_by = sanitize_order_by(
            request.GET.get("order_by", "sort_order"),
            PAGE_ORDER_BY_ALLOWLIST,
            default="sort_order",
        )
        # `id` breaks ties so that cursor pages are stable for equal sort keys.
        pages = pages.order_by(order_by, "id")

        return self.paginate(
            request=request,
            queryset=pages,
            default_per_page=100,
            on_results=lambda results: WikiPageSerializer(results, many=True, fields=self.fields).data,
        )


class WikiPageDetailAPIEndpoint(WikiPageBaseAPIEndpoint):
    """Wiki Page Detail Endpoint"""

    serializer_class = WikiPageDetailSerializer

    @wiki_page_docs(
        operation_id="retrieve_wiki_page",
        summary="Retrieve wiki page",
        description=(
            "Retrieve a public, non-archived wiki page with its HTML body and the uploaded assets embedded in it."
        ),
        parameters=[
            PAGE_ID_PARAMETER,
            FIELDS_PARAMETER,
        ],
        responses={
            200: OpenApiResponse(
                description="Wiki page retrieved",
                response=WikiPageDetailSerializer,
                examples=[WIKI_PAGE_EXAMPLE],
            ),
        },
    )
    def get(self, request, slug, pk):
        """Retrieve wiki page

        Retrieve a public, non-archived wiki page including `description_html` and `assets`.
        """
        # `expand` is intentionally not honoured: the generic expansion map has no
        # page-aware serializers (it would render `parent` as a work item).
        serializer = WikiPageDetailSerializer(self.get_queryset().get(pk=pk), fields=self.fields)
        return Response(serializer.data, status=status.HTTP_200_OK)
