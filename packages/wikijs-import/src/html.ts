/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Element, ElementContent, Properties, Root, RootContent, Text } from "hast";
import { toHtml } from "hast-util-to-html";
import type { TWarning } from "./types";

/** Width of the Plane page body the Wiki.js percentages are mapped onto, in px. */
export const EDITOR_CONTENT_WIDTH = 720;
const MIN_IMAGE_WIDTH = 32;
/** The editor's default table column width (`DEFAULT_COLUMN_WIDTH`), in px. */
const TABLE_COLUMN_WIDTH = 150;
/** Horizontal padding plus border of an editor table cell, in px. */
const TABLE_CELL_PADDING = 22;

/** An uploaded image: Plane asset id plus its natural display size. */
export type TResolvedImage = { assetId: string; width: number; height: number };

export type TConvertContext = {
  /** Wiki path of the page being converted (for warnings). */
  path: string;
  warnings: TWarning[];
  /** Image `src` (as written in the page) → upload result; missing/null = not available. */
  images: Map<string, TResolvedImage | null>;
  /**
   * Maps a link target to the href to write. Return the input for external links, a new
   * href for resolved internal links, or null to drop the link and keep its text.
   */
  resolveLink: (href: string) => string | null;
  editorWidth?: number | undefined;
};

export type TConvertResult = {
  html: string;
  /** Language of every code block, in document order (the Node HTML parser drops it). */
  codeLanguages: (string | null)[];
};

/** Plane callout presets per Wiki.js callout class. */
export const CALLOUT_STYLES: Record<string, { background: string; emojiDecimal: string; emojiHex: string }> = {
  info: { background: "light-blue", emojiDecimal: "8505-65039", emojiHex: "2139-fe0f" },
  warning: { background: "orange", emojiDecimal: "9888-65039", emojiHex: "26a0-fe0f" },
  success: { background: "green", emojiDecimal: "9989", emojiHex: "2705" },
  danger: { background: "peach", emojiDecimal: "128680", emojiHex: "1f6a8" },
};

const HIGHLIGHT_BACKGROUND = "orange";

// lowlight `common` languages plus aliases, so unknown names do not reach the editor
const CODE_LANGUAGES: Record<string, string> = {
  arduino: "arduino",
  ino: "arduino",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  shell: "shell",
  console: "shell",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  csharp: "csharp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  patch: "diff",
  go: "go",
  graphql: "graphql",
  ini: "ini",
  toml: "ini",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  kotlin: "kotlin",
  less: "less",
  lua: "lua",
  makefile: "makefile",
  make: "makefile",
  markdown: "markdown",
  md: "markdown",
  objectivec: "objectivec",
  perl: "perl",
  php: "php",
  plaintext: "plaintext",
  text: "plaintext",
  txt: "plaintext",
  python: "python",
  py: "python",
  r: "r",
  ruby: "ruby",
  rb: "ruby",
  rust: "rust",
  rs: "rust",
  scss: "scss",
  sql: "sql",
  swift: "swift",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  vbnet: "vbnet",
  wasm: "wasm",
  xml: "xml",
  html: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

const DROP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "title",
  "head",
  "noscript",
  "template",
  "button",
  "form",
  "select",
  "textarea",
  "canvas",
  "svg",
  "colgroup",
  "col",
  "caption",
]);
const EMBED_TAGS = new Set(["iframe", "video", "audio", "embed", "object"]);

const el = (tagName: string, properties: Properties = {}, children: ElementContent[] = []): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});
const text = (value: string): Text => ({ type: "text", value });

function classes(node: Element): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/);
  return [];
}

export function textContent(node: RootContent | Root): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map((child) => textContent(child as RootContent)).join("");
  return "";
}

/** Images only, apart from whitespace, line breaks and empty paragraphs around them. */
function isImageOnly(nodes: ElementContent[]): boolean {
  let images = 0;
  const visit = (list: ElementContent[]): boolean =>
    list.every((n) => {
      if (n.type === "text") return n.value.trim() === "";
      if (n.type !== "element") return true;
      if (n.tagName === "img") return ++images > 0;
      if (n.tagName === "br") return true;
      return n.tagName === "p" && visit(n.children);
    });
  return visit(nodes) && images > 0;
}

function containsImage(node: Element): boolean {
  return node.children.some((c) => c.type === "element" && (c.tagName === "img" || containsImage(c)));
}

