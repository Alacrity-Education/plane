import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaneApiError } from "../src/api";
import { FixtureSource, type TWikiFixture } from "../src/fixture";
import { runSync, type TSyncOptions } from "../src/sync";
import { buildPageTree } from "../src/tree";
import type { TWikiPageSummary } from "../src/types";
import { buildCategory, buildFrontMatter, docIdFor, readManifest, safeJoin, summarise } from "../src/writer";

const FIXTURE = new URL("./fixtures/wiki-fixture.json", import.meta.url).pathname;
const FIXTURE_DIR = new URL("./fixtures/", import.meta.url).pathname;

const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      // oxlint-disable-next-line no-await-in-loop -- tiny temp trees
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(dir, full));
    }
  };
  await walk(dir).catch(() => undefined);
  return out.toSorted();
};

/** Plane session download route of an asset (what the Wiki.js importer writes for linked files). */
const download = (id: string) => `/api/assets/v2/workspaces/acme/download/${id}/`;

/** FixtureSource that counts detail fetches. */
class CountingSource extends FixtureSource {
  getPageCalls: string[] = [];
  override async getPage(id: string) {
    this.getPageCalls.push(id);
    return super.getPage(id);
  }
}

describe("front matter and categories", () => {
  const page: TWikiPageSummary = {
    id: "0d8b6c3e-0000-4000-8000-000000000001",
    name: 'Ops: "runbooks" # 1',
    parent: null,
    sort_order: 1234.5,
    updated_at: "2026-10-10T12:34:56Z",
    description_stripped: `${"word ".repeat(50)}end`,
  };
  const tree = buildPageTree([page, { ...page, id: "child", name: "Child", parent: page.id }]);
  const node = tree.byId.get(page.id)!;

  it("writes YAML-safe front matter", () => {
    expect(buildFrontMatter(node, { planeUrl: "https://plane.example.com/", workspaceSlug: "acme" })).toBe(
      [
        "---",
        'id: "0d8b6c3e-0000-4000-8000-000000000001"',
        'title: "Ops: \\"runbooks\\" # 1"',
        'sidebar_label: "Ops: \\"runbooks\\" # 1"',
        "sidebar_position: 1234.5",
        'slug: "/ops-runbooks-1"',
        `description: "${summarise(page.description_stripped)}"`,
        "last_update:",
        '  date: "2026-10-10T12:34:56Z"',
        'custom_edit_url: "https://plane.example.com/acme/wiki/0d8b6c3e-0000-4000-8000-000000000001"',
        "format: md",
        "---",
        "",
      ].join("\n")
    );
    expect(summarise(page.description_stripped).length).toBeLessThanOrEqual(160);
  });

  it("links the category to the parent doc id (folder + uuid)", () => {
    expect(docIdFor(node)).toBe(`ops-runbooks-1/${page.id}`);
    expect(JSON.parse(buildCategory(node))).toEqual({
      label: 'Ops: "runbooks" # 1',
      position: 1234.5,
      collapsed: true,
      link: { type: "doc", id: `ops-runbooks-1/${page.id}` },
    });
  });

  it("refuses paths outside the output dir", () => {
    expect(() => safeJoin("/tmp/out", "../etc/passwd")).toThrow();
    expect(safeJoin("/tmp/out", "a/b.md")).toBe("/tmp/out/a/b.md");
  });
});

