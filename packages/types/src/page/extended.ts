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
};