const colSpan = (cell: Element) => Math.max(1, Number(cell.properties?.colSpan) || 1);

const isImageMarker = (node: ElementContent): node is Element =>
  node.type === "element" && node.tagName === "image-component";

function hasContent(nodes: ElementContent[]): boolean {
  return nodes.some((node) => (node.type === "text" ? node.value.trim() !== "" : node.type === "element"));
}

/** Removes leading/trailing whitespace and line breaks of a paragraph's inline content. */
const isBlank = (node: ElementContent | undefined) =>
  !!node && ((node.type === "text" && node.value.trim() === "") || (node.type === "element" && node.tagName === "br"));

function trimInline(nodes: ElementContent[]): ElementContent[] {
  const out = [...nodes];
  while (isBlank(out[0])) out.shift();
  while (isBlank(out[out.length - 1])) out.pop();
  const first = out[0];
  if (first?.type === "text") out[0] = text(first.value.replace(/^\s+/, ""));
  const last = out[out.length - 1];
  if (last?.type === "text") out[out.length - 1] = text(last.value.replace(/\s+$/, ""));
  return out;
}

type TSize = { value: number; unit: "%" | "px" };
export type TImageSizeSpec = { width?: TSize | undefined; height?: TSize | undefined };

function parseLength(raw: string | undefined): TSize | undefined {
  if (!raw) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(%|px)?\s*$/.exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!value) return undefined;
  return { value, unit: match[2] === "%" ? "%" : "px" };
}

/** Reads the Wiki.js `=W x H` size token (kept in the image title) or HTML width/height. */
export function parseImageSize(node: Element): TImageSizeSpec {
  const title = typeof node.properties?.title === "string" ? node.properties.title : "";
  const token = /^=(\S*?)x(\S*)$/.exec(title) ?? /^=(\S+)$/.exec(title);
  if (token) return { width: parseLength(token[1]), height: parseLength(token[2]) };
  const style = typeof node.properties?.style === "string" ? node.properties.style : "";
  const styleWidth = /(?:^|;)\s*width\s*:\s*([\d.]+(?:%|px)?)/i.exec(style)?.[1];
  const width = node.properties?.width;
  const height = node.properties?.height;
  return {
    width: parseLength(styleWidth ?? (width != null ? String(width) : undefined)),
    height: parseLength(height != null ? String(height) : undefined),
  };
}

const toPx = (s: TSize, base: number) => (s.unit === "%" ? (base * s.value) / 100 : s.value);

/** Pixel size of an image in the Plane editor. */
export function computeImageSize(
  image: TResolvedImage,
  size: TImageSizeSpec,
  editorWidth = EDITOR_CONTENT_WIDTH
): { width: number; height: number; aspectRatio: number } {
  const aspectRatio = image.width > 0 && image.height > 0 ? image.width / image.height : 1;
  let width: number;
  if (size.width) width = toPx(size.width, editorWidth);
  else if (size.height && size.height.unit === "px") width = size.height.value * aspectRatio;
  else width = image.width || editorWidth;
  width = Math.round(Math.min(Math.max(width, MIN_IMAGE_WIDTH), editorWidth));
  return { width, height: Math.round(width / aspectRatio), aspectRatio: Number(aspectRatio.toFixed(6)) };
}

/**
 * Finds and removes the checkbox of a task list item (GFM `<input type=checkbox>` or the
 * ckeditor `label.todo-list__label`). Returns the checked state, or null for a plain item.
 * The checkbox must lead the item (possibly wrapped in a label/p/span).
 */
function takeCheckbox(parent: Element, depth: number): boolean | null {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (!child) continue;
    if (child.type === "text") {
      if (child.value.trim()) return null;
      continue;
    }
    if (child.type !== "element") continue;
    if (child.tagName === "input" && String(child.properties?.type).toLowerCase() === "checkbox") {
      parent.children.splice(i, 1);
      return Boolean(child.properties?.checked);
    }
    if (depth < 3 && ["label", "p", "span"].includes(child.tagName)) return takeCheckbox(child, depth + 1);
    return null;
  }
  return null;
}

class Converter {
  readonly codeLanguages: (string | null)[] = [];
  /** Width images are sized against: the page, or the table column they sit in. */
  private imageWidth: number | undefined;

  constructor(private readonly ctx: TConvertContext) {}

