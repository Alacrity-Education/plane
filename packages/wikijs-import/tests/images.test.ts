/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepositoryImages, locateImage, probeImageSize, svgIntrinsicSize } from "../src/images";

/** Minimal PNG header (signature + IHDR) for a w×h image. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("probeImageSize / svgIntrinsicSize", () => {
  it("reads PNG and GIF headers", () => {
    expect(probeImageSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
    const gif = Buffer.from("GIF89a\x20\x00\x10\x00\x00\x00\x00", "latin1");
    expect(probeImageSize(gif)).toEqual({ width: 32, height: 16 });
    expect(probeImageSize(Buffer.from("nope"))).toBeNull();
  });

  it("reads the SVG size from attributes or the viewBox", () => {
    expect(svgIntrinsicSize('<svg xmlns="x" width="120px" height="60">')).toEqual({ width: 120, height: 60 });
    expect(svgIntrinsicSize('<svg viewBox="0 0 300 150">')).toEqual({ width: 300, height: 150 });
    expect(svgIntrinsicSize('<svg width="100%">')).toBeNull();
  });
});

describe("locateImage", () => {
  const repo = mkdtempSync(join(tmpdir(), "wikijs-img-"));
  const write = (file: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), pngHeader(1, 1));
  };
  write("root.png");
  write("Courses/Boot camp/moved(1).png");
  write("Guides/unique-name.png");
  const index = indexRepositoryImages(repo);

  it("resolves absolute paths, decoding %20", () => {
    expect(locateImage("/root.png", "home.md", repo, index)?.source).toEqual({
      kind: "file",
      file: join(repo, "root.png"),
    });
    expect(locateImage("/Courses/Boot%20camp/moved(1).png", "x.md", repo, index)?.note).toBeUndefined();
  });

  it("falls back to the page folder for images moved next to their page", () => {
    const found = locateImage("/moved(1).png", "Courses/Boot camp/page.md", repo, index);
    expect(found?.source).toEqual({ kind: "file", file: join(repo, "Courses/Boot camp/moved(1).png") });
    expect(found?.note).toContain("next to the page");
  });

  it("falls back to a unique file name anywhere in the repository", () => {
    expect(locateImage("/old/unique-name.png", "home.md", repo, index)?.note).toContain("by file name");
  });

  it("returns null for missing images and passes data/remote URLs through", () => {
    expect(locateImage("/nope.png", "home.md", repo, index)).toBeNull();
    expect(locateImage("data:image/svg+xml;base64,PHN2Zz4=", "home.md", repo, index)?.source).toMatchObject({
      kind: "data",
      mime: "image/svg+xml",
    });
    expect(locateImage("https://x.test/a.png", "home.md", repo, index)?.source).toEqual({
      kind: "remote",
      url: "https://x.test/a.png",
    });
  });
});
