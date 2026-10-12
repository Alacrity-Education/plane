/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { createLinkResolver, parseLink } from "../src/links";

describe("parseLink", () => {
  it("classifies external links and anchors", () => {
    expect(parseLink("https://example.com/a", "x")).toEqual({ kind: "external" });
    expect(parseLink("mailto:a@b.c", "x")).toEqual({ kind: "external" });
    expect(parseLink("#section", "x")).toEqual({ kind: "anchor" });
    expect(parseLink("github.com/org/repo", "x")).toEqual({ kind: "external", href: "https://github.com/org/repo" });
  });

  it("normalizes internal paths", () => {
    expect(parseLink("/Courses/Airbox%20Online%20Bootcamp/E1#part", "x")).toEqual({
      kind: "internal",
      key: "courses/airboxonlinebootcamp/e1",
      hash: "#part",
    });
    expect(parseLink("/en/Projects/wikijs-fork", "x")).toMatchObject({ key: "projects/wikijs-fork" });
    expect(parseLink("E1_resources", "Courses/Bootcamp/E1")).toMatchObject({ key: "courses/bootcamp/e1_resources" });
    expect(parseLink("../other.md", "Courses/Bootcamp/E1")).toMatchObject({ key: "courses/other" });
  });

  it("keeps a real two-letter top folder when it exists", () => {
    expect(parseLink("/en/page", "x", new Set(["en/page"]))).toMatchObject({ key: "en/page" });
  });

  it("recognizes links to repository files", () => {
    expect(parseLink("/branding/logo.svg", "x")).toEqual({ kind: "file", path: "/branding/logo.svg" });
  });
});

describe("createLinkResolver", () => {
  it("rewrites internal links to Plane page URLs and records unresolved ones", () => {
    const resolver = createLinkResolver({
      fromPath: "Courses/Bootcamp/E1",
      workspaceSlug: "acme",
      pageIds: new Map([
        ["courses/bootcamp/e2", "id-e2"],
        ["account-setup", "id-acc"],
      ]),
    });
    expect(resolver.resolve("/Courses/Bootcamp/E2")).toBe("/acme/wiki/id-e2");
    expect(resolver.resolve("E2")).toBe("/acme/wiki/id-e2");
    expect(resolver.resolve("/en/account-setup")).toBe("/acme/wiki/id-acc");
    expect(resolver.resolve("https://plane.so")).toBe("https://plane.so");
    expect(resolver.resolve("/Missing/page")).toBeNull();
    expect(resolver.resolve("/files/doc.ics")).toBeNull();
    expect(resolver.unresolved).toEqual(["/Missing/page"]);
    expect(resolver.files).toEqual(["/files/doc.ics"]);
  });
});
