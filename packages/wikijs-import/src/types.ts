/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TPageFormat = "markdown" | "html";

/** Wiki.js page metadata (front matter of a git-sync file). */
export type TWikiMeta = {
  title?: string;
  description?: string;
  published?: boolean;
  date?: string;
  tags: string[];
  editor?: string;
  dateCreated?: string;
};

/** One page file of the Wiki.js repository. */
export type TSourcePage = {
  /** Path relative to the repository root, e.g. `Courses/kicad-ecad.md`. */
  file: string;
  /** Wiki path without extension, segments decoded, e.g. `Courses/kicad-ecad`. */
  path: string;
  /** Normalized key used for matching (lowercase, no spaces), e.g. `courses/kicad-ecad`. */
  key: string;
  format: TPageFormat;
  meta: TWikiMeta;
  body: string;
};

export type TVisibility = "public" | "private";

export type TTreeNode = {
  /** Normalized key (see TSourcePage.key). */
  key: string;
  /** Display path, e.g. `Courses/AirboxOnlineBootcamp`. */
  path: string;
  title: string;
  isFolder: boolean;
  /** Page content; for a folder the auxiliary page with the folder's path, if any. */
  source?: TSourcePage | undefined;
  children: TTreeNode[];
  parent?: TTreeNode | undefined;
  visibility: TVisibility;
  visibilityReason: string;
  sortOrder: number;
};

export type TWarning = {
  path: string;
  message: string;
};
