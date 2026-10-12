/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedupePages, readSourcePages } from "../src/source";
import { buildTree, flattenTree, SORT_ORDER_STEP } from "../src/tree";
import type { TWarning } from "../src/types";
import { html, md } from "./helpers";

describe("buildTree", () => {
  const pages = [
    md("home.md", { title: "Home" }),
    md("about.md", { title: "About us" }),
    md("Courses/Bootcamp.md", { title: "Online Bootcamp" }, "Folder intro"),
    md("Courses/Bootcamp/b-lesson.md", { title: "Lesson B" }),
    md("Courses/Boot%20camp/a-lesson.md", { title: "Lesson A" }),
    md("Courses/Boot camp/c-lesson.md", { title: "lesson c" }),
    md("Projects/alpha.md", { title: "Alpha", tags: "public" }),
    md("Projects/Deep/beta.md", { title: "Beta" }),
    html("Meetings/notes.html", { title: "Notes" }),
  ];

  it("turns folders into pages and pages into their children", () => {
    const tree = buildTree(pages, []);
    expect(tree.roots.map((n) => n.title)).toEqual(["Home", "About us", "Courses", "Meetings", "Projects"]);
    const projects = tree.nodes.get("projects");
    expect(projects?.isFolder).toBe(true);
    expect(projects?.source).toBeUndefined();
    expect(projects?.children.map((n) => n.title)).toEqual(["Alpha", "Deep"]);
    expect(tree.nodes.get("projects/deep")?.children.map((n) => n.title)).toEqual(["Beta"]);
  });

  it("merges folder spelling variants and uses the auxiliary page", () => {
    const tree = buildTree(pages, []);
    const courses = tree.nodes.get("courses");
    expect(courses?.children).toHaveLength(1);
    const bootcamp = tree.nodes.get("courses/bootcamp");
    expect(bootcamp?.title).toBe("Online Bootcamp");
    expect(bootcamp?.source?.file).toBe("Courses/Bootcamp.md");
    expect(bootcamp?.path).toBe("Courses/Boot camp");
    // The auxiliary page is not a separate child
    expect(bootcamp?.children.map((n) => n.title)).toEqual(["Lesson A", "Lesson B", "lesson c"]);
  });

  it("orders siblings alphabetically by title with increasing sort_order, home first", () => {
    const tree = buildTree(pages, []);
    expect(tree.roots.map((n) => n.sortOrder)).toEqual([1, 2, 3, 4, 5].map((i) => i * SORT_ORDER_STEP));
    const lessons = tree.nodes.get("courses/bootcamp")?.children ?? [];
    expect(lessons.map((n) => n.sortOrder)).toEqual([SORT_ORDER_STEP, 2 * SORT_ORDER_STEP, 3 * SORT_ORDER_STEP]);
  });

  it("resolves visibility for pages and folders", () => {
    const tree = buildTree(pages, []);
    const vis = (key: string) => tree.nodes.get(key)?.visibility;
    expect(vis("home")).toBe("public");
    expect(vis("courses")).toBe("public");
    expect(vis("courses/bootcamp")).toBe("public");
    expect(vis("courses/bootcamp/b-lesson")).toBe("public");
    expect(vis("projects")).toBe("private");
    expect(vis("projects/alpha")).toBe("public");
    expect(vis("projects/deep")).toBe("private");
    expect(vis("projects/deep/beta")).toBe("private");
    expect(vis("meetings/notes")).toBe("private");
  });

  it("applies the auxiliary page's flags to its folder", () => {
    const tree = buildTree(
      [md("Courses/Hidden.md", { title: "Hidden", published: "false" }), md("Courses/Hidden/x.md", { title: "X" })],
      []
    );
    expect(tree.nodes.get("courses/hidden")?.visibility).toBe("private");
    expect(tree.nodes.get("courses/hidden/x")?.visibility).toBe("public");
  });

  it("lists parents before children", () => {
    const tree = buildTree(pages, []);
    const order = flattenTree(tree.roots).map((n) => n.key);
    expect(order.indexOf("projects")).toBeLessThan(order.indexOf("projects/deep"));
    expect(order.indexOf("projects/deep")).toBeLessThan(order.indexOf("projects/deep/beta"));
  });

  it("warns about top-level folders without a rule", () => {
    const warnings: TWarning[] = [];
    const tree = buildTree([md("Misc/x.md", { title: "X" })], warnings);
    expect(tree.nodes.get("misc/x")?.visibility).toBe("private");
    expect(warnings.map((w) => w.message).join()).toContain("no visibility rule");
  });
});

describe("dedupePages / readSourcePages", () => {
  it("keeps the most recent copy of a duplicated path", () => {
    const warnings: TWarning[] = [];
    const kept = dedupePages(
      [
        md("Courses/Boot%20camp/E2.md", { title: "Old", date: "2026-06-18T00:00:00Z" }),
        md("Courses/Bootcamp/E2.md", { title: "New", date: "2026-07-03T00:00:00Z" }),
      ],
      warnings
    );
    expect(kept.map((p) => p.meta.title)).toEqual(["New"]);
    expect(warnings[0]?.message).toContain("duplicate page");
  });

  it("reads .md and .html pages of a repository, skipping dot folders and other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "wikijs-"));
    const write = (file: string, content: string) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    };
    write("home.md", "---\ntitle: Home\n---\nHi");
    write("Guides/page.html", "<!--\ntitle: Page\neditor: ckeditor\n-->\n<p>x</p>");
    write("Guides/widget.html", "<div>no metadata</div>");
    write(".github/sync.md", "---\ntitle: Ignored\n---\n");
    write("Guides/image.png", "png");
    const warnings: TWarning[] = [];
    const pages = readSourcePages(dir, warnings);
    expect(pages.map((p) => p.file).toSorted()).toEqual(["Guides/page.html", "home.md"]);
    expect(warnings.some((w) => w.message.includes("without Wiki.js metadata"))).toBe(true);
  });
});
