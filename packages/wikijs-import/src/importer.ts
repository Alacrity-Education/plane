/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- pages are written one by one, parents first */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Root } from "hast";
import type { PlaneWikiApi, TPlanePage } from "./api";
import { buildDescription } from "./editor-doc";
import { collectImageSources, toEditorHtml } from "./html";
import type { TResolvedImage } from "./html";
import { indexRepositoryImages, loadImageSource, locateImage, prepareImage, shrinkImage } from "./images";
import { createLinkResolver } from "./links";
import { htmlToHast, markdownToHast } from "./markdown";
import { pathKey } from "./paths";
import type { TImportReport, TReportPage } from "./report";
import { summarize } from "./report";
import { readSourcePages } from "./source";
import type { TImportState } from "./state";
import { saveState } from "./state";
import { buildTree, flattenTree, renderTree } from "./tree";
import type { TTreeNode, TWarning } from "./types";

export const PLANE_PUBLIC_ACCESS = 0;

export type TImportOptions = {
  sourceDir: string;
  dryRun: boolean;
  /** Only write pages under this Wiki.js path prefix (ancestors are created as needed). */
  only?: string | undefined;
  /**
   * Without state for a page, reuse an existing Plane page with the same name under the same
   * parent instead of creating a new one (recovers a lost state file; overwrites that page).
   */
  adopt?: boolean | undefined;
  /** Rewrite descriptions even when unchanged since the last run. */
  force?: boolean | undefined;
  statePath: string;
  state: TImportState;
  cacheDir: string;
  /** Upload limit of the Plane instance (FILE_SIZE_LIMIT); larger images are re-encoded. */
  maxImageBytes: number;
  api?: PlaneWikiApi | undefined;
  workspaceSlug: string;
  baseUrl?: string | undefined;
  log: (line: string) => void;
};

function parseSource(node: TTreeNode, warnings: TWarning[]): Root {
  const source = node.source;
  if (!source) return { type: "root", children: [] };
  return source.format === "markdown" ? markdownToHast(source.body, warnings, node.path) : htmlToHast(source.body);
}

function selectNodes(all: TTreeNode[], only?: string): { content: Set<TTreeNode>; shells: Set<TTreeNode> } {
  if (!only) return { content: new Set(all), shells: new Set(all) };
  const prefix = pathKey(only);
  const content = new Set(all.filter((node) => node.key === prefix || node.key.startsWith(`${prefix}/`)));
  const shells = new Set(content);
  for (const node of content) {
    for (let parent = node.parent; parent; parent = parent.parent) shells.add(parent);
  }
  return { content, shells };
}

