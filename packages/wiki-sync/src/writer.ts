/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- ordered filesystem cleanup */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { TPageTreeNode } from "./tree";
import type { TWikiPageSummary } from "./types";

export const MANIFEST_VERSION = 1;

export type TManifestPage = {
  /** Doc file relative to the output dir, e.g. "engineering/index.md". */
  file: string;
  /** _category_.json relative to the output dir, for pages with children. */
  category?: string;
  updated_at: string;
  /** Asset file names (inside the assets dir) this page references. */
  assets: string[];
};

export type TManifest = {
  version: number;
  generated_at: string;
  /** Hash of everything that changes every page's output (link map, options). */
  fingerprint: string;
  pages: Record<string, TManifestPage>;
  /** Generated files that belong to no single page (the projects folder's _category_.json). */
  files?: string[];
};

export const emptyManifest = (): TManifest => ({
  version: MANIFEST_VERSION,
  generated_at: "",
  fingerprint: "",
  pages: {},
});

export async function readManifest(path: string): Promise<TManifest> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as TManifest;
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.pages !== "object") return emptyManifest();
    return parsed;
  } catch {
    return emptyManifest();
  }
}

export async function writeManifest(path: string, manifest: TManifest): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Pages with children and project section roots (even empty ones) are written as folders. */
export const isFolderNode = (node: TPageTreeNode): boolean => node.children.length > 0 || Boolean(node.project);

export const docFileFor = (node: TPageTreeNode): string =>
  isFolderNode(node) ? `${node.path}/index.md` : `${node.path}.md`;

export const categoryFileFor = (node: TPageTreeNode): string | undefined =>
  isFolderNode(node) ? `${node.path}/_category_.json` : undefined;

/**
 * Docusaurus doc id = folder of the file + front matter `id`, so the parent page written to
 * "engineering/index.md" with `id: <uuid>` has the doc id "engineering/<uuid>".
 */
export const docIdFor = (node: TPageTreeNode): string => {
  const file = docFileFor(node);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  return dir ? `${dir}/${node.page.id}` : node.page.id;
};

/** JSON strings are valid YAML 1.2 double-quoted scalars, so no YAML library is needed. */
const yamlString = (value: string): string => JSON.stringify(value);

export function summarise(text: string | null | undefined, max = 160): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export type TFrontMatterOptions = {
  planeUrl: string;
  workspaceSlug: string;
};

export function buildFrontMatter(node: TPageTreeNode<TWikiPageSummary>, options: TFrontMatterOptions): string {
  const page = node.page;
  const title = page.name?.trim() || "Untitled";
  const lines = [
    "---",
    `id: ${yamlString(page.id)}`,
    `title: ${yamlString(title)}`,
    `sidebar_label: ${yamlString(title)}`,
  ];
  if (Number.isFinite(page.sort_order)) lines.push(`sidebar_position: ${page.sort_order}`);
  lines.push(`slug: ${yamlString(`/${node.path}`)}`);
  const description = summarise(page.description_stripped);
  if (description) lines.push(`description: ${yamlString(description)}`);
  if (page.updated_at) lines.push("last_update:", `  date: ${yamlString(page.updated_at)}`);
  const planeUrl = options.planeUrl.replace(/\/+$/, "");
  if (planeUrl) lines.push(`custom_edit_url: ${yamlString(`${planeUrl}/${options.workspaceSlug}/wiki/${page.id}`)}`);
  lines.push("format: md", "---");
  return `${lines.join("\n")}\n`;
}

export function renderDocument(frontMatter: string, body: string): string {
  return body.trim() ? `${frontMatter}\n${body.trimEnd()}\n` : frontMatter;
}

export function buildCategory(node: TPageTreeNode<TWikiPageSummary>): string {
  const category = {
    label: node.project?.name?.trim() || node.page.name?.trim() || "Untitled",
    ...(Number.isFinite(node.page.sort_order) ? { position: node.page.sort_order } : {}),
    collapsed: true,
    link: { type: "doc", id: docIdFor(node) },
  };
  return `${JSON.stringify(category, null, 2)}\n`;
}

export const DEFAULT_PROJECTS_POSITION = 1e9;

/** _category_.json of the folder that groups the project sections (no index doc, kept expanded). */
export function buildProjectsCategory(label: string, position: number = DEFAULT_PROJECTS_POSITION): string {
  const category = { label: label.trim() || "Projects", position, collapsed: false };
  return `${JSON.stringify(category, null, 2)}\n`;
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

/** Writes a file below `root` unless it already has this exact content. Returns true when written. */
export async function writeIfChanged(root: string, relPath: string, content: string): Promise<boolean> {
  const target = safeJoin(root, relPath);
  try {
    if ((await readFile(target, "utf8")) === content) return false;
  } catch {
    // missing file
  }
  await writeFileAtomic(target, content);
  return true;
}

export async function fileExists(root: string, relPath: string): Promise<boolean> {
  try {
    await readFile(safeJoin(root, relPath));
    return true;
  } catch {
    return false;
  }
}

/** Joins and refuses paths that escape `root` (defence in depth: slugs are already [a-z0-9-]). */
export function safeJoin(root: string, relPath: string): string {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep))
    throw new Error(`refusing to touch ${relPath} outside ${root}`);
  return target;
}

/**
 * Deletes files listed in the previous manifest that the new run did not produce, then removes
 * directories left empty. Files never written by wiki-sync are not touched.
 */
export async function removeStaleFiles(root: string, previous: string[], current: Set<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of previous) {
    if (current.has(rel)) continue;
    const target = safeJoin(root, rel);
    await rm(target, { force: true });
    removed.push(rel);
    await pruneEmptyDirs(root, dirname(target));
  }
  return removed;
}

async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  const base = resolve(root);
  let current = resolve(dir);
  while (current.startsWith(base + sep)) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      current = dirname(current);
      continue;
    }
    if (entries.length) return;
    await rmdir(current).catch(() => undefined);
    current = dirname(current);
  }
}
