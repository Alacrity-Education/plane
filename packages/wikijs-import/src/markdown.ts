/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Element, ElementContent, Root as HastRoot, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import type {
  Blockquote,
  Code,
  Html,
  Image,
  Nodes as MdastNodes,
  Paragraph,
  Parent,
  Root as MdastRoot,
  Text,
} from "mdast";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { TMultimdRow, TMultimdTable } from "./multimd";
import { extractMultimdTables, fencedLines } from "./multimd";
import type { TWarning } from "./types";

export const CALLOUT_KINDS = ["info", "warning", "success", "danger"] as const;
export type TCalloutKind = (typeof CALLOUT_KINDS)[number];

const CALLOUT_MARKER = /^\s*\{\.is-(info|warning|success|danger)\}\s*$/;
const CALLOUT_TRAILING = /\r?\n?[ \t]*\{\.is-(info|warning|success|danger)\}[ \t]*$/;
const CALLOUT_COMMENT = /^<!--\s*\{blockquote:\.is-(info|warning|success|danger)\}\s*-->$/;

/**
 * Wiki.js image size suffix: `![alt](/img.png =30%x30%)`. CommonMark does not accept the
 * suffix, so it is moved into the image title, where the converter reads it back.
 */
const IMAGE_WITH_SIZE = /!\[([^\]\n]*)\]\(\s*(\S+?)\s+=(\d*(?:\.\d+)?(?:%|px)?)x?(\d*(?:\.\d+)?(?:%|px)?)\s*\)/g;

export function preprocessMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const fenced = fencedLines(lines);
  return lines
    .map((line, index) => {
      if (fenced[index]) return line;
      return line.replace(IMAGE_WITH_SIZE, (_all, alt: string, src: string, w: string, h: string) => {
        const url = /[\s<>]/.test(src) ? `<${src}>` : src;
        return `![${alt}](${url} "=${w}x${h}")`;
      });
    })
    .join("\n");
}

function lastText(node: MdastNodes): Text | undefined {
  if (node.type === "text") return node;
  if ("children" in node && node.children.length) {
    return lastText(node.children[node.children.length - 1] as MdastNodes);
  }
  return undefined;
}

const CALLOUT_INNER = /\r?\n[ \t]*\{\.is-(info|warning|success|danger)\}[ \t]*(?=\r?\n)/;

function stripInnerMarkers(node: MdastNodes): string | undefined {
  let found: string | undefined;
  if (node.type === "text") {
    let match = CALLOUT_INNER.exec(node.value);
    while (match) {
      found = found ?? match[1];
      node.value = node.value.slice(0, match.index) + node.value.slice(match.index + match[0].length);
      match = CALLOUT_INNER.exec(node.value);
    }
    return found;
  }
  if ("children" in node) {
    for (const child of node.children as MdastNodes[]) found = stripInnerMarkers(child) ?? found;
  }
  return found;
}

const IMAGE_ATTRS = /^\{\.align-(left|center|right)\}/;

/** `![x](/a.png){.align-center}`: markdown-it-attrs syntax → alignment on the image. */
function applyImageAttributes(parent: Parent): void {
  const children = parent.children as MdastNodes[];
  for (let i = 0; i < children.length - 1; i++) {
    const node = children[i];
    const next = children[i + 1];
    if (node?.type !== "image" || next?.type !== "text") continue;
    const match = IMAGE_ATTRS.exec(next.value);
    if (!match) continue;
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataAlign: match[1] ?? "left" } };
    next.value = next.value.slice(match[0].length);
  }
}

function markCallout(node: Blockquote, kind: string): void {
  node.data = { ...node.data, hProperties: { className: [`is-${kind}`] } };
}

