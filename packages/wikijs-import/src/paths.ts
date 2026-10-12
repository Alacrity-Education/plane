/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Decodes `%20`-style escapes in one path segment, leaving malformed escapes alone. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Comparison key for one segment: decoded, without whitespace, lowercase. */
export function segmentKey(segment: string): string {
  return decodeSegment(segment).replace(/\s+/g, "").toLowerCase();
}

/** Comparison key for a wiki path (`Courses/Airbox%20Online%20Bootcamp/E2` → `courses/airboxonlinebootcamp/e2`). */
export function pathKey(path: string): string {
  return path.split("/").filter(Boolean).map(segmentKey).join("/");
}
