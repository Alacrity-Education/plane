/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { pathKey } from "./paths";

/** Wiki.js locale prefixes in links (`/en/Projects/x`). */
const LOCALE_PREFIX = /^\/[a-z]{2}(?:-[a-z]{2})?\//i;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export type TLinkTarget =
  | { kind: "external"; href?: string }
  | { kind: "file"; path: string }
  | { kind: "anchor" }
  | { kind: "internal"; key: string; hash: string };

/**
 * Classifies a link of the page at `fromPath` (e.g. `Courses/E1`). Internal targets are
 * returned as normalized wiki keys (see `pathKey`), with the locale prefix and extension removed.
 */
export function parseLink(href: string, fromPath: string, knownKeys?: Set<string>): TLinkTarget {
  const trimmed = href.trim();
  if (!trimmed || EXTERNAL.test(trimmed)) return { kind: "external" };
  if (trimmed.startsWith("#")) return { kind: "anchor" };
  // `github.com/org/repo` written without a scheme
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|$)/i.test(trimmed) && !/\.(md|html)$/i.test(trimmed)) {
    return { kind: "external", href: `https://${trimmed}` };
  }
  const hashIndex = trimmed.search(/[?#]/);
  const hash = hashIndex >= 0 && trimmed[hashIndex] === "#" ? trimmed.slice(hashIndex) : "";
  let path = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  if (!path.startsWith("/")) {
    const base = fromPath.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "..") base.pop();
      else if (part && part !== ".") base.push(part);
    }
    path = `/${base.join("/")}`;
  }
  const last = path.split("/").pop() ?? "";
  if (/\.[a-z0-9]{2,5}$/i.test(last) && !/\.(md|html)$/i.test(last)) return { kind: "file", path };
  let key = pathKey(path.replace(/\.(md|html)$/i, ""));
  if (LOCALE_PREFIX.test(path)) {
    const withoutLocale = pathKey(path.replace(LOCALE_PREFIX, "/").replace(/\.(md|html)$/i, ""));
    if (!knownKeys || !knownKeys.has(key)) key = withoutLocale;
  }
  return { kind: "internal", key, hash };
}

export type TLinkResolver = {
  resolve: (href: string) => string | null;
  /** Internal page links whose target was not migrated. */
  unresolved: string[];
  /** Links to repository files that are not pages (downloads, images). */
  files: string[];
};

/**
 * Builds the converter's link callback: internal links to a migrated page become the Plane
 * page URL `/<slug>/wiki/<page id>`; unresolved internal links are dropped (text kept).
 */
export function createLinkResolver(args: {
  fromPath: string;
  workspaceSlug: string;
  pageIds: Map<string, string>;
}): TLinkResolver {
  const known = new Set(args.pageIds.keys());
  const unresolved: string[] = [];
  const files: string[] = [];
  return {
    unresolved,
    files,
    resolve: (href: string) => {
      const target = parseLink(href, args.fromPath, known);
      if (target.kind === "external") return target.href ?? href;
      if (target.kind === "anchor") return href;
      if (target.kind === "file") {
        files.push(target.path);
        return null;
      }
      const id = args.pageIds.get(target.key);
      if (!id) {
        unresolved.push(href);
        return null;
      }
      return `/${args.workspaceSlug}/wiki/${id}`;
    },
  };
}
