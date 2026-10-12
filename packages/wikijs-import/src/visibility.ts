/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TVisibility, TWikiMeta } from "./types";

/** Top-level folders whose pages are published to the docs site by default. */
export const PUBLIC_FOLDERS = new Set(["courses", "infrastructure"]);
/** Top-level folders whose pages stay internal unless tagged `public`. */
export const PRIVATE_FOLDERS = new Set(["projects", "activities", "meetings", "guides", "board"]);

export type TVisibilityResult = { visibility: TVisibility; reason: string; unknownFolder?: boolean };

/**
 * Resolves the Wiki.js visibility of a page or folder.
 * @param segments path segments of the page (or folder) itself
 * @param isFolder whether the path names a folder (its own first segment is the top folder)
 * @param meta front matter of the page, or of a folder's auxiliary page
 */
export function resolveVisibility(segments: string[], isFolder: boolean, meta?: TWikiMeta): TVisibilityResult {
  if (meta?.published === false) return { visibility: "private", reason: "published: false" };

  const inFolder = isFolder ? segments.length >= 1 : segments.length > 1;
  if (!inFolder) return { visibility: "public", reason: "root page" };

  const top = (segments[0] ?? "").replace(/\s+/g, "").toLowerCase();
  if (PUBLIC_FOLDERS.has(top)) return { visibility: "public", reason: `/${segments[0]}/ is public` };

  const hasPublicTag = meta?.tags.some((tag) => tag.toLowerCase() === "public") ?? false;
  if (PRIVATE_FOLDERS.has(top)) {
    return hasPublicTag
      ? { visibility: "public", reason: "tag public" }
      : { visibility: "private", reason: `/${segments[0]}/ is private` };
  }
  // Folders not covered by the rules: keep them internal unless explicitly tagged.
  return hasPublicTag
    ? { visibility: "public", reason: "tag public" }
    : { visibility: "private", reason: `/${segments[0]}/ has no rule (default private)`, unknownFolder: true };
}
