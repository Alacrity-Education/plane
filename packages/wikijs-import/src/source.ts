/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontMatter } from "./frontmatter";
import { decodeSegment, pathKey } from "./paths";
import type { TPageFormat, TSourcePage, TWarning } from "./types";

const PAGE_EXTENSIONS: Record<string, TPageFormat> = { ".md": "markdown", ".html": "html" };

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .git, .github, editor folders
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/** Builds a source page from a repository-relative file name and its content. */
export function toSourcePage(file: string, content: string): TSourcePage | null {
  const dot = file.lastIndexOf(".");
  const format = dot >= 0 ? PAGE_EXTENSIONS[file.slice(dot).toLowerCase()] : undefined;
  if (!format) return null;
  const { meta, body } = parseFrontMatter(content, format);
  const path = file.slice(0, dot).split("/").map(decodeSegment).join("/");
  return { file, path, key: pathKey(path), format, meta, body };
}

function newer(a: TSourcePage, b: TSourcePage): TSourcePage {
  const ta = Date.parse(a.meta.date ?? "") || 0;
  const tb = Date.parse(b.meta.date ?? "") || 0;
  return tb > ta ? b : a;
}

/**
 * Keeps one page per normalized path. Wiki.js can leave the same page behind twice (a
 * folder renamed `Airbox%20Online%20Bootcamp` → `AirboxOnlineBootcamp`, or a page converted
 * from markdown to HTML); the most recently modified copy wins.
 */
export function dedupePages(pages: TSourcePage[], warnings: TWarning[]): TSourcePage[] {
  const byKey = new Map<string, TSourcePage>();
  for (const page of pages) {
    const existing = byKey.get(page.key);
    if (!existing) {
      byKey.set(page.key, page);
      continue;
    }
    const kept = newer(existing, page);
    const dropped = kept === existing ? page : existing;
    byKey.set(page.key, kept);
    warnings.push({
      path: kept.path,
      message: `duplicate page: kept ${kept.file} (${kept.meta.date ?? "no date"}), skipped ${dropped.file} (${dropped.meta.date ?? "no date"})`,
    });
  }
  return [...byKey.values()];
}

/** Reads every Wiki.js page (`.md`, `.html` with front matter) of a git-sync repository. */
export function readSourcePages(repoDir: string, warnings: TWarning[]): TSourcePage[] {
  const files: string[] = [];
  walk(repoDir, files);
  const pages: TSourcePage[] = [];
  for (const full of files.toSorted()) {
    const file = relative(repoDir, full).split(sep).join("/");
    const page = toSourcePage(file, readFileSync(full, "utf8"));
    if (!page) continue;
    if (page.format === "html" && !page.meta.title && !page.meta.editor) {
      warnings.push({ path: page.path, message: `skipped ${file}: HTML file without Wiki.js metadata` });
      continue;
    }
    pages.push(page);
  }
  return dedupePages(pages, warnings);
}
