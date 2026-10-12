/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import type { TConvertContext, TResolvedImage } from "../src/html";
import { collectImageSources, computeImageSize, EDITOR_CONTENT_WIDTH, toEditorHtml } from "../src/html";
import { htmlToHast, markdownToHast, preprocessMarkdown } from "../src/markdown";
import type { TWarning } from "../src/types";

function convertMd(markdown: string, images: Record<string, TResolvedImage> = {}, links: Record<string, string> = {}) {
  const warnings: TWarning[] = [];
  const ctx: TConvertContext = {
    path: "Test/page",
    warnings,
    images: new Map(Object.entries(images)),
    resolveLink: (href) => (href in links ? (links[href] ?? null) : href.startsWith("/") ? null : href),
  };
  const result = toEditorHtml(markdownToHast(markdown, warnings, "Test/page"), ctx);
  return { ...result, warnings };
}

function convertHtml(source: string, images: Record<string, TResolvedImage> = {}) {
  const warnings: TWarning[] = [];
  const result = toEditorHtml(htmlToHast(source), {
    path: "Test/page",
    warnings,
    images: new Map(Object.entries(images)),
    resolveLink: (href) => href,
  });
  return { ...result, warnings };
}

describe("markdown → editor HTML", () => {
  it("converts headings, paragraphs and inline marks", () => {
    const { html } = convertMd("# Title\n\n## Sub\n\nSome **bold**, *em*, ~~gone~~ and `code`.\n\n---\n\n###### Small");
    expect(html).toBe(
      "<h1>Title</h1><h2>Sub</h2><p>Some <strong>bold</strong>, <em>em</em>, <s>gone</s> and <code>code</code>.</p><hr><h6>Small</h6>"
    );
  });

  it("converts bullet and ordered lists with nesting", () => {
    const { html } = convertMd("* one\n  * nested\n* two\n\n3. three\n4. four");
    expect(html).toBe(
      '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul><ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>'
    );
  });

  it("converts GFM task lists to Plane task items", () => {
    const { html } = convertMd("- [x] done\n- [ ] todo\n  - [ ] nested");
    expect(html).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li>' +
        '<li data-type="taskItem" data-checked="false"><p>todo</p><ul data-type="taskList">' +
        '<li data-type="taskItem" data-checked="false"><p>nested</p></li></ul></li></ul>'
    );
  });

  it("converts tables with paragraphs in every cell", () => {
    const { html } = convertMd("| A | B |\n| --- | --- |\n| 1 | **2** |\n| | x |");
    expect(html).toBe(
      "<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p><strong>2</strong></p></td></tr>" +
        "<tr><td><p></p></td><td><p>x</p></td></tr></tbody></table>"
    );
  });

  it("converts fenced code and records the language", () => {
    const result = convertMd(
      "```c\nint main() { return 0; }\n```\n\n```\nplain\n```\n\n```c++\nx\n```\n\n```weird\ny\n```"
    );
    expect(result.html).toBe(
      '<pre><code class="language-c">int main() { return 0; }</code></pre><pre><code>plain</code></pre>' +
        '<pre><code class="language-cpp">x</code></pre><pre><code>y</code></pre>'
    );
    expect(result.codeLanguages).toEqual(["c", null, "cpp", null]);
  });

  it("converts Wiki.js callouts (marker on the next line) to Plane callouts", () => {
    const { html } = convertMd("> Careful here\n{.is-warning}\n\n> Plain quote");
    expect(html).toContain('data-block-type="callout-component"');
    expect(html).toContain('data-background="orange"');
    expect(html).toContain('data-emoji-unicode="9888-65039"');
    expect(html).toContain("<p>Careful here</p></div>");
    expect(html).toContain("<blockquote><p>Plain quote</p></blockquote>");
    expect(html).not.toContain("is-warning");
  });

  it("converts callouts with a blank line or a comment marker, and keeps lists inside", () => {
    const blank = convertMd("> Info text\n\n{.is-info}\n").html;
    expect(blank).toContain('data-background="light-blue"');
    expect(blank).not.toContain("{.is-info}");

    const comment = convertMd("> Special tags:\n> * `public` forces\n<!-- {blockquote:.is-success} -->\n").html;
    expect(comment).toContain('data-background="green"');
    expect(comment).toContain("<ul><li><p><code>public</code> forces</p></li></ul>");

    const danger = convertMd("> a\n{.is-danger}").html;
    expect(danger).toContain('data-background="peach"');
  });

  it("drops a marker in the middle of a quote and still makes it a callout", () => {
    const { html } = convertMd("> first\n{.is-info}\n> second");
    expect(html).toContain('data-background="light-blue"');
    expect(html).not.toContain("{.is-info}");
  });

  it("turns images into image components with the Wiki.js size suffix as width", () => {
    const images = { "/img/photo.png": { assetId: "asset-1", width: 1000, height: 500 } };
    const { html } = convertMd("Look:\n\n![A photo](/img/photo.png =50%x50%){.align-center}\n\nAfter", images);
    expect(html).toBe(
      "<p>Look:</p>" +
        `<image-component src="asset-1" width="${EDITOR_CONTENT_WIDTH / 2}px" height="${EDITOR_CONTENT_WIDTH / 4}px" aspectratio="2" alignment="center" status="uploaded"></image-component>` +
        "<p>After</p>"
    );
  });

  it("hoists inline images out of paragraphs and keeps the text around them", () => {
    const images = { "/a(1).png": { assetId: "a1", width: 200, height: 100 } };
    const { html } = convertMd("Before **bold ![x](/a(1).png) more** after", images);
    expect(html).toBe(
      "<p>Before <strong>bold </strong></p>" +
        '<image-component src="a1" width="200px" height="100px" aspectratio="2" alignment="left" status="uploaded"></image-component>' +
        "<p><strong> more</strong> after</p>"
    );
  });

  it("marks unavailable images instead of failing", () => {
    const { html } = convertMd("![lost](/missing.png)");
    expect(html).toBe("<p><em>[image not available: lost]</em></p>");
  });

  it("turns draw.io diagrams into images", () => {
    const hast = markdownToHast("```diagram\nPHN2Zz48L3N2Zz4=\n```");
    expect(collectImageSources(hast)).toEqual(["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="]);
  });

  it("rewrites resolved internal links and keeps the text of unresolved ones", () => {
    const { html } = convertMd(
      "[ok](/Courses/x), [gone](/Nope/page) and [ext](https://example.com)",
      {},
      {
        "/Courses/x": "/ws/wiki/123",
      }
    );
    expect(html).toBe('<p><a href="/ws/wiki/123">ok</a>, gone and <a href="https://example.com">ext</a></p>');
  });

  it("replaces iframes with a link and warns", () => {
    const { html, warnings } = convertMd('<iframe src="https://example.com/embed"></iframe>');
    expect(html).toBe('<p>Embedded content: <a href="https://example.com/embed">https://example.com/embed</a></p>');
    expect(warnings[0]?.message).toContain("iframe");
  });

  it("keeps the size suffix untouched inside code fences", () => {
    const input = "```\n![x](/a.png =10%x)\n```";
    expect(preprocessMarkdown(input)).toBe(input);
    expect(preprocessMarkdown("![x](/a.png =10%x)")).toBe('![x](/a.png "=10%x")');
  });
});

