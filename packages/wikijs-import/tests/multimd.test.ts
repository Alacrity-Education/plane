/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { buildDescription } from "../src/editor-doc";
import type { TResolvedImage } from "../src/html";
import { toEditorHtml } from "../src/html";
import { markdownToHast } from "../src/markdown";
import { extractMultimdTables } from "../src/multimd";
import type { TWarning } from "../src/types";

const ID = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const IMAGES: Record<string, TResolvedImage> = {
  "/a.png": { assetId: ID(1), width: 1200, height: 600 },
  "/b.png": { assetId: ID(2), width: 1200, height: 600 },
  "/c.png": { assetId: ID(3), width: 400, height: 400 },
};

function convert(markdown: string) {
  const warnings: TWarning[] = [];
  const result = toEditorHtml(markdownToHast(markdown, warnings, "T"), {
    path: "T",
    warnings,
    images: new Map(Object.entries(IMAGES)),
    resolveLink: (href) => href,
  });
  return { ...result, warnings };
}

const FIGURE = ["| ![a.png](/a.png) |", "| Diode construction.<br>Electron **pressure** |", "| -- |"].join("\n");
const STEPS = [
  "| Click the Login button | Select the **Alacrity** provider | Done |",
  "| ![a](/a.png) | ![b](/b.png) | ![c](/c.png =50%x50%) |",
  "| -- | -- | -- |",
].join("\n");
const SCHEDULE = ["| -- |", "| 15:00 - 15:15 | Everyone arrives |||", "| 15:15 - 16:00 | Introduction |||"].join("\n");
const CONTINUED = [
  "| Spec | A | B |",
  "|---|---|---|",
  "| CPU | x | y |",
  "",
  "| Wi-Fi | 6 | 4 |",
  "| USB | 2.0 | 1.1 |",
].join("\n");

describe("extractMultimdTables", () => {
  it("leaves plain GFM tables and fenced code to remark", () => {
    const source = "| A | B |\n| - | - |\n| 1 | 2 |\n\n```\n| ![x](/x.png) |\n| caption |\n| -- |\n```";
    expect(extractMultimdTables(source)).toEqual({ markdown: source, tables: [] });
  });

  it("reads header rows above the delimiter, a missing header and colspans", () => {
    const { markdown, tables } = extractMultimdTables(`Intro\n${FIGURE}\nAfter\n\n${SCHEDULE}`);
    expect(markdown).toBe(
      'Intro\n\n<div data-wikijs-table="0"></div>\n\nAfter\n\n\n<div data-wikijs-table="1"></div>\n'
    );
    expect(tables[0]).toMatchObject({ columns: 1, body: [], continuation: false });
    expect(tables[0]?.header.map((row) => row.map((c) => c.text))).toEqual([
      ["![a.png](/a.png)"],
      ["Diode construction.<br>Electron **pressure**"],
    ]);
    expect(tables[1]).toMatchObject({ columns: 4, header: [] });
    expect(tables[1]?.body[0]).toEqual([
      { text: "15:00 - 15:15", colspan: 1 },
      { text: "Everyone arrives", colspan: 3 },
    ]);
  });

  it("appends delimiter-less rows after a blank line to the table above", () => {
    const { tables } = extractMultimdTables(CONTINUED);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.continuation).toBe(true);
    expect(tables[0]?.header).toHaveLength(1);
    expect(tables[0]?.body.map((row) => row[0]?.text)).toEqual(["CPU", "Wi-Fi", "USB"]);
  });

  it("takes over GFM-looking tables GFM would reject or cut", () => {
    // delimiter narrower than the header: not a GFM table at all
    expect(extractMultimdTables("| a | b |\n| -- |\n| 1 | 2 |").tables[0]?.columns).toBe(2);
    // a body row wider than the header: GFM drops its extra cells, markdown-it keeps them
    expect(extractMultimdTables("| a | b |\n|---|---|\n| 1 | 2 | 3 |").tables[0]?.columns).toBe(3);
  });

  it("keeps escaped pipes inside a cell", () => {
    const { tables } = extractMultimdTables("| a \\| b | c |\n| d | e |\n| -- | -- |");
    expect(tables[0]?.header[0]?.map((c) => c.text)).toEqual(["a \\| b", "c"]);
  });
});

