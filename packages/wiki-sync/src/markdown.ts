/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// TipTap HTML -> CommonMark for Docusaurus `format: md`.
//
// Same unified pipeline as Plane's convertHTMLToMarkdown (vendored in ./vendor/markdown-parser):
// rehype-parse -> addSpacesToCheckboxes -> rehype-remark -> remark-gfm -> remark-stringify, with
// three deliberate differences:
// 1. the rehype pre-pass in ./preprocess resolves images/mentions/callouts/links first;
// 2. handlers return real mdast nodes and remark-stringify keeps its default *escaping* text
//    handler (upstream disables escaping, so "<div>" typed in a paragraph became live HTML once
//    Docusaurus runs rehype-raw);
// 3. emphasis/underline use the default handlers (upstream's i/em handler drops nested marks).
// Output is CommonMark + GFM only, never MDX.

import type { Element } from "hast";
import { toHtml } from "hast-util-to-html";
import { defaultHandlers, type Handle } from "hast-util-to-mdast";
import type { Html, Image, Root as MdastRoot } from "mdast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { CALLOUT_TAG, FILE_LINK_ATTRIBUTE, rehypeWikiPreprocess, type TPreprocessContext } from "./preprocess";
import { addSpacesToCheckboxes } from "./vendor/markdown-parser";

const html = (value: string): Html => ({ type: "html", value });

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

const isElement = (node: unknown): node is Element =>
  typeof node === "object" && node !== null && (node as Element).type === "element";

const escapeHtmlAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A table GFM can express: no merged cells, one paragraph (or plain text) or one image per cell.
 * An image block alone in a cell (screenshot tables) becomes an inline image; line breaks are
 * written as `<br>` (see the table handler).
 */
export function isSimpleTable(table: Element): boolean {
  const rows: Element[] = [];
  const collectRows = (node: Element) => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.tagName === "tr") rows.push(child);
      else if (["thead", "tbody", "tfoot"].includes(child.tagName)) collectRows(child);
      // anything else directly inside the table makes it non-simple (checked below)
      else if (child.tagName !== "colgroup" && child.tagName !== "caption") rows.push(child);
    }
  };
  collectRows(table);
  if (rows.length === 0) return false;
  let width = -1;
  for (const row of rows) {
    if (row.tagName !== "tr") return false;
    const cells = row.children.filter(isElement);
    if (cells.some((c) => c.tagName !== "td" && c.tagName !== "th")) return false;
    if (width !== -1 && cells.length !== width) return false;
    width = cells.length;
    for (const cell of cells) {
      if (Number(cell.properties?.colSpan ?? 1) > 1 || Number(cell.properties?.rowSpan ?? 1) > 1) return false;
      const blocks = cell.children.filter((c) => isElement(c) || (c.type === "text" && c.value.trim() !== ""));
      if (blocks.length > 1) return false;
      const only = blocks[0];
      if (only && isElement(only) && only.tagName !== "p" && only.tagName !== "img") return false;
      if (only && isElement(only) && !isPhrasingOnly(only)) return false;
    }
  }
  return true;
}

const BLOCK_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "pre",
  "table",
  "blockquote",
  "div",
  "hr",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const isPhrasingOnly = (node: Element): boolean =>
  node.children.every(
    (child) => !isElement(child) || child.tagName === "br" || (!BLOCK_TAGS.has(child.tagName) && isPhrasingOnly(child))
  );

const CELL_BREAK_TAG = "wiki-cell-break";

/** GFM cells cannot hold a hard break (hast-util-to-mdast turns it into a space): keep `<br>`. */
function markCellBreaks(node: Element): void {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (child.tagName === "br") child.tagName = CELL_BREAK_TAG;
    else markCellBreaks(child);
  }
}