describe("ckeditor HTML → editor HTML", () => {
  it("keeps the supported subset", () => {
    const { html } = convertHtml(
      '<h2><strong>Day 1</strong></h2>\n<p style="text-align:center;">Hi <i>there</i> <u>u</u> <mark class="marker-yellow">hl</mark>&nbsp;</p>\n' +
        "<ul>\n  <li>One<ul><li>Sub</li></ul></li>\n</ul>"
    );
    expect(html).toBe(
      '<h2><strong>Day 1</strong></h2><p>Hi <em>there</em> <u>u</u> <span data-background-color="orange">hl</span></p>' +
        "<ul><li><p>One</p><ul><li><p>Sub</p></li></ul></li></ul>"
    );
  });

  it("converts ckeditor todo lists", () => {
    const { html } = convertHtml(
      '<ul class="todo-list"><li><label class="todo-list__label"><input type="checkbox" disabled="disabled" checked="checked">' +
        '<span class="todo-list__label__description">Done</span></label></li>' +
        '<li><label class="todo-list__label"><input type="checkbox" disabled="disabled"><span>Open</span></label></li></ul>'
    );
    expect(html).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li>' +
        '<li data-type="taskItem" data-checked="false"><p>Open</p></li></ul>'
    );
  });

  it("unwraps figure tables and converts callout quotes", () => {
    const { html } = convertHtml(
      '<figure class="table"><table><tbody><tr><td>a</td><td><strong>b</strong></td></tr></tbody></table></figure>' +
        '<blockquote class="is-danger"><p>Stop</p></blockquote>'
    );
    expect(html).toContain(
      "<table><tbody><tr><td><p>a</p></td><td><p><strong>b</strong></p></td></tr></tbody></table>"
    );
    expect(html).toContain('data-background="peach"');
  });

  it("drops scripts and styles", () => {
    const { html } = convertHtml("<style>p{}</style><script>alert(1)</script><p>ok</p>");
    expect(html).toBe("<p>ok</p>");
  });
});

describe("computeImageSize", () => {
  const image = { assetId: "x", width: 1600, height: 800 };
  it("maps percentages onto the editor width", () => {
    expect(computeImageSize(image, { width: { value: 30, unit: "%" } })).toEqual({
      width: Math.round(EDITOR_CONTENT_WIDTH * 0.3),
      height: Math.round((EDITOR_CONTENT_WIDTH * 0.3) / 2),
      aspectRatio: 2,
    });
  });
  it("uses pixel widths and caps at the editor width", () => {
    expect(computeImageSize(image, { width: { value: 300, unit: "px" } }).width).toBe(300);
    expect(computeImageSize(image, {}).width).toBe(EDITOR_CONTENT_WIDTH);
    expect(computeImageSize({ assetId: "x", width: 100, height: 50 }, {}).width).toBe(100);
  });
  it("derives the width from a pixel height", () => {
    expect(computeImageSize(image, { height: { value: 100, unit: "px" } })).toMatchObject({ width: 200, height: 100 });
  });
});