/** Turns Wiki.js callout markers into `blockquote.is-<kind>` and diagram fences into images. */
function transformMdast(tree: MdastRoot, warnings: TWarning[], path: string): void {
  const visit = (parent: Parent) => {
    const children = parent.children as MdastNodes[];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (!node) continue;
      if (node.type === "blockquote") {
        // Lazy continuation: `> text\n{.is-info}` ends up inside the quote's last paragraph
        const text = lastText(node);
        const trailing = text ? CALLOUT_TRAILING.exec(text.value) : null;
        if (text && trailing) {
          text.value = text.value.slice(0, trailing.index);
          markCallout(node, trailing[1] ?? "info");
        }
        // A marker in the middle (`> a\n{.is-info}\n> b` stays one quote): drop it, keep the kind
        const inner = stripInnerMarkers(node);
        if (inner && !node.data?.hProperties) markCallout(node, inner);
        const next = children[i + 1];
        const nextText = next?.type === "paragraph" && next.children.length === 1 ? next.children[0] : undefined;
        if (nextText?.type === "text" && CALLOUT_MARKER.test(nextText.value)) {
          markCallout(node, CALLOUT_MARKER.exec(nextText.value)?.[1] ?? "info");
          children.splice(i + 1, 1);
        } else if (next?.type === "html" && CALLOUT_COMMENT.test(next.value.trim())) {
          markCallout(node, CALLOUT_COMMENT.exec(next.value.trim())?.[1] ?? "info");
          children.splice(i + 1, 1);
        }
        visit(node);
        continue;
      }
      if (node.type === "heading") {
        const text = lastText(node);
        if (text && /\s*\{\.tabset\}\s*$/.test(text.value)) {
          text.value = text.value.replace(/\s*\{\.tabset\}\s*$/, "");
          warnings.push({ path, message: "Wiki.js tabset flattened into regular sections" });
        }
      }
      if (node.type === "paragraph" || node.type === "tableCell" || node.type === "link" || node.type === "heading") {
        applyImageAttributes(node as Parent);
      }
      if (node.type === "paragraph") {
        const only = (node as Paragraph).children.length === 1 ? (node as Paragraph).children[0] : undefined;
        if (only?.type === "text" && CALLOUT_MARKER.test(only.value)) {
          // Stray marker without a quote in front of it
          children.splice(i, 1);
          i--;
          continue;
        }
      }
      if (node.type === "html" && CALLOUT_COMMENT.test((node as Html).value.trim())) {
        children.splice(i, 1);
        i--;
        continue;
      }
      if (node.type === "code" && (node as Code).lang === "diagram") {
        // Wiki.js draw.io diagrams: base64 SVG
        const svg = (node as Code).value.replace(/\s+/g, "");
        const image: Image = { type: "image", url: `data:image/svg+xml;base64,${svg}`, alt: "diagram" };
        children[i] = { type: "paragraph", children: [image] };
        continue;
      }
      if (node.type === "code" && (node as Code).lang === "mermaid") {
        warnings.push({ path, message: "mermaid diagram kept as a code block (Plane cannot render mermaid)" });
      }
      if ("children" in node) visit(node as Parent);
    }
  };
  visit(tree);
}

/** Wiki.js markdown → HTML AST (GFM, raw HTML parsed, Wiki.js callouts/diagrams/sizes understood). */
export function markdownToHast(markdown: string, warnings: TWarning[] = [], path = ""): HastRoot {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: MdastRoot) => transformMdast(tree, warnings, path))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);
  const { markdown: source, tables } = extractMultimdTables(markdown);
  const mdast = processor.parse(preprocessMarkdown(source));
  const root = processor.runSync(mdast) as HastRoot;
  if (tables.length) insertMultimdTables(root, tables, warnings, path);
  return root;
}

// ------------------------------------------------------------------ multimd tables

const hel = (tagName: string, properties: Element["properties"] = {}, children: ElementContent[] = []): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

