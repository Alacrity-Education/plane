/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// rehype pass that turns TipTap's editor HTML into plain, Markdown-friendly HTML before the
// hast -> mdast conversion. See RESEARCH-editor-markdown.md for the HTML shape of every node.

import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import type { TCalloutMode } from "./types";

export type TPreprocessAsset = { url: string; name: string };

export type TPreprocessContext = {
  workspaceSlug: string;
  /** Plane web origin (PLANE_URL); internal links to non-exported pages are made absolute to it. */
  planeUrl: string;
  /** page id -> docs route ("/wiki/a/b") for exported pages. */
  linkMap: Map<string, string>;
  /** asset id -> local public URL; missing ids drop the image. */
  assets: Map<string, TPreprocessAsset>;
  /** user id -> display name; unknown users render as "@member". */
  members?: Map<string, string>;
  callouts: TCalloutMode;
};

/** Plane callout background -> Docusaurus admonition type. */
export const CALLOUT_ADMONITION_TYPES: Record<string, string> = {
  gray: "note",
  purple: "note",
  green: "tip",
  peach: "warning",
  orange: "warning",
  pink: "danger",
  "light-blue": "info",
  "dark-blue": "info",
};

/** Intermediate tag the Markdown step turns into ":::type[title]" fences or a raw <div>. */
export const CALLOUT_TAG = "wiki-callout";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");

const ALLOWED_STYLE_PROPERTIES = new Set(["color", "background-color", "text-align"]);
const INVALID_STYLE_VALUES = new Set(["", "null", "none", "undefined", "inherit", "initial", "unset"]);

// `background` is the editor's table cell colour attribute (the colour itself is in the style);
// on a <td>/<th> browsers read it as a background image URL ("none" -> a request for /none).
const DROPPED_ATTRIBUTES = new Set([
  "colwidth",
  "colWidth",
  "background",
  "target",
  "rel",
  "spellCheck",
  "spellcheck",
  "id",
]);

const str = (value: unknown): string => {
  if (value === undefined || value === null || value === false) return "";
  if (Array.isArray(value)) return value.join(" ");
  return String(value);
};

const getAttr = (node: Element, name: string): string => {
  const props = node.properties ?? {};
  // rehype-parse camel-cases data-* attributes (data-block-type -> dataBlockType) but keeps
  // unknown attributes of custom elements (entity_identifier) as-is.
  const camel = name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return str(props[camel] ?? props[name]);
};

/** Keeps only well-formed colour/alignment declarations; Plane emits literal "null"/"none" values. */
export function sanitizeStyle(style: string): string {
  const declarations: string[] = [];
  for (const part of style.split(";")) {
    const index = part.indexOf(":");
    if (index <= 0) continue;
    const property = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    if (INVALID_STYLE_VALUES.has(value.toLowerCase())) continue;
    if (!/^[#(),.%\w\s-]+$/.test(value)) continue;
    declarations.push(`${property}: ${value}`);
  }
  return declarations.join("; ");
}

const cleanProperties = (node: Element): void => {
  const props: Properties = {};
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    if (DROPPED_ATTRIBUTES.has(key)) continue;
    if (key.startsWith("data")) {
      // keep only what later steps read
      if (key === "dataType" || key === "dataChecked") props[key] = value;
      continue;
    }
    if (key === "className") {
      // fenced code blocks need language-*; everything else is Tailwind noise
      const languages = (Array.isArray(value) ? value : [value])
        .map(String)
        .filter((c) => c.startsWith("language-"))
        .map((c) => (c === "language-plaintext" ? "language-text" : c));
      if (node.tagName === "code" && languages.length) props.className = languages;
      continue;
    }
    if (key === "style") {
      const style = sanitizeStyle(str(value));
      if (style) props.style = style;
      continue;
    }
    if ((key === "colSpan" || key === "rowSpan") && Number(value) === 1) continue;
    props[key] = value;
  }
  node.properties = props;
};

const textNode = (value: string): ElementContent => ({ type: "text", value });

/** Rewrites Plane page links to docs routes; returns the new href (or the input unchanged). */
export function rewriteHref(
  href: string,
  ctx: Pick<TPreprocessContext, "linkMap" | "planeUrl" | "workspaceSlug">
): string {
  if (!href) return href;
  let url: URL;
  const planeOrigin = ctx.planeUrl ? new URL(ctx.planeUrl).origin : "";
  try {
    url = new URL(href, planeOrigin ? `${planeOrigin}/` : "https://plane.invalid/");
  } catch {
    return href;
  }
  const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//");
  const isPlane = isRelative || (planeOrigin !== "" && url.origin === planeOrigin);
  if (!isPlane) return href;
  if (isRelative && href.startsWith("#")) return href;

  const slug = ctx.workspaceSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match =
    url.pathname.match(new RegExp(`^/${slug}/wiki/(${UUID_SOURCE})/?$`, "i")) ??
    url.pathname.match(new RegExp(`^/${slug}/projects/${UUID_SOURCE}/pages/(${UUID_SOURCE})/?$`, "i"));
  const pageId = match?.[1]?.toLowerCase();
  const route = pageId ? ctx.linkMap.get(pageId) : undefined;
  if (route) return `${route}${url.hash}`;
  // Other Plane URLs (private pages, work items, ...) must not resolve against the docs site.
  if (isRelative && planeOrigin && href.startsWith("/")) return `${planeOrigin}${url.pathname}${url.search}${url.hash}`;
  return href;
}

const calloutElement = (node: Element, ctx: TPreprocessContext): Element => {
  const background = getAttr(node, "data-background").toLowerCase();
  const logoInUse = getAttr(node, "data-logo-in-use") || "emoji";
  let emoji = "";
  if (logoInUse === "emoji") {
    const codePoint = Number.parseInt(getAttr(node, "data-emoji-unicode"), 10);
    if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) emoji = String.fromCodePoint(codePoint);
  }
  return {
    type: "element",
    tagName: CALLOUT_TAG,
    properties: {
      dataKind: CALLOUT_ADMONITION_TYPES[background] ?? "note",
      dataTitle: emoji,
      dataBackground: background,
      dataMode: ctx.callouts,
    },
    children: node.children,
  };
};