describe("multimd tables → editor HTML", () => {
  it("renders a one-column image + caption table as an image and a centred italic caption", () => {
    const { html } = convert(FIGURE);
    expect(html).toBe(
      `<image-component src="${ID(1)}" width="720px" height="360px" aspectratio="2" alignment="left" status="uploaded"></image-component>` +
        '<p style="text-align: center"><em>Diode construction.<br>Electron <strong>pressure</strong></em></p>'
    );
  });

  it("renders a framed image without caption as a plain image", () => {
    expect(convert("| ![a](/a.png =50%x50%) |\n| -- |").html).toBe(
      `<image-component src="${ID(1)}" width="360px" height="180px" aspectratio="2" alignment="left" status="uploaded"></image-component>`
    );
  });

  it("joins several caption rows with line breaks", () => {
    const { html } = convert("| ![a](/a.png =50%x50%) |\n| First |\n| Second |\n| -- |");
    expect(html).toContain('width="360px"');
    expect(html).toContain('<p style="text-align: center"><em>First<br>Second</em></p>');
  });

  it("keeps screenshots inside header cells of a step table, sized to the column", () => {
    const { html } = convert(STEPS);
    expect(html).toMatch(/^<table><tbody><tr><th colwidth="240"><p>Click the Login button<\/p><\/th>/);
    expect(html).not.toContain("<td");
    expect(html).toContain(`<th colwidth="240"><image-component src="${ID(1)}" width="218px" height="109px"`);
    // =50% is relative to the column
    expect(html).toContain(`<th colwidth="240"><image-component src="${ID(3)}" width="109px"`);
  });

  it("renders colspans and headerless tables with body cells only", () => {
    const { html } = convert(SCHEDULE);
    expect(html).toBe(
      "<table><tbody>" +
        '<tr><td><p>15:00 - 15:15</p></td><td colspan="3"><p>Everyone arrives</p></td></tr>' +
        '<tr><td><p>15:15 - 16:00</p></td><td colspan="3"><p>Introduction</p></td></tr>' +
        "</tbody></table>"
    );
  });

  it("supports several header rows over a normal header and pads short rows", () => {
    const { html } = convert("| Table `meets` |||\n| Column | Type | Notes |\n|---|---|---|\n| id | string |");
    expect(html).toBe(
      "<table><tbody>" +
        '<tr><th colspan="3"><p>Table <code>meets</code></p></th></tr>' +
        "<tr><th><p>Column</p></th><th><p>Type</p></th><th><p>Notes</p></th></tr>" +
        "<tr><td><p>id</p></td><td><p>string</p></td><td><p></p></td></tr>" +
        "</tbody></table>"
    );
  });

  it("merges continuation rows and warns", () => {
    const { html, warnings } = convert(CONTINUED);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain("<tr><td><p>USB</p></td><td><p>2.0</p></td><td><p>1.1</p></td></tr>");
    expect(html).not.toContain("<p>|</p>");
    expect(warnings.map((w) => w.message)).toContain(
      "table rows after a blank line were appended to the table above them"
    );
  });

  it("keeps cell text that looks like a block as text", () => {
    const { html } = convert("| - not a list | 1. not a list |\n| # no heading | x |\n| -- | -- |");
    expect(html).toContain("<th><p>- not a list</p></th><th><p>1. not a list</p></th>");
    expect(html).toContain("<th><p># no heading</p></th>");
  });
});

describe("multimd tables through the editor schema", () => {
  it("keeps figures, images in cells, colspans, headerless and continued tables", async () => {
    const markdown = [FIGURE, "", STEPS, "", SCHEDULE, "", CONTINUED].join("\n");
    const { html } = convert(markdown);
    const result = await buildDescription(html, "Title");
    const out = result.description_html;
    // figure: image block + centred italic caption (the server-side HTML serializer omits the
    // alignment, the document itself keeps it, which is what the editor renders)
    expect(out).toMatch(/<image-component[^>]*src="00000000-0000-0000-0000-000000000001"/);
    expect(out).toMatch(/<p[^>]*><em>Diode construction\.<\/em><br><em>Electron <\/em><strong><em>pressure/);
    const json = result.description_json as { content: { type: string; attrs?: Record<string, unknown> }[] };
    expect(json.content[1]).toMatchObject({ type: "paragraph", attrs: { textAlign: "center" } });
    // step table: header cells holding the image blocks, with the column width kept
    expect(out).toMatch(/<th[^>]*colwidth="240"[^>]*><p[^>]*>Click the Login button<\/p><\/th>/);
    expect(out).toMatch(/<th[^>]*colwidth="240"[^>]*><image-component[^>]*src="00000000-0000-0000-0000-000000000003"/);
    // schedule: colspan body cells
    expect(out).toMatch(/<td[^>]*colspan="3"[^>]*><p[^>]*>Everyone arrives<\/p><\/td>/);
    // continuation rows are part of the same table
    expect(out.match(/<table/g)).toHaveLength(3);
    expect(out).toMatch(/<td[^>]*><p[^>]*>USB<\/p><\/td>/);
    expect(out).not.toMatch(/<p[^>]*>\|<\/p>/);
  });
});
