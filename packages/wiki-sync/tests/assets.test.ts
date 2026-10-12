import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AssetStore,
  assetDownloadId,
  extractFileAssetIds,
  extractImageAssetIds,
  getAssetExtension,
} from "../src/assets";
import { FixtureSource } from "../src/fixture";

const FIXTURE = new URL("./fixtures/wiki-fixture.json", import.meta.url).pathname;
const IMAGE = "aaaaaaaa-0000-4000-8000-000000000001";
const DRAWING = "aaaaaaaa-0000-4000-8000-000000000002";
const MISSING = "aaaaaaaa-0000-4000-8000-000000000099";

describe("extractImageAssetIds", () => {
  it("collects image and excalidraw asset ids (deduped, lower-cased, UUIDs only)", () => {
    const html = [
      `<image-component id="x" src="${IMAGE}" status="uploaded"></image-component>`,
      `<excalidraw-component id="d1" src="${DRAWING.toUpperCase()}" width="100%" height="auto" aspectratio="1.5" alignment="left" status="uploaded"></excalidraw-component>`,
      `<excalidraw-component src='${IMAGE}'></excalidraw-component>`,
      `<excalidraw-component src="not-a-uuid"></excalidraw-component>`,
      `<excalidraw-component status="uploading"></excalidraw-component>`,
      `<img src="https://cdn.example.com/${MISSING}">`,
    ].join("");
    expect(extractImageAssetIds(html)).toEqual([IMAGE, DRAWING]);
  });
});

describe("AssetStore with excalidraw drawings", () => {
  let dir: string;
  const warnings: string[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wiki-assets-"));
    warnings.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("copies the drawing PNG and drops a drawing whose asset is missing", async () => {
    const source = await FixtureSource.fromFile(FIXTURE);
    const page = source.fixture.pages.find((p) => p.name === "Diagrams")!;
    const store = new AssetStore({
      source,
      dir,
      publicPath: "/wiki-assets",
      logger: { info: () => undefined, warn: (m) => warnings.push(m) },
    });
    const meta = new Map((page.assets ?? []).map((a) => [a.id, a]));
    const resolved = await Promise.all(
      extractImageAssetIds(page.description_html ?? "").map((id) => store.resolve(id, meta.get(id)))
    );
    expect(resolved).toEqual([
      {
        id: DRAWING,
        name: "system-overview.png",
        url: `/wiki-assets/${DRAWING}.png`,
        fileName: `${DRAWING}.png`,
      },
      expect.objectContaining({ id: IMAGE, fileName: `${IMAGE}.png` }),
      null,
    ]);
    expect((await readdir(dir)).toSorted()).toEqual([`${IMAGE}.png`, `${DRAWING}.png`]);
    const png = await readFile(join(dir, `${DRAWING}.png`));
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    expect(warnings).toEqual([expect.stringContaining(`asset ${MISSING}: download failed`)]);
  });
});

describe("linked file assets", () => {
  const ID = "cccccccc-0000-4000-8000-000000000001";
  const ctx = { workspaceSlug: "acme", planeUrl: "https://plane.example.com" };

  it("recognizes Plane download links (root-relative or on the Plane origin)", () => {
    expect(assetDownloadId(`/api/assets/v2/workspaces/acme/download/${ID}/`, ctx)).toBe(ID);
    expect(
      assetDownloadId(`https://plane.example.com/api/assets/v2/workspaces/acme/download/${ID.toUpperCase()}`, ctx)
    ).toBe(ID);
    expect(assetDownloadId(`/api/assets/v2/workspaces/acme/projects/${ID}/download/${ID}/`, ctx)).toBe(ID);
    expect(assetDownloadId(`https://other.example.com/api/assets/v2/workspaces/acme/download/${ID}/`, ctx)).toBeNull();
    expect(assetDownloadId(`/api/assets/v2/workspaces/other/download/${ID}/`, ctx)).toBeNull();
    expect(assetDownloadId("/acme/wiki/page", ctx)).toBeNull();
    expect(
      extractFileAssetIds(
        `<p><a target="_blank" href="/api/assets/v2/workspaces/acme/download/${ID}/">x</a><a href="#y">y</a></p>`,
        ctx
      )
    ).toEqual([ID]);
  });

  it("names linked files by their original extension first", () => {
    expect(getAssetExtension("image/svg+xml", "logo.svg", true)).toBe("svg");
    expect(getAssetExtension("application/octet-stream", "board.zip", true)).toBe("zip");
    expect(getAssetExtension("application/pdf", "no-extension", true)).toBe("pdf");
    expect(getAssetExtension("image/png", "photo.jpeg")).toBe("png");
  });
});