// Markdown images have no size; emitting them as Markdown (not raw <img>) lets Docusaurus resolve
// them through webpack (baseUrl-safe, and onBrokenMarkdownImages catches missing files).
const imageElement = (src: string, alt: string): Element => ({
  type: "element",
  tagName: "img",
  properties: { src, alt },
  children: [],
});

/** rehype plugin: mutates the TipTap hast in place (see module comment). */
export function rehypeWikiPreprocess(ctx: TPreprocessContext) {
  return (tree: Root) => {
    visit(tree, "element", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const replace = (nodes: (ElementContent | RootContent)[]) => {
        parent.children.splice(index, 1, ...(nodes as ElementContent[]));
        const result: [typeof SKIP, number] = [SKIP, index];
        return result;
      };

      switch (node.tagName) {
        case "issue-embed-component":
          // matches the web Markdown export, which strips work-item embeds
          return replace([]);
        case "mention-component": {
          const entity = getAttr(node, "entity_name");
          const id = getAttr(node, "entity_identifier").toLowerCase();
          const name = entity === "user_mention" ? ctx.members?.get(id) : undefined;
          return replace([textNode(`@${name || "member"}`)]);
        }
        case "image-component":
        case "excalidraw-component": {
          // Excalidraw drawings are stored as a PNG asset bound to the page, exactly like images.
          const isDrawing = node.tagName === "excalidraw-component";
          const fallbackAlt = isDrawing ? "Drawing" : "";
          const src = getAttr(node, "src").trim();
          const asset = UUID_RE.test(src) ? ctx.assets.get(src.toLowerCase()) : undefined;
          if (asset) return replace([imageElement(asset.url, asset.name || fallbackAlt)]);
          if (/^https?:\/\//i.test(src)) return replace([imageElement(src, fallbackAlt)]);
          return replace([]);
        }
        case "img": {
          const src = getAttr(node, "src").trim();
          if (!src) return replace([]);
          node.properties = { src, alt: getAttr(node, "alt") };
          return undefined;
        }
        case "u":
          return replace(node.children);
        case "div": {
          if (getAttr(node, "data-type") === "horizontalRule") {
            return replace([{ type: "element", tagName: "hr", properties: {}, children: [] }]);
          }
          if (getAttr(node, "data-block-type") === "callout-component") {
            const callout = calloutElement(node, ctx);
            parent.children[index] = callout;
            return undefined; // descend into the callout's children
          }
          break;
        }
        case "a": {
          const href = rewriteHref(getAttr(node, "href"), ctx);
          cleanProperties(node);
          if (href) node.properties.href = href;
          return undefined;
        }
        default:
          break;
      }
      if (node.tagName !== CALLOUT_TAG) cleanProperties(node);
      return undefined;
    });

    // Fence length for nested callouts: an outer admonition needs more colons than its children.
    const setFences = (node: Root | Element): number => {
      let deepest = 0;
      for (const child of node.children) {
        if (child.type === "element") deepest = Math.max(deepest, setFences(child));
      }
      if (node.type === "element" && node.tagName === CALLOUT_TAG) {
        node.properties.dataFence = ":".repeat(3 + deepest);
        return deepest + 1;
      }
      return deepest;
    };
    setFences(tree);
  };
}

/** HTML -> preprocessed HTML (debugging / tests); the CLI runs the plugin inside the Markdown pipeline. */
export function preprocessHtml(html: string, ctx: TPreprocessContext): string {
  const processor = unified().use(rehypeParse, { fragment: true }).use(rehypeWikiPreprocess, ctx);
  const tree = processor.runSync(processor.parse(html));
  return toHtml(tree as Root);
}