describe("runSync (temp dir)", () => {
  let root: string;
  let options: (source: FixtureSource, extra?: Partial<TSyncOptions>) => TSyncOptions;
  const logs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wiki-sync-"));
    logs.length = 0;
    options = (source, extra = {}) => ({
      source,
      planeUrl: "https://plane.example.com",
      workspaceSlug: "acme",
      outDir: join(root, "wiki"),
      assetsDir: join(root, "static/wiki-assets"),
      publicPath: "/wiki-assets",
      routeBasePath: "/wiki",
      cachePath: join(root, ".wiki-cache/manifest.json"),
      concurrency: 3,
      callouts: "admonition",
      force: false,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
      ...extra,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const loadFixture = async (): Promise<TWikiFixture> => JSON.parse(await readFile(FIXTURE, "utf8")) as TWikiFixture;

  it("writes the folder tree, categories, assets and manifest", async () => {
    await runSync(options(await CountingSource.fromFile(FIXTURE)));
    expect(await listFiles(join(root, "wiki"))).toEqual([
      "contributing.md",
      "diagrams.md",
      "engineering/_category_.json",
      "engineering/index.md",
      "engineering/onboarding.md",
      "engineering/runbooks/_category_.json",
      "engineering/runbooks/deploy-checklist.md",
      "engineering/runbooks/index.md",
      "faq-2.md",
      "faq.md",
      "getting-started.md",
      "orphaned-page.md",
      "projects/_category_.json",
      "projects/mob/_category_.json",
      "projects/mob/index.md",
      "projects/web/_category_.json",
      "projects/web/architecture/_category_.json",
      "projects/web/architecture/frontend.md",
      "projects/web/architecture/index.md",
      "projects/web/index.md",
      "projects/web/release-notes.md",
      "smoke-fixture-mdx-check.md",
    ]);
    expect(await listFiles(join(root, "static/wiki-assets"))).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001.png",
      "aaaaaaaa-0000-4000-8000-000000000002.png",
    ]);
    const diagrams = await readFile(join(root, "wiki/diagrams.md"), "utf8");
    expect(diagrams).toContain("![system-overview.png](/wiki-assets/aaaaaaaa-0000-4000-8000-000000000002.png)");
    expect(diagrams).toContain("![diagram.png](/wiki-assets/aaaaaaaa-0000-4000-8000-000000000001.png)");
    // the drawing whose asset does not exist is dropped, the rest of the page is kept
    expect(diagrams).not.toContain("aaaaaaaa-0000-4000-8000-000000000099");
    expect(diagrams).toContain("The last drawing has no stored asset and is dropped.");
    expect(logs.some((l) => l.startsWith("warn: asset aaaaaaaa-0000-4000-8000-000000000099"))).toBe(true);
    const smoke = await readFile(join(root, "wiki/smoke-fixture-mdx-check.md"), "utf8");
    expect(smoke).toContain("![diagram.png](/wiki-assets/aaaaaaaa-0000-4000-8000-000000000001.png)");
    expect(smoke).toContain("Owner: @jane");
    expect(smoke).toContain(
      "See [Onboarding](/wiki/engineering/onboarding) and [Runbooks](/wiki/engineering/runbooks)."
    );
    const manifest = await readManifest(join(root, ".wiki-cache/manifest.json"));
    expect(Object.keys(manifest.pages)).toHaveLength(16);
    expect(manifest.files).toEqual(["projects/_category_.json"]);
    expect(manifest.pages["00000002-0000-4000-8000-000000000002"]).toMatchObject({
      file: "engineering/index.md",
      category: "engineering/_category_.json",
    });
  });

  it("skips unchanged pages, refetches changed ones, and --force refetches all", async () => {
    await runSync(options(await CountingSource.fromFile(FIXTURE)));

    const fixture = await loadFixture();
    const changed = fixture.pages.find((p) => p.name === "Onboarding")!;
    changed.updated_at = "2026-10-11T00:00:00Z";
    changed.description_html = "<p>Updated onboarding.</p>";
    const second = new CountingSource(fixture, FIXTURE_DIR);
    const result = await runSync(options(second));
    expect(second.getPageCalls).toEqual([changed.id]);
    expect(result.skipped).toBe(15);
    expect(await readFile(join(root, "wiki/engineering/onboarding.md"), "utf8")).toContain("Updated onboarding.");

    const third = new CountingSource(fixture, FIXTURE_DIR);
    await runSync(options(third, { force: true }));
    expect(third.getPageCalls).toHaveLength(16);
  });

  it("re-renders everything when the link map changes (a rename moves a link target)", async () => {
    await runSync(options(await CountingSource.fromFile(FIXTURE)));
    const fixture = await loadFixture();
    fixture.pages.find((p) => p.name === "Runbooks")!.name = "Playbooks";
    const source = new CountingSource(fixture, FIXTURE_DIR);
    await runSync(options(source));
    expect(source.getPageCalls).toHaveLength(16);
    expect(await readFile(join(root, "wiki/smoke-fixture-mdx-check.md"), "utf8")).toContain(
      "(/wiki/engineering/playbooks)"
    );
  });

  it("removes stale files and empty folders but leaves hand-written files alone", async () => {
    await runSync(options(await CountingSource.fromFile(FIXTURE)));
    await writeFile(join(root, "wiki/hand-written.md"), "# mine\n");

    const fixture = await loadFixture();
    // drop the Runbooks subtree, the smoke page and the diagrams page (with their images)
    fixture.pages = fixture.pages.filter(
      (p) => !["Runbooks", "Deploy checklist", "Diagrams"].includes(p.name) && !p.name.startsWith("Smoke")
    );
    const result = await runSync(options(new CountingSource(fixture, FIXTURE_DIR)));

    const files = await listFiles(join(root, "wiki"));
    expect(files).not.toContain("engineering/runbooks/index.md");
    expect(files).not.toContain("smoke-fixture-mdx-check.md");
    expect(files).toContain("hand-written.md");
    await expect(stat(join(root, "wiki/engineering/runbooks"))).rejects.toThrow();
    expect(await listFiles(join(root, "static/wiki-assets"))).toEqual([]);
    expect(result.removed).toEqual(
      expect.arrayContaining([
        "engineering/runbooks/index.md",
        "engineering/runbooks/_category_.json",
        "engineering/runbooks/deploy-checklist.md",
        "smoke-fixture-mdx-check.md",
        "/wiki-assets/aaaaaaaa-0000-4000-8000-000000000001.png",
        "/wiki-assets/aaaaaaaa-0000-4000-8000-000000000002.png",
      ])
    );
  });

  it("moves a leaf to <slug>/index.md when it gains children", async () => {
    await runSync(options(await CountingSource.fromFile(FIXTURE)));
    const fixture = await loadFixture();
    const faq = fixture.pages.find((p) => p.name === "FAQ")!;
    fixture.pages.push({ ...faq, id: "99999999-0000-4000-8000-000000000099", name: "Billing", parent: faq.id });
    await runSync(options(new CountingSource(fixture, FIXTURE_DIR)));
    const files = await listFiles(join(root, "wiki"));
    expect(files).toEqual(expect.arrayContaining(["faq/index.md", "faq/_category_.json", "faq/billing.md"]));
    expect(files).not.toContain("faq.md");
  });

  describe("project wiki sections", () => {
    const WEB = "00000010-0000-4000-8000-000000000010";
    const MOB = "00000014-0000-4000-8000-000000000014";
    const CONTRIB = "00000015-0000-4000-8000-000000000015";
    const readJson = async (rel: string): Promise<unknown> =>
      JSON.parse(await readFile(join(root, "wiki", rel), "utf8")) as unknown;
    const read = (rel: string) => readFile(join(root, "wiki", rel), "utf8");

    it("writes the Projects folder and one category per project section", async () => {
      await runSync(options(await CountingSource.fromFile(FIXTURE)));
      expect(await readJson("projects/_category_.json")).toEqual({
        label: "Projects",
        position: 1e9,
        collapsed: false,
      });
      expect(await readJson("projects/web/_category_.json")).toEqual({
        label: "Web App",
        position: 1500,
        collapsed: true,
        link: { type: "doc", id: `projects/web/${WEB}` },
      });
      // an empty project root is still a folder, so its URL is stable when it gains pages
      expect(await readJson("projects/mob/_category_.json")).toEqual({
        label: "Mobile",
        position: 2500,
        collapsed: true,
        link: { type: "doc", id: `projects/mob/${MOB}` },
      });
      expect(await read("projects/web/index.md")).toContain('slug: "/projects/web"');
      expect(await read("projects/web/architecture/frontend.md")).toContain(
        'slug: "/projects/web/architecture/frontend"'
      );
      const manifest = await readManifest(join(root, ".wiki-cache/manifest.json"));
      expect(manifest.pages[MOB]).toMatchObject({
        file: "projects/mob/index.md",
        category: "projects/mob/_category_.json",
      });
    });

    it("rewrites links into and out of the projects path", async () => {
      await runSync(options(await CountingSource.fromFile(FIXTURE)));
      const contributing = await read("contributing.md");
      expect(contributing).toContain("[its architecture](/wiki/projects/web/architecture)");
      expect(contributing).toContain("[frontend notes](/wiki/projects/web/architecture/frontend#state)");
      expect(contributing).toContain("[Mobile](/wiki/projects/mob)");
      expect(await read("projects/web/index.md")).toContain("[Architecture](/wiki/projects/web/architecture)");
      expect(await read("projects/web/architecture/index.md")).toContain("[Onboarding](/wiki/engineering/onboarding)");
    });

    it("honours projectsDir, projectsLabel and projectsPosition", async () => {
      await runSync(
        options(await CountingSource.fromFile(FIXTURE), {
          projectsDir: "teams",
          projectsLabel: "Teams",
          projectsPosition: 5,
        })
      );
      expect(await readJson("teams/_category_.json")).toEqual({ label: "Teams", position: 5, collapsed: false });
      expect(await read("contributing.md")).toContain("(/wiki/teams/web/architecture)");
      await expect(stat(join(root, "wiki/projects"))).rejects.toThrow();
      await expect(runSync(options(await CountingSource.fromFile(FIXTURE), { projectsDir: "a/b" }))).rejects.toThrow(
        /single folder/
      );
    });

    it("moves a page from the root into a project section and back, cleaning stale files", async () => {
      await runSync(options(await CountingSource.fromFile(FIXTURE)));

      const fixture = await loadFixture();
      const contributing = fixture.pages.find((p) => p.id === CONTRIB)!;
      contributing.project_wiki = {
        project_id: "dddddddd-0000-4000-8000-000000000003",
        identifier: "CON",
        name: "Contrib",
      };
      const linked = new CountingSource(fixture, FIXTURE_DIR);
      const first = await runSync(options(linked));
      // the link map changed, so every page is re-rendered
      expect(linked.getPageCalls).toHaveLength(16);
      let files = await listFiles(join(root, "wiki"));
      expect(files).toEqual(expect.arrayContaining(["projects/con/index.md", "projects/con/_category_.json"]));
      expect(files).not.toContain("contributing.md");
      expect(first.removed).toEqual(["contributing.md"]);
      expect(await readJson("projects/con/_category_.json")).toMatchObject({ label: "Contrib" });

      contributing.project_wiki = null;
      const unlinked = new CountingSource(fixture, FIXTURE_DIR);
      const second = await runSync(options(unlinked));
      expect(unlinked.getPageCalls).toHaveLength(16);
      files = await listFiles(join(root, "wiki"));
      expect(files).toContain("contributing.md");
      expect(files.filter((f) => f.startsWith("projects/con"))).toEqual([]);
      await expect(stat(join(root, "wiki/projects/con"))).rejects.toThrow();
      expect(second.removed.toSorted()).toEqual(["projects/con/_category_.json", "projects/con/index.md"]);
      // a second identical run touches nothing
      const third = new CountingSource(fixture, FIXTURE_DIR);
      expect((await runSync(options(third))).skipped).toBe(16);
      expect(third.getPageCalls).toEqual([]);
    });

    it("removes the Projects folder when the last section is unlinked (missing field = null)", async () => {
      await runSync(options(await CountingSource.fromFile(FIXTURE)));
      const fixture = await loadFixture();
      for (const page of fixture.pages) delete page.project_wiki;
      const result = await runSync(options(new CountingSource(fixture, FIXTURE_DIR)));
      const files = await listFiles(join(root, "wiki"));
      expect(files.filter((f) => f.startsWith("projects/"))).toEqual([]);
      await expect(stat(join(root, "wiki/projects"))).rejects.toThrow();
      expect(files).toEqual(
        expect.arrayContaining(["web-app/index.md", "web-app/architecture/frontend.md", "mobile.md"])
      );
      expect(result.removed).toEqual(expect.arrayContaining(["projects/_category_.json", "projects/mob/index.md"]));
      expect(await read("contributing.md")).toContain("(/wiki/web-app/architecture)");
      const manifest = await readManifest(join(root, ".wiki-cache/manifest.json"));
      expect(manifest.files).toBeUndefined();
    });

    it("re-renders links when a project identifier changes", async () => {
      await runSync(options(await CountingSource.fromFile(FIXTURE)));
      const fixture = await loadFixture();
      fixture.pages.find((p) => p.id === WEB)!.project_wiki = {
        project_id: "dddddddd-0000-4000-8000-000000000001",
        identifier: "MOB",
        name: "Web App",
      };
      const source = new CountingSource(fixture, FIXTURE_DIR);
      await runSync(options(source));
      expect(source.getPageCalls).toHaveLength(16);
      // sorted by sort_order: Web App (1500) keeps "mob", Mobile (2500) is deduped to "mob-2"
      expect(await read("contributing.md")).toContain("(/wiki/projects/mob/architecture)");
      expect(await read("contributing.md")).toContain("[Mobile](/wiki/projects/mob-2)");
      const files = await listFiles(join(root, "wiki"));
      expect(files.filter((f) => f.startsWith("projects/web"))).toEqual([]);
      expect(files).toEqual(expect.arrayContaining(["projects/mob/architecture/index.md", "projects/mob-2/index.md"]));
    });
  });

  it("does not update the manifest when a page fails", async () => {
    const source = await CountingSource.fromFile(FIXTURE);
    source.getPage = async () => {
      throw new Error("boom");
    };
    await expect(runSync(options(source))).rejects.toThrow(/page\(s\) failed/);
    await expect(stat(join(root, ".wiki-cache/manifest.json"))).rejects.toThrow();
  });

  it("drops images whose download fails and warns", async () => {
    const fixture = await loadFixture();
    fixture.assets = {};
    await runSync(options(new FixtureSource(fixture, FIXTURE_DIR)));
    const smoke = await readFile(join(root, "wiki/smoke-fixture-mdx-check.md"), "utf8");
    expect(smoke).not.toContain("wiki-assets");
    expect(logs.some((l) => l.startsWith("warn: asset aaaaaaaa"))).toBe(true);
  });

  it("exports files linked through Plane's download route next to the images", async () => {
    const CACHED = "bbbbbbbb-0000-4000-8000-000000000001";
    const FETCHED = "bbbbbbbb-0000-4000-8000-000000000002";
    const GONE = "bbbbbbbb-0000-4000-8000-000000000003";
    const fixture = await loadFixture();
    fixture.pages.push({
      id: "0000000f-0000-4000-8000-00000000000f",
      name: "Branding",
      parent: null,
      sort_order: 99_000,
      updated_at: "2026-10-01T00:00:00Z",
      description_html: [
        "<table><tbody><tr>",
        `<td><p><a target="_blank" rel="noopener" href="${download(CACHED)}">Vector</a></p></td>`,
        `<td><p><a href="https://plane.example.com${download(FETCHED)}">4000px</a></p></td>`,
        `<td><p><a href="${download(GONE)}">Removed</a></p></td>`,
        "</tr></tbody></table>",
        `<p><a href="https://elsewhere.example.com${download(FETCHED)}">Other host</a> and <a href="${download(CACHED)}">again</a></p>`,
      ].join(""),
    } as TWikiFixture["pages"][number]);
    const fetched: string[] = [];
    class FileSource extends FixtureSource {
      override async getAssetUrl(assetId: string) {
        if (assetId.startsWith("bbbbbbbb")) fetched.push(assetId);
        if (assetId === FETCHED) {
          return {
            asset_id: assetId,
            asset_url: "https://s3.example.com/x?sig=1",
            asset_name: "logo-4000.png",
            asset_type: "image/png",
          };
        }
        if (assetId === CACHED) {
          return {
            asset_id: assetId,
            asset_url: "https://s3.example.com/y",
            asset_name: "logo.svg",
            asset_type: "image/svg+xml",
          };
        }
        if (assetId === GONE) throw new PlaneApiError(404, `assets/${assetId}/`, '{"error":"Asset not found"}');
        return super.getAssetUrl(assetId);
      }
      override async download(url: string) {
        if (url.startsWith("https://s3.example.com/x"))
          return { data: new Uint8Array([1, 2, 3]), contentType: "image/png" };
        if (url.startsWith("https://s3.example.com/")) throw new Error("cached files must not be downloaded");
        return super.download(url);
      }
    }
    const assetsDir = join(root, "static/wiki-assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(assetsDir, `${CACHED}.svg`), "<svg/>");

    await runSync(options(new FileSource(fixture, FIXTURE_DIR)));
    const page = await readFile(join(root, "wiki/branding.md"), "utf8");
    expect(page).toContain(`[Vector](/wiki-assets/${CACHED}.svg)`);
    expect(page).toContain(`[4000px](/wiki-assets/${FETCHED}.png)`);
    expect(page).toContain(`[again](/wiki-assets/${CACHED}.svg)`);
    // a missing asset keeps its text without a link
    expect(page).toMatch(/\| Removed \|/);
    expect(page).not.toContain(GONE);
    // another host is not Plane: left alone
    expect(page).toContain(`[Other host](https://elsewhere.example.com${download(FETCHED)})`);
    expect(fetched.toSorted()).toEqual([FETCHED, GONE]);
    expect([...(await readFile(join(assetsDir, `${FETCHED}.png`)))]).toEqual([1, 2, 3]);
    expect(logs).toContainEqual(
      expect.stringMatching(new RegExp(`^warn: asset ${GONE}: download failed, link kept as text`))
    );
    const manifest = await readManifest(join(root, ".wiki-cache/manifest.json"));
    expect(manifest.pages["0000000f-0000-4000-8000-00000000000f"]?.assets).toEqual([`${CACHED}.svg`, `${FETCHED}.png`]);

    // a second run neither refetches nor deletes the files
    fetched.length = 0;
    await runSync(options(new FileSource(fixture, FIXTURE_DIR), { force: true }));
    expect(fetched).toEqual([GONE]);
    expect(await listFiles(assetsDir)).toEqual(expect.arrayContaining([`${CACHED}.svg`, `${FETCHED}.png`]));
  });
});
