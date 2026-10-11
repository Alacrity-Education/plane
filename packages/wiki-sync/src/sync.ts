/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { rm } from "node:fs/promises";
import { AssetStore, extractImageAssetIds } from "./assets";
import { createLimit } from "./limit";
import { convertWikiHtmlToMarkdown } from "./markdown";
import type { TPreprocessAsset } from "./preprocess";
import { buildLinkMap, buildPageTree, flattenTree } from "./tree";
import type { IWikiSource, TCalloutMode, TLogger, TWikiAsset, TWikiPageSummary } from "./types";
import {
  MANIFEST_VERSION,
  buildCategory,
  buildFrontMatter,
  categoryFileFor,
  docFileFor,
  fileExists,
  fingerprint,
  readManifest,
  removeStaleFiles,
  renderDocument,
  safeJoin,
  writeIfChanged,
  writeManifest,
  type TManifest,
} from "./writer";

export type TSyncOptions = {
  source: IWikiSource;
  planeUrl: string;
  workspaceSlug: string;
  /** Docs instance folder, e.g. "wiki". */
  outDir: string;
  /** Static folder for images, e.g. "static/wiki-assets". */
  assetsDir: string;
  /** URL prefix of assetsDir on the site, e.g. "/wiki-assets". */
  publicPath: string;
  /** routeBasePath of the docs instance, used for rewritten links ("/wiki"). */
  routeBasePath: string;
  cachePath: string;
  concurrency: number;
  callouts: TCalloutMode;
  force: boolean;
  logger: TLogger;
};

export type TSyncResult = {
  pages: number;
  written: number;
  unchanged: number;
  skipped: number;
  removed: string[];
};

/** Wraps every network call of a source in one shared concurrency limit. */
function limitSource(source: IWikiSource, concurrency: number): IWikiSource {
  const limit = createLimit(concurrency);
  return {
    listPages: () => limit(() => source.listPages()),
    getPage: (id) => limit(() => source.getPage(id)),
    getAssetUrl: (id) => limit(() => source.getAssetUrl(id)),
    download: (url) => limit(() => source.download(url)),
    listMembers: () => limit(() => source.listMembers()),
  };
}

const listFiles = (manifest: TManifest): string[] =>
  Object.values(manifest.pages).flatMap((p) => (p.category ? [p.file, p.category] : [p.file]));

export async function runSync(options: TSyncOptions): Promise<TSyncResult> {
  const { logger } = options;
  const source = limitSource(options.source, options.concurrency);

  const pages = (await source.listPages()).filter((p) => !p.archived_at);
  const tree = buildPageTree<TWikiPageSummary>(pages);
  const linkMap = buildLinkMap(tree, options.routeBasePath);
  const nodes = flattenTree(tree.roots);

  const previous = await readManifest(options.cachePath);
  const currentFingerprint = fingerprint({
    v: MANIFEST_VERSION,
    links: [...linkMap].toSorted(([a], [b]) => (a < b ? -1 : 1)),
    callouts: options.callouts,
    publicPath: options.publicPath,
    planeUrl: options.planeUrl,
    workspaceSlug: options.workspaceSlug,
  });
  const rebuildAll = options.force || previous.fingerprint !== currentFingerprint;

  const assets = new AssetStore({ source, dir: options.assetsDir, publicPath: options.publicPath, logger });
  let membersPromise: Promise<Map<string, string>> | undefined;
  const getMembers = () =>
    (membersPromise ??= source
      .listMembers()
      .then((list) => new Map(list.map((m) => [m.id.toLowerCase(), m.display_name])))
      .catch((error: Error) => {
        logger.warn(`members: lookup failed, mentions render as @member (${error.message})`);
        return new Map<string, string>();
      }));

  const next: TManifest = {
    version: MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    fingerprint: currentFingerprint,
    pages: {},
  };
  const result: TSyncResult = { pages: nodes.length, written: 0, unchanged: 0, skipped: 0, removed: [] };

  const settled = await Promise.allSettled(
    nodes.map(async (node) => {
      const page = node.page;
      const file = docFileFor(node);
      const category = categoryFileFor(node);
      if (category) await writeIfChanged(options.outDir, category, buildCategory(node));

      const old = previous.pages[page.id];
      if (
        !rebuildAll &&
        old &&
        old.file === file &&
        old.updated_at === page.updated_at &&
        (await fileExists(options.outDir, file))
      ) {
        const { category: _oldCategory, ...rest } = old;
        next.pages[page.id] = category ? { ...rest, category } : rest;
        result.skipped++;
        return;
      }

      const detail = await source.getPage(page.id);
      const html = detail.description_html ?? "";
      const assetMeta = new Map<string, TWikiAsset>((detail.assets ?? []).map((a) => [a.id.toLowerCase(), a]));
      const resolved = new Map<string, TPreprocessAsset>();
      const assetFiles: string[] = [];
      await Promise.all(
        extractImageAssetIds(html).map(async (id) => {
          const asset = await assets.resolve(id, assetMeta.get(id));
          if (!asset) return;
          resolved.set(id, { url: asset.url, name: asset.name });
          assetFiles.push(asset.fileName);
        })
      );

      const members = html.includes("mention-component") ? await getMembers() : new Map<string, string>();
      const body = convertWikiHtmlToMarkdown(html, {
        workspaceSlug: options.workspaceSlug,
        planeUrl: options.planeUrl,
        linkMap,
        assets: resolved,
        members,
        callouts: options.callouts,
      });
      const frontMatter = buildFrontMatter(
        { ...node, page: { ...page, ...detail, parent: page.parent } },
        { planeUrl: options.planeUrl, workspaceSlug: options.workspaceSlug }
      );
      const changed = await writeIfChanged(options.outDir, file, renderDocument(frontMatter, body));
      if (changed) result.written++;
      else result.unchanged++;
      next.pages[page.id] = {
        file,
        ...(category ? { category } : {}),
        updated_at: detail.updated_at ?? page.updated_at,
        assets: assetFiles.toSorted(),
      };
    })
  );

  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failures.length) {
    const messages = failures.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)));
    throw new Error(`${failures.length} page(s) failed; manifest not updated:\n- ${messages.join("\n- ")}`);
  }

  // Stale cleanup: only files a previous run wrote (listed in the old manifest) are deleted.
  const current = new Set(listFiles(next));
  result.removed = await removeStaleFiles(options.outDir, listFiles(previous), current);

  const usedAssets = new Set(Object.values(next.pages).flatMap((p) => p.assets ?? []));
  for (const fileName of new Set(Object.values(previous.pages).flatMap((p) => p.assets ?? []))) {
    if (usedAssets.has(fileName)) continue;
    // oxlint-disable-next-line no-await-in-loop -- few files, ordered log
    await rm(safeJoin(options.assetsDir, fileName), { force: true });
    result.removed.push(`${options.publicPath.replace(/\/+$/, "")}/${fileName}`);
  }

  await writeManifest(options.cachePath, next);
  logger.info(
    `wiki-sync: ${result.pages} page(s): ${result.written} written, ${result.unchanged} unchanged, ` +
      `${result.skipped} skipped (manifest), ${result.removed.length} stale file(s) removed`
  );
  return result;
}
