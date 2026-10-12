/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  createPage = async (body: { name: string; parent: string | null; sort_order: number; access: number }) => {
    const page = this.addPage(body.name, body.parent);
    page.sort_order = body.sort_order;
    page.access = body.access;
    return { ...page };
  };
  updatePage = async (id: string, body: Partial<TPlanePage>) => {
    const page = this.pages.get(id);
    if (!page) throw new Error(`no page ${id}`);
    Object.assign(page, body);
    // like the API: only public pages stay published
    if (body.access !== undefined && body.access !== 0) this.published.delete(id);
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
  archived: string[] = [];
  archivePage = async (id: string) => {
    const archive = (pageId: string) => {
      const page = this.pages.get(pageId);
      if (!page) return;
      page.archived_at = "2026-01-01T00:00:00Z";
      for (const child of this.pages.values()) if (child.parent === pageId) archive(child.id);
    };
    archive(id);
    this.archived.push(id);
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

    // 5. --only on one project page does not bring the fallback folder page back
    const pagesBefore = api.pages.size;
    await run({ projectMap: new Map([["projects/notes", "LAB"]]), only: "Projects/spin-motor", force: true });
    expect(state.pages.projects).toBeUndefined();
    expect(api.pages.size).toBe(pagesBefore);
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

function makeVisibilityRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wikijs-import-"));
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  write("home.md", "---\ntitle: Home\n---\nWelcome");
  write("Courses/intro.md", "---\ntitle: Intro\n---\nCourse");
  write("Meetings/weekly.md", "---\ntitle: Weekly\n---\nNotes");
  write("Board.md", "---\ntitle: Board\ntags: public\n---\nBoard folder page");
  write("Board/minutes.md", "---\ntitle: Minutes\ntags: public\n---\nMinutes");
  return dir;
}

describe("runImport: access levels", () => {
  const setup = () => {
    const repo = makeVisibilityRepo();
    const api = new FakeApi();
    const state = emptyState();
    const run = () =>
      runImport({
        sourceDir: repo,
        dryRun: false,
        statePath: join(repo, ".state", "state.json"),
        state,
        cacheDir: join(repo, ".state", "cache"),
        maxImageBytes: 5_000_000,
        api: api as unknown as PlaneWikiApi,
        workspaceSlug: "ws",
        log: () => undefined,
      });
    const page = (key: string) => api.pages.get(state.pages[key]!.id)!;
    return { api, state, run, page };
  };

  it("creates public, members-only and admins-only pages and publishes only public ones", async () => {
    const { api, state, run, page } = setup();
    const report = await run();

    expect(page("courses/intro").access).toBe(0);
    expect(page("meetings/weekly").access).toBe(3);
    expect(page("meetings").access).toBe(3);
    expect(page("board").access).toBe(2);
    expect(page("board/minutes").access).toBe(2);
    expect(api.published.has(state.pages["courses/intro"]!.id)).toBe(true);
    expect(api.published.has(state.pages["meetings/weekly"]!.id)).toBe(false);
    expect(api.published.has(state.pages["board/minutes"]!.id)).toBe(false);
    expect(report.visibility.Board).toEqual({ public: 0, members: 0, admins: 2 });
    expect(report.visibility.Meetings).toEqual({ public: 0, members: 2, admins: 0 });
    expect(report.pages.find((p) => p.path === "Board/minutes")?.access).toBe(2);
    expect(report.summary.access_updated).toBeUndefined();
  });

  it("re-runs fix the access and the published state of earlier imports", async () => {
    const { api, state, run, page } = setup();
    await run();
    // an earlier import made everything public and published the Board page
    for (const key of ["meetings", "meetings/weekly", "board", "board/minutes"]) page(key).access = 0;
    api.published.add(state.pages["board/minutes"]!.id);

    const report = await run();

    expect(page("meetings/weekly").access).toBe(3);
    expect(page("board/minutes").access).toBe(2);
    expect(api.published.has(state.pages["board/minutes"]!.id)).toBe(false);
    expect(report.summary.access_updated).toBe(4);
    expect(report.pages.find((p) => p.path === "Board/minutes")).toMatchObject({
      action: "updated",
      accessUpdated: true,
    });
    expect(report.pages.find((p) => p.path === "Courses/intro")?.accessUpdated).toBeUndefined();

    const third = await run();
    expect(third.summary.access_updated).toBeUndefined();
    expect(third.summary.updated ?? 0).toBe(0);
  });

  it("the dry run tree shows the Plane access level", async () => {
    const repo = makeVisibilityRepo();
    const lines: string[] = [];
    await runImport({
      sourceDir: repo,
      dryRun: true,
      statePath: join(repo, ".state", "state.json"),
      state: emptyState(),
      cacheDir: join(repo, ".state", "cache"),
      maxImageBytes: 5_000_000,
      workspaceSlug: "ws",
      log: (line: string) => lines.push(line),
    });
    expect(lines.some((l) => l.trim().startsWith("[public]") && l.includes("Courses/intro"))).toBe(true);
    expect(lines.some((l) => l.includes("[members]") && l.includes("Meetings/weekly"))).toBe(true);
    expect(lines.some((l) => l.includes("[admins]") && l.includes("Board/minutes"))).toBe(true);
  });
});

describe("runImport: pages gone from the source", () => {
  it("lists them, and with --prune archives them (and folder pages left empty)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wikijs-import-"));
    const write = (file: string, content: string) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    };
    write("home.md", "---\ntitle: Home\n---\nWelcome");
    write("Courses/keep.md", "---\ntitle: Keep\n---\nKeep");
    write("Courses/old.md", "---\ntitle: Old\n---\nOld");
    write("Courses/older.md", "---\ntitle: Older\n---\nOlder");
    write("Meetings/a.md", "---\ntitle: A\n---\nA");
    write("Meetings/b.md", "---\ntitle: B\n---\nB");
    const api = new FakeApi();
    const state = emptyState();
    const run = (extra: Record<string, unknown> = {}) =>
      runImport({
        sourceDir: dir,
        dryRun: false,
        statePath: join(dir, ".state", "state.json"),
        state,
        cacheDir: join(dir, ".state", "cache"),
        maxImageBytes: 5_000_000,
        api: api as unknown as PlaneWikiApi,
        workspaceSlug: "ws",
        log: () => undefined,
        ...extra,
      });
    await run();
    const ids = Object.fromEntries(Object.entries(state.pages).map(([key, page]) => [key, page.id]));
    rmSync(join(dir, "Meetings"), { recursive: true });
    rmSync(join(dir, "Courses/old.md"));
    rmSync(join(dir, "Courses/older.md"));
    // someone added a page under "Older" in Plane: it must not be archived along
    api.addPage("Notes", ids["courses/older"]);

    // 1. without --prune: only listed
    const listed = await run();
    expect(listed.stale.map((p) => [p.path, p.action]).toSorted()).toEqual([
      ["Courses/old", "stale"],
      ["Courses/older", "stale"],
      ["Meetings", "stale"],
      ["Meetings/a", "stale"],
      ["Meetings/b", "stale"],
    ]);
    expect(listed.summary.stale).toBe(5);
    expect(api.archived).toEqual([]);
    expect(listed.warnings.some((w) => w.path === "Meetings/a" && w.message.includes("--prune"))).toBe(true);

    // 2. --prune: archived deepest first; the folder page goes once its pages are gone
    const pruned = await run({ prune: true });
    expect(api.archived).toEqual([ids["courses/old"], ids["meetings/a"], ids["meetings/b"], ids.meetings]);
    expect(pruned.summary.pruned).toBe(4);
    expect(pruned.stale.find((p) => p.path === "Courses/older")).toMatchObject({ action: "kept" });
    expect(state.pages["meetings/a"]).toBeUndefined();
    expect(state.pruned?.["meetings/a"]).toMatchObject({ id: ids["meetings/a"], path: "Meetings/a" });
    expect(api.pages.get(ids["courses/keep"]!)!.archived_at).toBeNull();
    expect(api.pages.get(ids.courses!)!.archived_at).toBeNull();

    // 3. nothing new: only the kept page is still listed
    const again = await run({ prune: true });
    expect(again.stale.map((p) => p.path)).toEqual(["Courses/older"]);
    expect(api.archived).toHaveLength(4);
  });
});