  private warn(message: string): void {
    if (!this.ctx.warnings.some((w) => w.path === this.ctx.path && w.message === message)) {
      this.ctx.warnings.push({ path: this.ctx.path, message });
    }
  }

  // ---------------------------------------------------------------- blocks

  blocks(nodes: RootContent[]): Element[] {
    const out: Element[] = [];
    let run: ElementContent[] = [];
    const flush = () => {
      if (run.length) out.push(...this.paragraphs(run, "p"));
      run = [];
    };
    for (const node of nodes) {
      if (node.type === "text") run.push(node);
      else if (node.type === "element") {
        if (INLINE_TAGS.has(node.tagName)) run.push(node);
        else {
          flush();
          out.push(...this.block(node));
        }
      }
    }
    flush();
    return out;
  }

  private block(node: Element): Element[] {
    const tag = node.tagName;
    if (/^h[1-6]$/.test(tag)) return this.paragraphs(node.children, tag);
    if (DROP_TAGS.has(tag)) {
      if (tag === "script" || tag === "form" || tag === "svg") this.warn(`dropped unsupported <${tag}> element`);
      return [];
    }
    if (EMBED_TAGS.has(tag)) return [el("p", {}, this.embed(node))];
    switch (tag) {
      case "p":
        return this.paragraphs(node.children, "p");
      case "ul":
      case "ol":
        return this.list(node);
      case "blockquote":
        return [this.blockquote(node)];
      case "pre":
        return [this.codeBlock(node)];
      case "table":
        return this.table(node);
      case "hr":
        return [el("hr")];
      case "figure": {
        const caption = node.children.find((c) => c.type === "element" && c.tagName === "figcaption");
        const rest = node.children.filter((c) => c !== caption);
        const blocks = this.blocks(rest);
        if (caption && caption.type === "element" && hasContent(caption.children)) {
          // Centred italic caption (the editor's text-align attribute is the paragraph style)
          const captions = this.paragraphs([el("em", {}, caption.children)], "p");
          for (const block of captions) if (block.tagName === "p") block.properties.style = "text-align: center";
          blocks.push(...captions);
        }
        return blocks;
      }
      case "dl":
        return node.children.flatMap((child) => {
          if (child.type !== "element") return [];
          if (child.tagName === "dt") return this.paragraphs([el("strong", {}, child.children)], "p");
          return this.blocks(child.children);
        });
      case "details":
        return node.children.flatMap((child) => {
          if (child.type === "element" && child.tagName === "summary") {
            return this.paragraphs([el("strong", {}, child.children)], "p");
          }
          return this.blocks([child]);
        });
      default:
        // div, section, center, tbody outside a table, li outside a list, …: keep the content
        return this.blocks(node.children);
    }
  }

  /** Inline content → one or more paragraphs (images are hoisted out as their own blocks). */
  private paragraphs(nodes: ElementContent[], tag: string): Element[] {
    const inline = this.inline(nodes);
    const out: Element[] = [];
    let segment: ElementContent[] = [];
    let first = true;
    const flush = () => {
      const trimmed = trimInline(segment);
      if (hasContent(trimmed)) {
        out.push(el(first ? tag : "p", {}, trimmed));
        first = false;
      }
      segment = [];
    };
    for (const node of inline) {
      if (isImageMarker(node)) {
        flush();
        out.push(node);
      } else segment.push(node);
    }
    flush();
    return out;
  }

