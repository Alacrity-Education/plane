/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { pathKey } from "./paths";
import type { TSourcePage, TTreeNode, TWarning } from "./types";
import { accessLabel, resolveVisibility } from "./visibility";

export const SORT_ORDER_STEP = 1000;

export type TWikiTree = {
  roots: TTreeNode[];
  /** Every node by normalized key. */
  nodes: Map<string, TTreeNode>;
};

type TFolderDraft = { key: string; segments: string[][]; node: TTreeNode };

/** Prefers the human-readable spelling of a folder segment (`Airbox Online Bootcamp` over `AirboxOnlineBootcamp`). */
function pickSegment(variants: string[]): string {
  return variants.find((v) => /\s/.test(v)) ?? variants[0] ?? "";
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function compareTitles(a: TTreeNode, b: TTreeNode): number {
  return collator.compare(a.title, b.title) || collator.compare(a.path, b.path);
}

function sortChildren(nodes: TTreeNode[], isRoot: boolean): void {
  nodes.sort((a, b) => {
    // The wiki home page leads the top level
    if (isRoot && a.key === "home") return -1;
    if (isRoot && b.key === "home") return 1;
    return compareTitles(a, b);
  });
  nodes.forEach((node, index) => {
    node.sortOrder = (index + 1) * SORT_ORDER_STEP;
    sortChildren(node.children, false);
  });
}

/**
 * Builds the Plane page tree from Wiki.js pages: every folder becomes a page (named by its
 * auxiliary page's title when one exists), every page a child of its folder.
 */
export function buildTree(pages: TSourcePage[], warnings: TWarning[]): TWikiTree {
  const folders = new Map<string, TFolderDraft>();
  const nodes = new Map<string, TTreeNode>();
  const roots: TTreeNode[] = [];

  const ensureFolder = (segments: string[]): TFolderDraft => {
    const key = pathKey(segments.join("/"));
    let draft = folders.get(key);
    if (!draft) {
      const parent = segments.length > 1 ? ensureFolder(segments.slice(0, -1)).node : undefined;
      const node: TTreeNode = {
        key,
        path: segments.join("/"),
        title: segments[segments.length - 1] ?? key,
        isFolder: true,
        children: [],
        parent,
        visibility: "private",
        visibilityReason: "",
        sortOrder: 0,
      };
      if (parent) parent.children.push(node);
      else roots.push(node);
      draft = { key, segments: [], node };
      folders.set(key, draft);
      nodes.set(key, node);
    }
    draft.segments.push(segments);
    return draft;
  };

  for (const page of pages) {
    const segments = page.path.split("/");
    for (let i = 1; i < segments.length; i++) ensureFolder(segments.slice(0, i));
  }

  // Folder names: the readable variant of each segment, per level
  for (const draft of folders.values()) {
    const last = draft.segments.map((s) => s[s.length - 1] ?? "");
    const segment = pickSegment(last);
    const parentPath = draft.node.parent?.path;
    draft.node.path = parentPath ? `${parentPath}/${segment}` : segment;
    draft.node.title = segment;
  }

  for (const page of pages) {
    const folder = folders.get(page.key);
    if (folder) {
      // Auxiliary page: names the folder and provides its content
      folder.node.source = page;
      if (page.meta.title) folder.node.title = page.meta.title;
      continue;
    }
    const segments = page.path.split("/");
    const parent = segments.length > 1 ? folders.get(pathKey(segments.slice(0, -1).join("/")))?.node : undefined;
    const node: TTreeNode = {
      key: page.key,
      path: page.path,
      title: page.meta.title?.trim() || (segments[segments.length - 1] ?? page.path),
      isFolder: false,
      source: page,
      children: [],
      parent,
      visibility: "private",
      visibilityReason: "",
      sortOrder: 0,
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    nodes.set(node.key, node);
  }

  for (const node of nodes.values()) {
    const segments = node.path.split("/");
    const result = resolveVisibility(segments, node.isFolder, node.source?.meta);
    node.visibility = result.visibility;
    node.visibilityReason = result.reason;
    if (result.unknownFolder && !node.parent) {
      warnings.push({ path: node.path, message: `folder /${segments[0]}/ has no visibility rule; treated as private` });
    }
  }

  sortChildren(roots, true);
  return { roots, nodes };
}

/** Depth-first (parents before children) list of the tree. */
export function flattenTree(roots: TTreeNode[]): TTreeNode[] {
  const out: TTreeNode[] = [];
  const visit = (node: TTreeNode) => {
    out.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

/** Text rendering of the tree for `--dry-run`. */
export function renderTree(roots: TTreeNode[]): string[] {
  const lines: string[] = [];
  const visit = (node: TTreeNode, depth: number) => {
    const marker = `[${accessLabel(node.visibility)}]`.padEnd(9);
    const kind = node.isFolder ? `${node.title}/${node.source ? "" : " (folder only)"}` : node.title;
    lines.push(`${"  ".repeat(depth)}${marker} ${kind}  — ${node.path} (${node.visibilityReason})`);
    node.children.forEach((child) => visit(child, depth + 1));
  };
  roots.forEach((node) => visit(node, 0));
  return lines;
}
