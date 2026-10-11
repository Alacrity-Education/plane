/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Row of GET /api/v1/workspaces/<slug>/wiki/pages/ */
export type TWikiPageSummary = {
  id: string;
  name: string;
  parent: string | null;
  sort_order: number;
  access?: number;
  is_locked?: boolean;
  archived_at?: string | null;
  logo_props?: Record<string, unknown> | null;
  color?: string | null;
  owned_by?: string | null;
  label_ids?: string[];
  sub_pages_count?: number;
  description_stripped?: string | null;
  created_at?: string;
  updated_at: string;
  workspace?: string;
};

export type TWikiAsset = {
  id: string;
  name?: string | null;
  type?: string | null;
  size?: number | null;
};

/** Body of GET /api/v1/workspaces/<slug>/wiki/pages/<id>/ */
export type TWikiPageDetail = TWikiPageSummary & {
  description_html: string | null;
  assets?: TWikiAsset[];
};

/** Standard Plane v1 cursor envelope (plane/utils/paginator.py BasePaginator.paginate). */
export type TPaginatedResponse<T> = {
  results: T[];
  next_cursor?: string;
  prev_cursor?: string;
  next_page_results?: boolean;
  prev_page_results?: boolean;
  total_count?: number;
  count?: number;
  total_pages?: number;
  total_results?: number;
};

/** Body of GET /api/v1/workspaces/<slug>/assets/<asset_id>/ (GenericAssetEndpoint.get). */
export type TAssetUrlResponse = {
  asset_id: string;
  asset_url: string;
  asset_name?: string;
  asset_type?: string;
};

export type TWikiMember = {
  id: string;
  display_name: string;
};

export type TDownloadedFile = {
  data: Uint8Array;
  contentType: string | null;
};

/** Everything the sync pipeline needs from Plane; implemented by the HTTP client and the fixture client. */
export interface IWikiSource {
  listPages(): Promise<TWikiPageSummary[]>;
  getPage(pageId: string): Promise<TWikiPageDetail>;
  getAssetUrl(assetId: string): Promise<TAssetUrlResponse>;
  download(url: string): Promise<TDownloadedFile>;
  /** Best effort: returns [] when the token may not list members (bot users are usually guests). */
  listMembers(): Promise<TWikiMember[]>;
}

export type TCalloutMode = "admonition" | "html";

export type TLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};