const safeDecode = (value: string) => {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Migrates a Wiki.js repository into the Plane workspace wiki:
 *   1. create/update every page shell (name, parent, order), parents first;
 *   2. upload images and write every description (internal links now resolve, since all
 *      pages exist);
 *   3. publish the public pages to the docs site.
 */
export async function runImport(options: TImportOptions): Promise<TImportReport> {
  const { state, log } = options;
  const warnings: TWarning[] = [];
  const report: TImportReport = {
    startedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    source: options.sourceDir,
    workspaceSlug: options.workspaceSlug,
    baseUrl: options.baseUrl,
    summary: {},
    visibility: {},
    pages: [],
    warnings,
    publishPending: [],
  };

  const sources = readSourcePages(options.sourceDir, warnings);
  const tree = buildTree(sources, warnings);
  const all = flattenTree(tree.roots);
  const { content: contentNodes, shells } = selectNodes(all, options.only);
  log(
    `Read ${sources.length} Wiki.js pages → ${all.length} Plane pages (${all.filter((n) => n.isFolder).length} folders)`
  );

  const entries = new Map<TTreeNode, TReportPage>();
  for (const node of all) {
    if (!shells.has(node)) continue;
    const entry: TReportPage = {
      path: node.path,
      title: node.title,
      kind: node.isFolder ? "folder" : "page",
      source: node.source?.file,
      visibility: node.visibility,
      visibilityReason: node.visibilityReason,
      action: options.dryRun ? "planned" : "skipped",
      pageId: state.pages[node.key]?.id,
    };
    entries.set(node, entry);
    report.pages.push(entry);
  }

  if (options.dryRun) {
    for (const line of renderTree(tree.roots.filter((root) => shells.has(root)))) {
      // the rendered tree covers everything; filter by selection when --only is set
      log(line);
    }
  }

  // ------------------------------------------------------------ 1. page shells
  const existing = new Map<string, TPlanePage>();
  if (!options.dryRun && options.api) {
    for (const page of await options.api.listPages()) existing.set(page.id, page);
    const claimed = new Set(Object.values(state.pages).map((p) => p.id));

    for (const node of all) {
      const entry = entries.get(node);
      if (!entry) continue;
      const parentId = node.parent ? (state.pages[node.parent.key]?.id ?? null) : null;
      if (node.parent && !parentId) {
        entry.action = "failed";
        entry.error = "parent page missing";
        continue;
      }
      const desired = { name: node.title.slice(0, 255), parent: parentId, sort_order: node.sortOrder };
      try {
        let current = state.pages[node.key] ? existing.get(state.pages[node.key]?.id ?? "") : undefined;
        if (current?.archived_at) current = undefined;
        if (!current && options.adopt) {
          // Lost state: adopt a page with the same name under the same parent
          const match = [...existing.values()].find(
            (p) => !claimed.has(p.id) && !p.archived_at && p.parent === parentId && p.name === desired.name
          );
          if (match) {
            current = match;
            claimed.add(match.id);
            entry.action = "adopted";
          }
        }
        if (!current) {
          const created = await options.api.createPage({ ...desired, access: PLANE_PUBLIC_ACCESS });
          existing.set(created.id, created);
          state.pages[node.key] = { id: created.id, path: node.path, title: node.title };
          delete state.assets[node.key];
          entry.action = "created";
          log(`created  ${node.path} → ${created.id}`);
        } else {
          const changes: Partial<TPlanePage> = {};
          if (current.name !== desired.name) changes.name = desired.name;
          if ((current.parent ?? null) !== desired.parent) changes.parent = desired.parent;
          if (current.sort_order !== desired.sort_order) changes.sort_order = desired.sort_order;
          if (current.access !== PLANE_PUBLIC_ACCESS) changes.access = PLANE_PUBLIC_ACCESS;
          if (Object.keys(changes).length) {
            const updated = await options.api.updatePage(current.id, changes);
            existing.set(updated.id, { ...current, ...updated });
            if (entry.action !== "adopted") entry.action = "updated";
            log(`updated  ${node.path} (${Object.keys(changes).join(", ")})`);
          } else if (entry.action !== "adopted") entry.action = "unchanged";
          const previous = state.pages[node.key];
          state.pages[node.key] = {
            ...(previous?.id === current.id ? previous : {}),
            id: current.id,
            path: node.path,
            title: node.title,
          };
        }
        entry.pageId = state.pages[node.key]?.id;
        saveState(options.statePath, state);
      } catch (error) {
        entry.action = "failed";
        entry.error = (error as Error).message;
        log(`FAILED   ${node.path}: ${entry.error}`);
      }
    }
  }

  // ------------------------------------------------------------ 2. content
  const pageIds = new Map<string, string>();
  for (const node of all) {
    const id = options.dryRun ? `<${node.key}>` : state.pages[node.key]?.id;
    if (id) pageIds.set(node.key, id);
    // Links may also name the path of a folder's auxiliary page in its original spelling
    if (id && node.source) pageIds.set(node.source.key, id);
  }
  const imageIndex = indexRepositoryImages(options.sourceDir);

  for (const node of all) {
    const entry = entries.get(node);
    if (!entry || !contentNodes.has(node) || entry.action === "failed") continue;
    const pageId = entry.pageId;
    const pageWarnings: TWarning[] = [];
    try {
      const hast = parseSource(node, pageWarnings);
      // Images: locate, convert, upload (reusing assets uploaded by earlier runs)
      const images = new Map<string, TResolvedImage | null>();
      const converted: string[] = [];
      for (const src of collectImageSources(hast)) {
        const pageFile = node.source?.file ?? `${node.path}/index.md`;
        const located = locateImage(src, pageFile, options.sourceDir, imageIndex);
        const label = src.startsWith("data:") ? "embedded diagram" : src;
        if (!located) {
          pageWarnings.push({ path: node.path, message: `missing image ${label}` });
          images.set(src, null);
          continue;
        }
        if (located.note) pageWarnings.push({ path: node.path, message: `image ${label} ${located.note}` });
        if (options.dryRun) {
          images.set(src, { assetId: "dry-run", width: 0, height: 0 });
          continue;
        }
        try {
          const loaded = await loadImageSource(located.source);
          let prepared = prepareImage(loaded.name, loaded.data, options.cacheDir);
          if (prepared.data.length > options.maxImageBytes) {
            const shrunk = shrinkImage(prepared, options.maxImageBytes, options.cacheDir);
            if (!shrunk) throw new Error(`larger than the ${options.maxImageBytes} byte upload limit`);
            pageWarnings.push({
              path: node.path,
              message: `image ${label} re-encoded as WebP (${Math.round(prepared.data.length / 1024)} KiB → ${Math.round(shrunk.data.length / 1024)} KiB) to fit the upload limit`,
            });
            prepared = shrunk;
          }
          if (prepared.convertedFrom) {
            converted.push(`${label} (${prepared.convertedFrom} → ${prepared.mime.split("/")[1]})`);
          }
          const pageAssets = (state.assets[node.key] ??= {});
          let assetId = pageAssets[prepared.sha256];
          if (!assetId) {
            assetId = await options.api!.uploadPageImage(pageId!, prepared);
            pageAssets[prepared.sha256] = assetId;
          }
          images.set(src, { assetId, width: prepared.width, height: prepared.height });
        } catch (error) {
          pageWarnings.push({ path: node.path, message: `image ${label} not uploaded: ${(error as Error).message}` });
          images.set(src, null);
        }
      }
      entry.images = [...images.values()].filter(Boolean).length;
      if (converted.length) {
        entry.convertedImages = converted;
        pageWarnings.push({ path: node.path, message: `converted: ${converted.join("; ")}` });
      }

      const links = createLinkResolver({ fromPath: node.path, workspaceSlug: options.workspaceSlug, pageIds });
      const { html, codeLanguages } = toEditorHtml(hast, {
        path: node.path,
        warnings: pageWarnings,
        images,
        resolveLink: links.resolve,
      });
      for (const href of new Set(links.unresolved)) {
        pageWarnings.push({ path: node.path, message: `unresolved internal link ${safeDecode(href)} (kept as text)` });
      }
      const files = [...new Set(links.files)];
      if (files.length) {
        const sample = files.slice(0, 3).map(safeDecode).join(", ");
        pageWarnings.push({
          path: node.path,
          message: `${files.length} link(s) to repository files that are not pages kept as text (${sample}${files.length > 3 ? ", …" : ""})`,
        });
      }

      if (options.dryRun) {
        entry.content = node.source ? "planned" : "empty";
        continue;
      }
      const hash = sha(`${node.title}\n${html}\n${codeLanguages.join(",")}`);
      const pageState = state.pages[node.key];
      if (pageState?.contentHash === hash && !options.force) {
        entry.content = "unchanged";
        continue;
      }
      const description = await buildDescription(html, node.title, codeLanguages);
      if (description.codeBlockMismatch) {
        pageWarnings.push({ path: node.path, message: "code block languages could not be matched; some were dropped" });
      }
      await options.api!.updateDescription(pageId!, {
        description_binary: description.description_binary,
        description_html: description.description_html,
        description_json: description.description_json,
      });
      if (pageState) pageState.contentHash = hash;
      entry.content = node.source ? "written" : "empty";
      if (entry.action === "unchanged") entry.action = "updated";
      saveState(options.statePath, state);
      log(`content  ${node.path}${entry.images ? ` (${entry.images} images)` : ""}`);
    } catch (error) {
      entry.content = "failed";
      entry.error = (error as Error).message;
      log(`FAILED   content of ${node.path}: ${entry.error}`);
    } finally {
      warnings.push(...pageWarnings);
    }
  }

  // ------------------------------------------------------------ 3. publish
  if (!options.dryRun && options.api) {
    const pending: TTreeNode[] = [];
    const publishNode = async (node: TTreeNode, entry: TReportPage): Promise<"ok" | "unavailable"> => {
      const id = entry.pageId;
      if (!id) return "ok";
      const isPublished = existing.get(id)?.is_published ?? false;
      if (node.visibility === "public") {
        if (isPublished) {
          entry.publish = "already-published";
          return "ok";
        }
        const result = await options.api!.setPublished(id, true);
        if (result === "unavailable") {
          entry.publish = "unavailable";
          return "unavailable";
        }
        entry.publish = "published";
        return "ok";
      }
      if (isPublished) {
        const result = await options.api!.setPublished(id, false);
        entry.publish = result === "unavailable" ? "unavailable" : "unpublished";
        return result === "unavailable" ? "unavailable" : "ok";
      }
      entry.publish = "not-published";
      return "ok";
    };
    for (const node of all) {
      const entry = entries.get(node);
      if (!entry || !contentNodes.has(node) || !entry.pageId) continue;
      try {
        if ((await publishNode(node, entry)) === "unavailable") pending.push(node);
      } catch (error) {
        entry.publish = "failed";
        entry.error = (error as Error).message;
      }
    }
    if (pending.length) {
      log(`publish endpoint unavailable for ${pending.length} pages; retrying once at the end`);
      const stillPending: TTreeNode[] = [];
      for (const node of pending) {
        const entry = entries.get(node);
        if (!entry) continue;
        try {
          if ((await publishNode(node, entry)) === "unavailable") stillPending.push(node);
        } catch (error) {
          entry.publish = "failed";
          entry.error = (error as Error).message;
        }
      }
      if (stillPending.length) {
        warnings.push({ path: "", message: "publish endpoint unavailable; see publishPending in the report" });
        report.publishPending = stillPending.filter((n) => n.visibility === "public").map((n) => n.path);
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  summarize(report);
  return report;
}

export const defaultCacheDir = (statePath: string) => join(statePath, "..", "cache");
