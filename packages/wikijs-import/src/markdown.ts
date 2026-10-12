/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Root as HastRoot } from "hast";
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
  let fence: string | null = null;
  return lines
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1] ?? "";
        if (fence === null) fence = marker;
        else if (marker.startsWith(fence)) fence = null;
        return line;
      }
      if (fence !== null) return line;
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
  const mdast = processor.parse(preprocessMarkdown(markdown));
  return processor.runSync(mdast) as HastRoot;
}

/** Wiki.js HTML page (ckeditor or raw "code" editor) → HTML AST. */
export function htmlToHast(html: string): HastRoot {
  return fromHtml(html, { fragment: true });
}
