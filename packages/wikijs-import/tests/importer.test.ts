/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlaneWikiApi, TPlanePage } from "../src/api";
import { runImport } from "../src/importer";
import type { TPlaneProject } from "../src/projects";
import { emptyState } from "../src/state";

type TFakePage = TPlanePage & { description_html: string };

/** In-memory stand-in for the Plane wiki API (only what the importer uses). */
class FakeApi {
  pages = new Map<string, TFakePage>();
  projects: TPlaneProject[] = [];
  sections = new Map<string, string>();
  published = new Set<string>();
  deleted: string[] = [];
  private seq = 0;

  addPage(name: string, parent: string | null = null, html = "<p></p>"): TFakePage {
    const page: TFakePage = {
      id: `page-${++this.seq}`,
      name,
      parent,
      sort_order: 1,
      access: 0,
      archived_at: null,
      owned_by: "me",
      description_html: html,
    };
    this.pages.set(page.id, page);
    return page;
  }
  addProject(name: string, identifier: string, rootHtml?: string): TPlaneProject {
    const project = { id: `project-${identifier}`, name, identifier };
    this.projects.push(project);
    if (rootHtml !== undefined) this.sections.set(project.id, this.addPage(name, null, rootHtml).id);
    return project;
  }
  childrenOf(id: string | null) {
    return [...this.pages.values()].filter((p) => p.parent === id).map((p) => p.name);
  }

  listPages = async () =>
    [...this.pages.values()].map((p) => Object.assign(structuredClone(p), { is_published: this.published.has(p.id) }));
  createPage = async (body: { name: string; parent: string | null; sort_order: number }) => {
    const page = this.addPage(body.name, body.parent);
    page.sort_order = body.sort_order;
    return { ...page };
  };
  updatePage = async (id: string, body: Partial<TPlanePage>) => {
    const page = this.pages.get(id);
    if (!page) throw new Error(`no page ${id}`);
    Object.assign(page, body);
    return { ...page };
  };
  getPage = async (id: string) => ({ ...this.pages.get(id)! });
  updateDescription = async (id: string, body: { description_html: string }) => {
    this.pages.get(id)!.description_html = body.description_html;
  };
  setPublished = async (id: string, publish: boolean) => {
    if (publish) this.published.add(id);
    else this.published.delete(id);
    return publish ? ("published" as const) : ("unpublished" as const);
  };
  deletePage = async (id: string) => {
    this.pages.delete(id);
    this.deleted.push(id);
  };
  listProjects = async () => [...this.projects];
  createProject = async (body: { name: string; identifier: string }) => this.addProject(body.name, body.identifier);
  ensureProjectWiki = async (projectId: string) => {
    let root = this.sections.get(projectId);
    const created = !root;
    if (!root) {
      root = this.addPage(this.projects.find((p) => p.id === projectId)!.name).id;
      this.sections.set(projectId, root);
    }
    return {
      id: `section-${projectId}`,
      project: projectId,
      root_page: root,
      root_page_name: this.pages.get(root)!.name,
      created,
    };
  };
  uploadPageImage = async () => "asset";
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wikijs-import-"));
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  write("home.md", "---\ntitle: Home\n---\nWelcome");
  write("Projects/spin-motor.md", "---\ntitle: Spin Motor\ntags: public\n---\nSpin content");
  write("Projects/notes.md", "---\ntitle: Ongoing notes\n---\nNotes content");
  write("Projects/notes/detail.md", "---\ntitle: Detail\n---\nDetail content");
  return dir;
}