  private list(node: Element): Element[] {
    const items: Element[] = [];
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "li") items.push(structuredClone(child));
      else if ((child.tagName === "ul" || child.tagName === "ol") && items.length) {
        // ckeditor nests a list directly in the parent list
        items[items.length - 1]?.children.push(child);
      } else items.push(el("li", {}, [child]));
    }
    if (!items.length) return [];

    const tasks = items.map((item) => takeCheckbox(item, 0));
    const isTaskList = tasks.some((t) => t !== null);
    const lis = items.map((item, index) => {
      const content = this.blocks(item.children);
      if (!content.length || content[0]?.tagName !== "p") content.unshift(el("p"));
      if (!isTaskList) return el("li", {}, content);
      return el("li", { "data-type": "taskItem", "data-checked": tasks[index] ? "true" : "false" }, content);
    });
    if (isTaskList) return [el("ul", { "data-type": "taskList" }, lis)];
    const props: Properties = {};
    const start = Number(node.properties?.start);
    if (node.tagName === "ol" && Number.isFinite(start) && start !== 1) props.start = start;
    return [el(node.tagName, props, lis)];
  }

  private blockquote(node: Element): Element {
    const kind = classes(node)
      .map((c) => /^is-(info|warning|success|danger)$/.exec(c)?.[1])
      .find(Boolean);
    const content = this.blocks(node.children);
    if (!content.length) content.push(el("p"));
    if (!kind) return el("blockquote", {}, content);
    const style = CALLOUT_STYLES[kind] ?? CALLOUT_STYLES.info;
    return el(
      "div",
      {
        "data-block-type": "callout-component",
        "data-logo-in-use": "emoji",
        "data-emoji-unicode": style?.emojiDecimal,
        "data-emoji-url": `https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/${style?.emojiHex}.png`,
        "data-background": style?.background,
      },
      content
    );
  }

  private codeBlock(node: Element): Element {
    const code = node.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
    const langClass = [...(code ? classes(code) : []), ...classes(node)].find((c) => c.startsWith("language-"));
    const raw = langClass?.slice("language-".length).toLowerCase() ?? null;
    const language = raw ? (CODE_LANGUAGES[raw] ?? null) : null;
    this.codeLanguages.push(language);
    const value = textContent(code ?? node).replace(/\n$/, "");
    return el("pre", {}, [el("code", language ? { className: [`language-${language}`] } : {}, [text(value)])]);
  }

  private table(node: Element): Element[] {
    const rows: Element[] = [];
    const collect = (parent: Element) => {
      for (const child of parent.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "tr") rows.push(child);
        else if (["thead", "tbody", "tfoot"].includes(child.tagName)) collect(child);
      }
    };
    collect(node);
    const cellsOf = (row: Element) =>
      row.children.filter((c): c is Element => c.type === "element" && (c.tagName === "td" || c.tagName === "th"));
    // A one-cell table around a picture (Wiki.js framed image): just the image
    const only = rows.length === 1 && rows[0] ? cellsOf(rows[0]) : [];
    if (only.length === 1 && only[0] && isImageOnly(only[0].children)) return this.blocks(only[0].children);
    // Screenshot tables: the editor's default 150 px columns would shrink the images to
    // thumbnails, so the columns share the page width and the images fit their column.
    const columns = Math.max(1, ...rows.map((row) => cellsOf(row).reduce((sum, cell) => sum + colSpan(cell), 0)));
    const colwidth = containsImage(node) ? Math.max(TABLE_COLUMN_WIDTH, Math.floor(this.editorWidth / columns)) : null;
    const outRows = rows
      .map((row) => {
        const cells = cellsOf(row).map((cell) => {
          const content = this.withImageWidth(colwidth ? colwidth * colSpan(cell) - TABLE_CELL_PADDING : null, () =>
            this.blocks(cell.children)
          );
          if (!content.length) content.push(el("p"));
          const props: Properties = {};
          const colspan = colSpan(cell);
          const rowspan = Number(cell.properties?.rowSpan);
          if (colspan > 1) props.colspan = colspan;
          if (rowspan > 1) props.rowspan = rowspan;
          if (colwidth && colspan === 1) props.colwidth = colwidth;
          return el(cell.tagName, props, content);
        });
        return cells.length ? el("tr", {}, cells) : null;
      })
      .filter((row): row is Element => row !== null);
    if (!outRows.length) return [];
    return [el("table", {}, [el("tbody", {}, outRows)])];
  }

  private get editorWidth(): number {
    return this.ctx.editorWidth ?? EDITOR_CONTENT_WIDTH;
  }

  /** Runs `fn` with images sized against `width` (a table column) instead of the page. */
  private withImageWidth<T>(width: number | null, fn: () => T): T {
    const previous = this.imageWidth;
    if (width) this.imageWidth = width;
    try {
      return fn();
    } finally {
      this.imageWidth = previous;
    }
  }

  private embed(node: Element): ElementContent[] {
    const src = String(node.properties?.src ?? node.properties?.data ?? "");
    this.warn(`embedded <${node.tagName}> replaced by a link${src ? ` (${src})` : ""}`);
    if (!src) return [text(`[embedded ${node.tagName}]`)];
    return [text("Embedded content: "), el("a", { href: src }, [text(src)])];
  }

  // ---------------------------------------------------------------- inline

  /** Wraps inline content in a mark, splitting it around hoisted images. */
  private wrap(tag: string, props: Properties, children: ElementContent[]): ElementContent[] {
    const out: ElementContent[] = [];
    let run: ElementContent[] = [];
    const flush = () => {
      if (run.length && hasContent(run)) out.push(el(tag, props, run));
      else out.push(...run);
      run = [];
    };
    for (const child of children) {
      if (isImageMarker(child)) {
        flush();
        out.push(child);
      } else run.push(child);
    }
    flush();
    return out;
  }

  inline(nodes: ElementContent[]): ElementContent[] {
    return nodes.flatMap((node) => this.inlineNode(node));
  }

  private inlineNode(node: ElementContent): ElementContent[] {
    if (node.type === "text") return [text(node.value)];
    if (node.type !== "element") return [];
    const tag = node.tagName;
    switch (tag) {
      case "strong":
      case "b":
        return this.wrap("strong", {}, this.inline(node.children));
      case "em":
      case "i":
      case "cite":
      case "dfn":
      case "var":
        return this.wrap("em", {}, this.inline(node.children));
      case "u":
      case "ins":
        return this.wrap("u", {}, this.inline(node.children));
      case "s":
      case "del":
      case "strike":
        return this.wrap("s", {}, this.inline(node.children));
      case "code":
      case "kbd":
      case "samp":
      case "tt":
        return [el("code", {}, [text(textContent(node))])];
      case "mark":
        return this.wrap("span", { "data-background-color": HIGHLIGHT_BACKGROUND }, this.inline(node.children));
      case "br":
        return [el("br")];
      case "img":
        return [this.image(node)];
      case "input":
        return String(node.properties?.type).toLowerCase() === "checkbox"
          ? [text(node.properties?.checked ? "☑ " : "☐ ")]
          : [];
      case "a":
        return this.link(node);
      case "iframe":
      case "video":
      case "audio":
      case "embed":
      case "object":
        return this.embed(node);
      default:
        if (DROP_TAGS.has(tag)) return [];
        // span, sub, sup, small, label, font, nested blocks in inline context, …
        return this.inline(node.children);
    }
  }

  private link(node: Element): ElementContent[] {
    const children = this.inline(node.children);
    const href = typeof node.properties?.href === "string" ? node.properties.href : "";
    if (!href) return children;
    const target = this.ctx.resolveLink(href);
    if (target === null) return children;
    return this.wrap("a", { href: target }, children);
  }

  private image(node: Element): ElementContent {
    const src = typeof node.properties?.src === "string" ? node.properties.src : "";
    const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
    const resolved = src ? this.ctx.images.get(src) : undefined;
    if (!resolved) {
      const label = alt || src.split("/").pop() || "image";
      return el("em", {}, [text(`[image not available: ${label}]`)]);
    }
    const size = computeImageSize(resolved, parseImageSize(node), this.imageWidth ?? this.ctx.editorWidth);
    return el("image-component", {
      src: resolved.assetId,
      width: `${size.width}px`,
      height: `${size.height}px`,
      aspectratio: size.aspectRatio,
      alignment: ["left", "center", "right"].includes(String(node.properties?.dataAlign))
        ? String(node.properties?.dataAlign)
        : "left",
      status: "uploaded",
    });
  }
}

/** Every image `src` in the document, in order (duplicates removed). */
export function collectImageSources(root: Root): string[] {
  const out = new Set<string>();
  const visit = (node: Root | RootContent) => {
    if (node.type === "element" && node.tagName === "img" && typeof node.properties?.src === "string") {
      out.add(node.properties.src);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return [...out];
}

/** Every link `href` in the document. */
export function collectLinks(root: Root): string[] {
  const out: string[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "element" && node.tagName === "a" && typeof node.properties?.href === "string") {
      out.push(node.properties.href);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return out;
}

/** HTML AST of a Wiki.js page → HTML the Plane document editor parses without loss. */
export function toEditorHtml(root: Root, ctx: TConvertContext): TConvertResult {
  const converter = new Converter(ctx);
  const blocks = converter.blocks(root.children);
  const html = blocks.length ? toHtml({ type: "root", children: blocks }) : "<p></p>";
  return { html, codeLanguages: converter.codeLanguages };
}
