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
import type { TProjectMatch } from "./projects";
import {
  decideMergeTarget,
  deriveIdentifier,
  matchProject,
  PROJECTS_FOLDER_KEY,
  projectPageNodes,
  sanitizeProjectName,
} from "./projects";
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
  /** `--project-map`: normalized Wiki.js path → project identifier or name. */
  projectMap?: Map<string, string> | undefined;
  /** Create a Plane project for every unmatched project page. */
  createMissingProjects?: boolean | undefined;
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
    projects: [],
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

  // ------------------------------------------------------------ 0. project pages → Plane projects
  const projectTargets = new Map<TTreeNode, TProjectMatch>();
  const projectNodes = projectPageNodes(tree.roots).filter((node) => shells.has(node));
  if (projectNodes.length && options.api) {
    const projects = await options.api.listProjects();
    for (const node of projectNodes) {
      let result = matchProject(node, projects, options.projectMap);
      if (!result.match && !result.reason && options.createMissingProjects && !options.dryRun) {
        const identifier = deriveIdentifier(node.title, new Set(projects.map((p) => p.identifier)));
        const created = await options.api.createProject({ name: sanitizeProjectName(node.title), identifier });
        const project = { id: created.id, name: created.name, identifier: created.identifier };
        projects.push(project);
        result = { match: { project, via: "created" } };
        log(`project  created ${project.identifier} for ${node.path}`);
      }
      const reportEntry = {
        path: node.path,
        title: node.title,
        project: result.match?.project.identifier,
        projectName: result.match?.project.name,
        via: result.match?.via,
        target: result.match && options.dryRun ? ("planned" as const) : undefined,
        reason: result.reason,
        suggestion: result.match ? undefined : `"${node.path}": "<project identifier>"`,
      };
      report.projects.push(reportEntry);
      if (result.match) {
        projectTargets.set(node, result.match);
        const entry = entries.get(node);
        if (entry) entry.project = result.match.project.identifier;
        log(`project  ${node.path} → ${result.match.project.identifier} (${result.match.via})`);
      } else {
        warnings.push({
          path: node.path,
          message: `unmatched project page${result.reason ? ` (${result.reason})` : ""}; kept under the Projects folder page`,
        });
      }
    }
  } else if (projectNodes.length) {
    warnings.push({
      path: "Projects",
      message: "project pages were not matched to Plane projects (needs API access; pass credentials to the dry run)",
    });
  }
  const projectsFolder = tree.nodes.get(PROJECTS_FOLDER_KEY);
  // The fallback folder page is only needed for project pages without a project
  const projectsFolderRedundant =
    !!projectsFolder?.isFolder &&
    !projectsFolder.source &&
    projectTargets.size > 0 &&
    projectsFolder.children.every((child) => projectTargets.has(child));
  const omitted = new Set<TTreeNode>();
  if (projectsFolder && projectsFolderRedundant) omitted.add(projectsFolder);

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

    const replaced: { id: string; path: string }[] = [];
    for (const node of all) {
      const entry = entries.get(node);
      if (!entry || omitted.has(node)) continue;
      let parentId = node.parent ? (state.pages[node.parent.key]?.id ?? null) : null;

      const target = projectTargets.get(node);
      if (target) {
        try {
          const section = await options.api.ensureProjectWiki(target.project.id);
          const rootId = section.root_page;
          const previous = state.pages[node.key];
          const previousPage = previous ? existing.get(previous.id) : undefined;
          const rootClaimed = Object.entries(state.pages).some(([key, p]) => key !== node.key && p.id === rootId);
          const needsRoot =
            previous?.id !== rootId && !(previousPage && previousPage.parent === rootId) && !rootClaimed;
          const rootPage = needsRoot ? await options.api.getPage(rootId) : undefined;
          if (rootPage) existing.set(rootId, { ...existing.get(rootId), ...rootPage });
          const mode = decideMergeTarget({
            statePageId: previous?.id,
            statePageParent: previousPage?.archived_at ? undefined : previousPage?.parent,
            rootId,
            rootDescriptionHtml: rootPage?.description_html,
            rootClaimed,
          });
          entry.project = target.project.identifier;
          const reportProject = report.projects.find((p) => p.path === node.path);
          if (reportProject) reportProject.target = mode;
          if (mode === "root") {
            const moved = !!previous && previous.id !== rootId;
            if (moved && previousPage && !previousPage.archived_at) replaced.push({ id: previous.id, path: node.path });
            state.pages[node.key] = {
              id: rootId,
              path: node.path,
              title: node.title,
              project: target.project.identifier,
              rootName: existing.get(rootId)?.name ?? section.root_page_name,
              contentHash: previous?.id === rootId ? previous.contentHash : undefined,
            };
            if (previous?.id !== rootId) delete state.assets[node.key];
            entry.action = moved ? "moved" : previous ? "unchanged" : "merged";
            entry.pageId = rootId;
            if (entry.action !== "unchanged")
              log(`${entry.action.padEnd(8)} ${node.path} → ${target.project.identifier} section root`);
            saveState(options.statePath, state);
            continue;
          }
          // Child of the section root (an existing page elsewhere is moved there)
          if (previousPage && !previousPage.archived_at && previousPage.parent !== rootId) entry.action = "moved";
          parentId = rootId;
        } catch (error) {
          entry.action = "failed";
          entry.error = `project section: ${(error as Error).message}`;
          log(`FAILED   ${node.path}: ${entry.error}`);
          continue;
        }
      }
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
          state.pages[node.key] = {
            id: created.id,
            path: node.path,
            title: node.title,
            project: target?.project.identifier,
          };
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
            if (entry.action !== "adopted" && entry.action !== "moved") entry.action = "updated";
            log(`${entry.action.padEnd(8)} ${node.path} (${Object.keys(changes).join(", ")})`);
          } else if (entry.action !== "adopted") entry.action = "unchanged";
          const previous = state.pages[node.key];
          state.pages[node.key] = {
            ...(previous?.id === current.id ? previous : {}),
            id: current.id,
            path: node.path,
            title: node.title,
            project: target?.project.identifier,
            rootName: undefined,
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

    // Pages this tool created that were replaced by a project section root
    const liveChildren = (id: string) => [...existing.values()].filter((p) => p.parent === id && !p.archived_at);
    for (const old of replaced) {
      if (liveChildren(old.id).length) {
        warnings.push({ path: old.path, message: `old page ${old.id} kept: it still has child pages` });
        continue;
      }
      try {
        await options.api.deletePage(old.id);
        existing.delete(old.id);
        log(`deleted  old page of ${old.path} (${old.id})`);
      } catch (error) {
        warnings.push({ path: old.path, message: `old page ${old.id} not deleted: ${(error as Error).message}` });
      }
    }
    if (projectsFolder && projectsFolderRedundant) {
      const folderEntry = entries.get(projectsFolder);
      const folderState = state.pages[projectsFolder.key];
      if (folderEntry) folderEntry.action = "skipped";
      if (folderState) {
        const stillUsed = Object.entries(state.pages).some(
          ([key, p]) => key !== projectsFolder.key && existing.get(p.id)?.parent === folderState.id
        );
        if (stillUsed || liveChildren(folderState.id).length) {
          warnings.push({ path: projectsFolder.path, message: "Projects folder page kept: it still has child pages" });
        } else {
          try {
            if (existing.has(folderState.id)) await options.api.deletePage(folderState.id);
            existing.delete(folderState.id);
            delete state.pages[projectsFolder.key];
            delete state.assets[projectsFolder.key];
            if (folderEntry) folderEntry.action = "deleted";
            log(`deleted  ${projectsFolder.path} folder page (every project page moved to its project)`);
          } catch (error) {
            warnings.push({
              path: projectsFolder.path,
              message: `folder page not deleted: ${(error as Error).message}`,
            });
          }
        }
      }
      if (folderEntry) folderEntry.pageId = state.pages[projectsFolder.key]?.id;
      saveState(options.statePath, state);
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
    if (!entry || !contentNodes.has(node) || entry.action === "failed" || omitted.has(node)) continue;
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
      const pageState = state.pages[node.key];
      // A project section root keeps its own name (the project's)
      const title = pageState?.rootName ?? node.title;
      const hash = sha(`${title}\n${html}\n${codeLanguages.join(",")}`);
      if (pageState?.contentHash === hash && !options.force) {
        entry.content = "unchanged";
        continue;
      }
      const description = await buildDescription(html, title, codeLanguages);
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
      if (!entry || !contentNodes.has(node) || !entry.pageId || omitted.has(node)) continue;
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