describe("runImport: project pages", () => {
  it("migrates project pages into project sections and stays idempotent", async () => {
    const repo = makeRepo();
    const api = new FakeApi();
    const state = emptyState();
    const statePath = join(repo, ".state", "state.json");
    const run = (extra: Record<string, unknown> = {}) =>
      runImport({
        sourceDir: repo,
        dryRun: false,
        statePath,
        state,
        cacheDir: join(repo, ".state", "cache"),
        maxImageBytes: 5_000_000,
        api: api as unknown as PlaneWikiApi,
        workspaceSlug: "ws",
        log: () => undefined,
        ...extra,
      });

    // 1. No projects yet: everything under a plain "Projects" page
    await run();
    const folderId = state.pages.projects!.id;
    expect(api.childrenOf(folderId).toSorted()).toEqual(["Ongoing notes", "Spin Motor"]);
    const oldSpinId = state.pages["projects/spin-motor"]!.id;

    // 2. A project with an empty section root: content goes into the root, old page deleted
    const spin = api.addProject("SpinMotor", "SPIN", "<p></p>");
    const second = await run();
    const rootId = api.sections.get(spin.id)!;
    expect(state.pages["projects/spin-motor"]).toMatchObject({ id: rootId, project: "SPIN", rootName: "SpinMotor" });
    expect(api.pages.get(rootId)!.description_html).toContain("Spin content");
    expect(api.pages.get(rootId)!.name).toBe("SpinMotor");
    expect(api.deleted).toContain(oldSpinId);
    expect(api.published.has(rootId)).toBe(true);
    // the unmatched page keeps the folder page alive
    expect(api.pages.has(folderId)).toBe(true);
    expect(second.projects.find((p) => p.path === "Projects/notes")).toMatchObject({
      project: undefined,
      suggestion: '"Projects/notes": "<project identifier>"',
    });

    // 3. Map the notes into a project whose root already has content: child page + its sub-page
    const lab = api.addProject("Lab", "LAB", "<p>Existing lab overview</p>");
    const labRoot = api.sections.get(lab.id)!;
    const third = await run({ projectMap: new Map([["projects/notes", "LAB"]]) });
    const notesId = state.pages["projects/notes"]!.id;
    expect(api.pages.get(notesId)!.parent).toBe(labRoot);
    expect(api.pages.get(labRoot)!.description_html).toBe("<p>Existing lab overview</p>");
    expect(api.childrenOf(notesId)).toEqual(["Detail"]);
    expect(third.projects.find((p) => p.path === "Projects/notes")?.target).toBe("child");
    // no project page left under the fallback folder: it is deleted
    expect(api.pages.has(folderId)).toBe(false);
    expect(state.pages.projects).toBeUndefined();

    // 4. Nothing left to do
    const fourth = await run({ projectMap: new Map([["projects/notes", "LAB"]]) });
    expect(fourth.summary.created ?? 0).toBe(0);
    expect(fourth.summary.updated ?? 0).toBe(0);
    expect(fourth.summary.moved ?? 0).toBe(0);
    expect(fourth.summary.content_written ?? 0).toBe(0);
    expect(fourth.pages.find((p) => p.path === "Projects/spin-motor")?.action).toBe("unchanged");
  });

  it("creates missing projects on request", async () => {
    const repo = makeRepo();
    const api = new FakeApi();
    const state = emptyState();
    await runImport({
      sourceDir: repo,
      dryRun: false,
      statePath: join(repo, ".state", "state.json"),
      state,
      cacheDir: join(repo, ".state", "cache"),
      maxImageBytes: 5_000_000,
      api: api as unknown as PlaneWikiApi,
      workspaceSlug: "ws",
      createMissingProjects: true,
      log: () => undefined,
    });
    expect(api.projects.map((p) => p.identifier).toSorted()).toEqual(["ONGOINGNOTES", "SPINMOTOR"]);
    expect(state.pages.projects).toBeUndefined();
    expect(state.pages["projects/spin-motor"]?.project).toBe("SPINMOTOR");
  });

  it("keeps every project page under the Projects folder with --no-project-sections", async () => {
    const repo = makeRepo();
    const api = new FakeApi();
    api.addProject("Spin Motor", "SPINMOTOR"); // would match by name
    const state = emptyState();
    const result = await runImport({
      sourceDir: repo,
      dryRun: false,
      statePath: join(repo, ".state", "state.json"),
      state,
      cacheDir: join(repo, ".state", "cache"),
      maxImageBytes: 5_000_000,
      api: api as unknown as PlaneWikiApi,
      workspaceSlug: "ws",
      noProjectSections: true,
      log: () => undefined,
    });
    const folderId = state.pages.projects!.id;
    expect(api.childrenOf(folderId).toSorted()).toEqual(["Ongoing notes", "Spin Motor"]);
    expect(state.pages["projects/spin-motor"]?.project).toBeUndefined();
    expect(result.projects).toEqual([]);
    expect(result.warnings.filter((w) => w.message.includes("unmatched project page"))).toEqual([]);
    expect(api.projects).toHaveLength(1);
  });
});
