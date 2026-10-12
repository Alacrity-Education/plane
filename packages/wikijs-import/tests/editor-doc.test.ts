/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { buildDescription } from "../src/editor-doc";
import { toEditorHtml } from "../src/html";
import { markdownToHast } from "../src/markdown";

/** The generated HTML must survive the Plane document editor schema (what the web app renders). */
describe("buildDescription (editor schema round trip)", () => {
  it("keeps callouts, task items, images, tables and code languages", async () => {
    const markdown = [
      "# Heading",
      "",
      "> Note this",
      "{.is-info}",
      "",
      "- [x] done",
      "- [ ] open",
      "",
      "![pic](/p.png =50%x)",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```python",
      "print('hi')",
      "```",
    ].join("\n");
    const { html, codeLanguages } = toEditorHtml(markdownToHast(markdown), {
      path: "t",
      warnings: [],
      images: new Map([["/p.png", { assetId: "11111111-2222-3333-4444-555555555555", width: 800, height: 400 }]]),
      resolveLink: (href) => href,
    });
    const result = await buildDescription(html, "My title", codeLanguages);
    expect(result.codeBlockMismatch).toBe(false);
    expect(result.description_binary.length).toBeGreaterThan(10);
    const out = result.description_html;
    expect(out).toContain('data-block-type="callout-component"');
    expect(out).toContain('data-background="light-blue"');
    expect(out).toContain('data-type="taskItem"');
    expect(out).toMatch(/<li[^>]*data-checked[^>]*data-type="taskItem"/);
    expect(out).toContain('src="11111111-2222-3333-4444-555555555555"');
    expect(out).toContain('width="360px"');
    expect(out).toContain('status="uploaded"');
    expect(out).toContain("<table>");
    expect(out).toContain('<code class="language-python">');
    const json = JSON.stringify(result.description_json);
    expect(json).toContain('"type":"calloutComponent"');
    expect(json).toContain('"type":"imageComponent"');
    expect(json).toContain('"language":"python"');
  });

  it("keeps root-relative link hrefs (page links, file download links), also inside tables", async () => {
    const download = "/api/assets/v2/workspaces/acme/download/11111111-2222-3333-4444-555555555555/";
    const markdown = ["| Logo | |", "| -- | -- |", "| [Vector](/f.svg) | [Page](/other) |", "", "[PDF](/f.pdf)"].join(
      "\n"
    );
    const links: Record<string, string> = { "/f.svg": download, "/other": "/acme/wiki/page-1", "/f.pdf": download };
    const { html } = toEditorHtml(markdownToHast(markdown), {
      path: "t",
      warnings: [],
      images: new Map(),
      resolveLink: (href) => links[href] ?? null,
    });
    const result = await buildDescription(html, "Links", []);
    expect(result.description_html).toContain(`href="${download}"`);
    expect(result.description_html).toContain('href="/acme/wiki/page-1"');
    expect(result.description_html.match(new RegExp(`href="${download}"`, "g"))).toHaveLength(2);
    const json = JSON.stringify(result.description_json);
    expect(json).toContain(`"href":"${download}"`);
  });
});