/** A cell is inline Markdown: keep `# x`, `- x`, `1. x`, `> x` from turning into blocks. */
function escapeBlockStart(text: string): string {
  if (/^(#{1,6}(\s|$)|>|[-+*](\s|$))/.test(text)) return `\\${text}`;
  return text.replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2");
}

/** Inline HTML AST of one cell's Markdown. */
function cellContent(text: string, warnings: TWarning[], path: string): ElementContent[] {
  if (!text) return [];
  const root = markdownToHast(escapeBlockStart(text), warnings, path);
  const nodes = root.children.filter((n) => !(n.type === "text" && n.value.trim() === "")) as ElementContent[];
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only?.type === "element" && only.tagName === "p") return only.children;
  return nodes;
}

const containsImage = (nodes: (ElementContent | RootContent)[]): boolean =>
  nodes.some((n) => n.type === "element" && (n.tagName === "img" || containsImage(n.children)));

/** Only images (and line breaks/whitespace between them). */
const isImageOnly = (nodes: ElementContent[]): boolean =>
  nodes.some((n) => n.type === "element" && n.tagName === "img") &&
  nodes.every(
    (n) =>
      (n.type === "text" && n.value.trim() === "") ||
      (n.type === "element" && (n.tagName === "img" || n.tagName === "br"))
  );

type TCells = { content: ElementContent[]; colspan: number }[];

/**
 * One column, header only: an image row then caption rows (possibly none). Wiki.js draws it as a framed
 * picture with its caption underneath, which in Plane is an image block plus a caption.
 */
function asFigure(table: TMultimdTable, header: TCells[]): Element | null {
  if (table.columns !== 1 || table.body.length || !header.length) return null;
  const [image, ...captions] = header.map((row) => row[0]?.content ?? []);
  if (!image || !isImageOnly(image) || captions.some(containsImage)) return null;
  const caption: ElementContent[] = [];
  for (const row of captions.filter((c) => c.some((n) => n.type !== "text" || n.value.trim() !== ""))) {
    if (caption.length) caption.push(hel("br"));
    caption.push(...row);
  }
  const children = [hel("p", {}, image)];
  if (caption.length) children.push(hel("figcaption", {}, caption));
  return hel("figure", {}, children);
}

function tableElement(table: TMultimdTable, warnings: TWarning[], path: string): Element {
  const cells = (rows: TMultimdRow[]): TCells[] =>
    rows.map((row) => row.map((cell) => ({ content: cellContent(cell.text, warnings, path), colspan: cell.colspan })));
  const header = cells(table.header);
  const body = cells(table.body);
  const figure = asFigure(table, header);
  if (figure) return figure;
  const tr = (row: TCells, tag: "th" | "td") => {
    const out = row.map((cell) => hel(tag, cell.colspan > 1 ? { colSpan: cell.colspan } : {}, cell.content));
    // Rectangular rows: markdown-it leaves short rows short, ProseMirror wants every column
    const missing = table.columns - row.reduce((sum, cell) => sum + cell.colspan, 0);
    for (let i = 0; i < missing; i++) out.push(hel(tag));
    return hel("tr", {}, out);
  };
  const sections: Element[] = [];
  if (header.length)
    sections.push(
      hel(
        "thead",
        {},
        header.map((row) => tr(row, "th"))
      )
    );
  if (body.length)
    sections.push(
      hel(
        "tbody",
        {},
        body.map((row) => tr(row, "td"))
      )
    );
  return hel("table", {}, sections);
}

/** Replaces the placeholders left by `extractMultimdTables` with the tables. */
function insertMultimdTables(root: HastRoot, tables: TMultimdTable[], warnings: TWarning[], path: string): void {
  const visit = (parent: HastRoot | Element) => {
    parent.children = parent.children.map((child) => {
      if (child.type !== "element") return child;
      const index = child.properties?.dataWikijsTable;
      const table = index != null ? tables[Number(index)] : undefined;
      if (!table) {
        visit(child);
        return child;
      }
      if (table.continuation) {
        warnings.push({ path, message: "table rows after a blank line were appended to the table above them" });
      }
      return tableElement(table, warnings, path);
    }) as typeof parent.children;
  };
  visit(root);
}

/** Wiki.js HTML page (ckeditor or raw "code" editor) → HTML AST. */
export function htmlToHast(html: string): HastRoot {
  return fromHtml(html, { fragment: true });
}
