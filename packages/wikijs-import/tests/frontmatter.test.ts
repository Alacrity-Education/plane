/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../src/frontmatter";
import { toSourcePage } from "../src/source";

describe("parseFrontMatter", () => {
  it("parses markdown front matter", () => {
    const { meta, body } = parseFrontMatter(
      [
        "---",
        "title: Demo: a page",
        "description: Something",
        "published: true",
        "date: 2026-06-19T23:47:15.753Z",
        "tags: guide, public",
        "editor: markdown",
        "dateCreated: 2026-05-12T00:19:52.031Z",
        "---",
        "",
        "# Hello",
      ].join("\n"),
      "markdown"
    );
    expect(meta).toEqual({
      title: "Demo: a page",
      description: "Something",
      published: true,
      date: "2026-06-19T23:47:15.753Z",
      tags: ["guide", "public"],
      editor: "markdown",
      dateCreated: "2026-05-12T00:19:52.031Z",
    });
    expect(body.trim()).toBe("# Hello");
  });

  it("parses the metadata comment of HTML pages", () => {
    const { meta, body } = parseFrontMatter(
      "<!--\ntitle: Meeting\npublished: false\ntags: \neditor: ckeditor\n-->\n\n<p>Hi</p>\n",
      "html"
    );
    expect(meta.title).toBe("Meeting");
    expect(meta.published).toBe(false);
    expect(meta.tags).toEqual([]);
    expect(meta.editor).toBe("ckeditor");
    expect(body.trim()).toBe("<p>Hi</p>");
  });

  it("handles quoted values and CRLF line endings", () => {
    const { meta } = parseFrontMatter("---\r\ntitle: 'Quoted'\r\ntags: [a, \"b\"]\r\n---\r\nx", "markdown");
    expect(meta.title).toBe("Quoted");
    expect(meta.tags).toEqual(["a", "b"]);
  });

  it("returns the content unchanged without front matter", () => {
    const { meta, body } = parseFrontMatter("# Just text", "markdown");
    expect(meta.tags).toEqual([]);
    expect(body).toBe("# Just text");
  });

  it("derives the wiki path and key from the file name", () => {
    const page = toSourcePage("Courses/Airbox%20Online%20Bootcamp/E2.md", "---\ntitle: E2\n---\n");
    expect(page?.path).toBe("Courses/Airbox Online Bootcamp/E2");
    expect(page?.key).toBe("courses/airboxonlinebootcamp/e2");
    expect(page?.format).toBe("markdown");
    expect(toSourcePage("x/script.sh", "")).toBeNull();
  });
});