/** Prefixes a root-relative URL with the site's base URL (Docusaurus does this for Markdown only). */
export function withBaseUrl(url: string, baseUrl = "/"): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const base = baseUrl.replace(/\/+$/, "");
  return base && !url.startsWith(`${base}/`) ? `${base}${url}` : url;
}

/** Serialises a table as one CommonMark HTML block (no blank lines, which would end the block). */
export function tableToRawHtml(table: Element, baseUrl = "/"): string {
  visit(table, "element", (node) => {
    if (node.tagName === "img" && node.properties) {
      node.properties.src = withBaseUrl(str(node.properties.src), baseUrl);
      return;
    }
    if (node.tagName !== "a" || !node.properties?.[FILE_LINK_ATTRIBUTE]) return;
    delete node.properties[FILE_LINK_ATTRIBUTE];
    const href = str(node.properties.href);
    if (href.startsWith("/")) node.properties.href = `pathname://${href}`;
  });
  return toHtml(table, { closeSelfClosing: true }).replace(/\n\s*\n/g, "\n");
}

const createHandlers = (baseUrl: string): Record<string, Handle> => ({
  img: (state, node) => {
    const url = str(node.properties?.src);
    if (!url) return undefined;
    const image: Image = { type: "image", url, alt: str(node.properties?.alt), title: null };
    state.patch(node, image);
    return image;
  },
  table: (state, node) => {
    if (!isSimpleTable(node)) return html(tableToRawHtml(node, baseUrl));
    markCellBreaks(node);
    return defaultHandlers.table(state, node);
  },
  [CELL_BREAK_TAG]: () => html("<br>"),
  [CALLOUT_TAG]: (state, node) => {
    const props = node.properties ?? {};
    const body = state.toFlow(state.all(node));
    if (str(props.dataMode) === "html") {
      const background = str(props.dataBackground);
      const emoji = str(props.dataTitle);
      const open =
        `<div class="plane-callout${background ? ` plane-callout--${escapeHtmlAttr(background)}` : ""}">` +
        (emoji ? `<span class="plane-callout__emoji">${escapeHtmlAttr(emoji)}</span>` : "");
      return [html(open), ...body, html("</div>")];
    }
    const fence = str(props.dataFence) || ":::";
    const title = str(props.dataTitle).replace(/[[\]\\]/g, "");
    return [html(`${fence}${str(props.dataKind) || "note"}${title ? `[${title}]` : ""}`), ...body, html(fence)];
  },
});

/**
 * TipTap has no loose lists, but every <li> wraps its text in <p>, which hast-util-to-mdast reads
 * as "spread". Make lists tight unless an item really holds several paragraphs/blocks.
 */
function remarkTightLists() {
  return (tree: MdastRoot) => {
    visit(tree, "list", (list) => {
      const tight = list.children.every((item) => item.children.filter((c) => c.type !== "list").length <= 1);
      if (!tight) return;
      list.spread = false;
      for (const item of list.children) item.spread = false;
    });
  };
}

export type TMarkdownContext = TPreprocessContext;

/** Converts a page's description_html to a CommonMark body (no front matter). */
export function convertWikiHtmlToMarkdown(descriptionHtml: string, ctx: TMarkdownContext): string {
  const file = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeWikiPreprocess, ctx)
    .use(addSpacesToCheckboxes)
    .use(rehypeRemark, { handlers: createHandlers(ctx.baseUrl ?? "/") })
    .use(remarkGfm)
    .use(remarkTightLists)
    .use(remarkStringify, {
      // ":::" typed at the start of a paragraph would otherwise open a Docusaurus admonition.
      unsafe: [{ character: ":", atBreak: true }],
      bullet: "-",
      emphasis: "_",
      strong: "*",
      rule: "-",
      fence: "`",
      fences: true,
      listItemIndent: "one",
      incrementListMarker: true,
    })
    .processSync(descriptionHtml ?? "");
  const markdown = String(file.value ?? file).trim();
  return markdown ? `${markdown}\n` : "";
}
