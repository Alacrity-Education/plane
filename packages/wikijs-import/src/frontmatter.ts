/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TWikiMeta } from "./types";

const MD_FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const HTML_FRONT_MATTER = /^﻿?\s*<!--\r?\n([\s\S]*?)\r?\n-->[ \t]*(?:\r?\n|$)/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parses the flat `key: value` block Wiki.js writes (no nesting, tags comma separated). */
export function parseMetaBlock(block: string): TWikiMeta {
  const meta: TWikiMeta = { tags: [] };
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = unquote(match[2] ?? "");
    switch (key) {
      case "title":
      case "description":
      case "date":
      case "editor":
      case "dateCreated":
        meta[key] = value;
        break;
      case "published":
        meta.published = !/^(false|no|0)$/i.test(value);
        break;
      case "tags":
        meta.tags = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((tag) => unquote(tag).trim())
          .filter(Boolean);
        break;
      default:
        break;
    }
  }
  return meta;
}

/**
 * Splits a Wiki.js page file into metadata and body. Markdown files carry YAML-like front
 * matter between `---` lines; HTML pages carry the same block inside a leading comment.
 */
export function parseFrontMatter(content: string, format: "markdown" | "html"): { meta: TWikiMeta; body: string } {
  const pattern = format === "markdown" ? MD_FRONT_MATTER : HTML_FRONT_MATTER;
  const match = pattern.exec(content);
  if (!match) return { meta: { tags: [] }, body: content };
  return { meta: parseMetaBlock(match[1] ?? ""), body: content.slice(match[0].length) };
}
