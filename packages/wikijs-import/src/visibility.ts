/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TVisibility, TWikiMeta } from "./types";

/** Top-level folders whose pages are published to the docs site by default. */
export const PUBLIC_FOLDERS = new Set(["courses", "infrastructure"]);
/** Top-level folders whose pages stay internal unless tagged `public`. */
export const PRIVATE_FOLDERS = new Set(["projects", "activities", "meetings", "guides"]);
/** Top-level folders whose pages are for workspace admins only, whatever their tags or flags. */
export const ADMIN_FOLDERS = new Set(["board"]);

/** Plane page access levels used by the importer (see `Page` in the API). */
export const PLANE_ACCESS = { public: 0, admins: 2, members: 3 } as const;

/**
 * Plane access of a visibility: public pages are visible to every workspace member (and published),
 * Wiki.js-private pages to admins and members (never guests), Board pages to admins only.
 */
export function planeAccessFor(visibility: TVisibility): number {
  if (visibility === "public") return PLANE_ACCESS.public;
  if (visibility === "admins") return PLANE_ACCESS.admins;
  return PLANE_ACCESS.members;
}

/** Name of the Plane access level of a visibility, as shown in the dry run and the report. */
export function accessLabel(visibility: TVisibility): "public" | "members" | "admins" {
  if (visibility === "public") return "public";
  if (visibility === "admins") return "admins";
  return "members";
}

export type TVisibilityResult = { visibility: TVisibility; reason: string; unknownFolder?: boolean };

/**
 * Resolves the Wiki.js visibility of a page or folder.
 * @param segments path segments of the page (or folder) itself
 * @param isFolder whether the path names a folder (its own first segment is the top folder)
 * @param meta front matter of the page, or of a folder's auxiliary page
 */
export function resolveVisibility(segments: string[], isFolder: boolean, meta?: TWikiMeta): TVisibilityResult {
  const inFolder = isFolder ? segments.length >= 1 : segments.length > 1;
  const top = (segments[0] ?? "").replace(/\s+/g, "").toLowerCase();
  // The Board folder (and its folder page) is admins-only: neither the public tag nor flags open it
  if (inFolder && ADMIN_FOLDERS.has(top)) return { visibility: "admins", reason: `/${segments[0]}/ is admins-only` };

  if (meta?.published === false) return { visibility: "private", reason: "published: false" };
  if (!inFolder) return { visibility: "public", reason: "root page" };

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
