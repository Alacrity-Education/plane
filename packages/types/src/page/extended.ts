/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * @description extra page fields used by workspace level (wiki) pages
 */
export type TPageExtended = {
  parent?: string | null;
  is_global?: boolean;
  sort_order?: number;
  sub_pages_count?: number;
  // read only, set only on the root page of a project wiki section
  project_wiki?: TPageProjectWiki | null;
};

/**
 * @description project a wiki page is the section root of ("Wiki › Projects › PROJ")
 */
export type TPageProjectWiki = {
  project_id: string;
  identifier: string;
  name: string;
};

/**
 * @description per-project wiki section: a top level wiki page linked to a project
 */
export type TProjectWikiSection = {
  id: string;
  project: string;
  project_identifier: string;
  project_name: string;
  root_page: string;
  root_page_name: string;
  created_at: string;
};
