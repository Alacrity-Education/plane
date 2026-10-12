/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { pathKey } from "./paths";
import type { TTreeNode } from "./types";

/** Key of the Wiki.js folder whose pages describe projects. */
export const PROJECTS_FOLDER_KEY = "projects";
/** Shortest name a prefix match may rely on (avoids "AB" swallowing everything). */
const MIN_PREFIX_LENGTH = 4;
const MAX_IDENTIFIER_LENGTH = 12;

export type TPlaneProject = { id: string; name: string; identifier: string };

export type TProjectMatch = {
  project: TPlaneProject;
  /** map = `--project-map`, exact = normalized equality, prefix = one name starts with the other. */
  via: "map" | "exact" | "prefix" | "created";
};

export type TMatchResult = { match: TProjectMatch | null; reason?: string };

/** Comparison form of a name: lowercase without spaces, hyphens, underscores or dots. */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/** Wiki.js pages that describe projects: the direct children of the `Projects/` folder. */
export function projectPageNodes(roots: TTreeNode[]): TTreeNode[] {
  return roots.find((node) => node.key === PROJECTS_FOLDER_KEY && node.isFolder)?.children ?? [];
}

/** Reads a `--project-map` object: Wiki.js path → project identifier or name, keyed by normalized path. */
export function parseProjectMap(raw: unknown): Map<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('project map must be a JSON object of { "<Wiki.js path>": "<project identifier or name>" }');
  }
  const map = new Map<string, string>();
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`project map: invalid value for ${path}`);
    map.set(pathKey(path.replace(/\.(md|html)$/i, "")), value.trim());
  }
  return map;
}

function findByNameOrIdentifier(value: string, projects: TPlaneProject[]): TPlaneProject[] {
  const wanted = normalizeName(value);
  const byIdentifier = projects.filter((p) => normalizeName(p.identifier) === wanted);
  if (byIdentifier.length) return byIdentifier;
  return projects.filter((p) => normalizeName(p.name) === wanted);
}

/**
 * Finds the Plane project a Wiki.js project page belongs to: the explicit map first, then the
 * page title or file slug against the project name or identifier (normalized), exact before prefix.
 */
export function matchProject(
  node: Pick<TTreeNode, "key" | "path" | "title">,
  projects: TPlaneProject[],
  map: Map<string, string> = new Map()
): TMatchResult {
  const mapped = map.get(node.key);
  if (mapped !== undefined) {
    const found = findByNameOrIdentifier(mapped, projects);
    if (found.length === 1 && found[0]) return { match: { project: found[0], via: "map" } };
    return {
      match: null,
      reason: found.length
        ? `project map value "${mapped}" is ambiguous`
        : `project map value "${mapped}" matches no project`,
    };
  }

  const slug = node.path.split("/").pop() ?? "";
  const candidates = [...new Set([normalizeName(node.title), normalizeName(slug)].filter(Boolean))];
  const keys = (p: TPlaneProject) => [normalizeName(p.name), normalizeName(p.identifier)].filter(Boolean);

  const exact = projects.filter((p) => keys(p).some((k) => candidates.includes(k)));
  if (exact.length === 1 && exact[0]) return { match: { project: exact[0], via: "exact" } };
  if (exact.length > 1) {
    return { match: null, reason: `matches several projects: ${exact.map((p) => p.identifier).join(", ")}` };
  }

  // Prefix: "WikiJS Fork" ↔ "WikiJS"; the longest shared name wins
  let best: { project: TPlaneProject; length: number }[] = [];
  for (const project of projects) {
    for (const key of keys(project)) {
      for (const candidate of candidates) {
        const shorter = key.length <= candidate.length ? key : candidate;
        const longer = shorter === key ? candidate : key;
        if (shorter.length < MIN_PREFIX_LENGTH || !longer.startsWith(shorter)) continue;
        if (!best.length || shorter.length > (best[0]?.length ?? 0)) best = [{ project, length: shorter.length }];
        else if (shorter.length === best[0]?.length && !best.some((b) => b.project.id === project.id)) {
          best.push({ project, length: shorter.length });
        }
      }
    }
  }
  if (best.length === 1 && best[0]) return { match: { project: best[0].project, via: "prefix" } };
  if (best.length > 1) {
    return { match: null, reason: `matches several projects: ${best.map((b) => b.project.identifier).join(", ")}` };
  }
  return { match: null };
}

/** Project identifier from a title: uppercase letters/digits, at most 12, unique among `taken`. */
export function deriveIdentifier(title: string, taken: Set<string>): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, MAX_IDENTIFIER_LENGTH) || "PROJECT";
  const upperTaken = new Set([...taken].map((t) => t.toUpperCase()));
  if (!upperTaken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, MAX_IDENTIFIER_LENGTH - suffix.length) + suffix;
    if (!upperTaken.has(candidate)) return candidate;
  }
  throw new Error(`cannot derive a unique identifier for ${title}`);
}

/** Plane rejects project names containing any of `&+,:;$^}{*=?@#|'<>.()%!-`. */
export function sanitizeProjectName(title: string): string {
  return (
    title
      .replace(/[&+,:;$^}{*=?@#|'<>.()%!-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 255) || "Project"
  );
}

/** Whether a page description has no real content (only empty paragraphs/whitespace). */
export function isEmptyDescription(html: string | null | undefined): boolean {
  if (!html) return true;
  if (/<(img|image-component|table|hr|pre|iframe|excalidraw|ul|ol)\b/i.test(html)) return false;
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;| /g, " ")
    .trim();
  return text === "";
}

export type TMergeTarget = "root" | "child";

/**
 * Where a Wiki.js project page goes in its project's wiki section: into the section root when
 * the root is already ours or still empty, otherwise as a child page of the root.
 */
export function decideMergeTarget(args: {
  /** Page the state maps this Wiki.js page to, if any. */
  statePageId?: string | undefined;
  /** Parent of that page in Plane, if it still exists. */
  statePageParent?: string | null | undefined;
  rootId: string;
  rootDescriptionHtml?: string | null | undefined;
  /** The root already holds another Wiki.js page's content. */
  rootClaimed: boolean;
}): TMergeTarget {
  if (args.statePageId === args.rootId) return "root";
  if (args.statePageId && args.statePageParent === args.rootId) return "child";
  if (!args.rootClaimed && isEmptyDescription(args.rootDescriptionHtml)) return "root";
  return "child";
}
