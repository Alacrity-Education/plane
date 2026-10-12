/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- one request at a time keeps the Wiki.js server happy */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TWarning } from "./types";

/**
 * Exports a live Wiki.js instance into the layout its git-sync storage writes: one file per page
 * (`<path>.md` with front matter, or `<path>.html` with a `<!-- -->` header) plus the assets at
 * their folder paths. The importer then reads that directory like a git-sync checkout.
 */

export type TWikiJsExportOptions = {
  /** Wiki.js origin, e.g. https://wiki.example.com */
  baseUrl: string;
  /** API key (Administration → API Access); sent as a Bearer token, never logged. */
  token: string;
  outDir: string;
  warnings: TWarning[];
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

export type TWikiJsExportResult = { pages: number; assets: number; missing: string[] };

type TWikiJsPage = {
  path: string;
  title: string;
  description: string | null;
  editor: string;
  isPublished: boolean;
  tags: { tag: string }[];
  createdAt: string;
  updatedAt: string;
  content: string;
};

const PAGE_QUERY =
  "query($id:Int!){ pages { single(id:$id) { path title description editor isPublished isPrivate tags { tag } createdAt updatedAt content } } }";
const ASSETS_QUERY = "query($f:Int!){ assets { list(folderId:$f, kind: ALL) { filename } } }";
const FOLDERS_QUERY = "query($f:Int!){ assets { folders(parentFolderId:$f) { id slug } } }";

/** Files a page may reference that are downloaded in the second pass. */
const REFERENCE = /(?:\]\(|src=")(\/[^)" ]+\.(?:png|jpe?g|svg|gif|webp|mp4|pdf))/gi;

/** Python's `urllib.parse.quote` (UTF-8, `/` kept): what Wiki.js has been served with so far. */
export function quotePath(path: string): string {
  return [...new TextEncoder().encode(path)]
    .map((byte) => {
      const ch = String.fromCodePoint(byte);
      return /[A-Za-z0-9_.~/-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** `urllib.parse.unquote`: decodes %XX sequences, leaves malformed ones as they are. */
export function unquotePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** The page header git-sync writes, which the source reader parses. */
export function pageFileContent(page: TWikiJsPage): string {
  const tags = page.tags.map((t) => t.tag).join(", ");
  const meta =
    `title: ${page.title}\ndescription: ${page.description ?? "None"}\npublished: ${page.isPublished ? "true" : "false"}\n` +
    `date: ${page.updatedAt}\ntags: ${tags}\neditor: ${page.editor}\ndateCreated: ${page.createdAt}\n`;
  const header = page.editor === "markdown" ? `---\n${meta}---\n\n` : `<!--\n${meta}-->\n\n`;
  return `${header}${page.content.replace(/\n+$/, "")}\n`;
}

export const pageFileName = (page: Pick<TWikiJsPage, "path" | "editor">) =>
  `${page.path}${page.editor === "markdown" ? ".md" : ".html"}`;

const isPage = (file: string) => file.endsWith(".md") || file.endsWith(".html");

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

export async function exportWikiJs(options: TWikiJsExportOptions): Promise<TWikiJsExportResult> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    "User-Agent": "plane-wikijs-export",
  };

  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetchImpl(`${base}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Wiki.js GraphQL ${response.status}`);
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Wiki.js GraphQL error: ${body.errors[0]?.message}`);
    if (!body.data) throw new Error("Wiki.js GraphQL: empty response");
    return body.data;
  };

  /** GET a file; null when it is missing or is an HTML page (Wiki.js answers unknown paths with one). */
  const download = async (rel: string, rejectHtml: boolean): Promise<Buffer | string> => {
    const response = await fetchImpl(`${base}${quotePath(rel)}`, { headers });
    if (!response.ok) return `HTTP ${response.status}`;
    if (rejectHtml && (response.headers.get("content-type") ?? "").startsWith("text/html")) return "not an asset";
    return Buffer.from(await response.arrayBuffer());
  };

  const write = (rel: string, data: string | Buffer) => {
    const dest = join(options.outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  };

  // 1. pages (page files of an earlier export are removed first: a page deleted in Wiki.js must
  //    disappear from the source; downloaded assets are kept and not fetched again)
  for (const file of listFiles(options.outDir).filter(isPage)) rmSync(file);
  const list = await gql<{ pages: { list: { id: number }[] } }>("{ pages { list(limit: 1000) { id path locale } } }");
  log(`Wiki.js: ${list.pages.list.length} pages`);
  for (const { id } of list.pages.list) {
    const { pages } = await gql<{ pages: { single: TWikiJsPage } }>(PAGE_QUERY, { id });
    write(pageFileName(pages.single), pageFileContent(pages.single));
  }

  // 2. assets known to the asset database, at their folder paths
  const walk = async (folderId: number, prefix: string): Promise<void> => {
    const { assets } = await gql<{ assets: { list: { filename: string }[] } }>(ASSETS_QUERY, { f: folderId });
    for (const asset of assets.list) {
      const rel = `${prefix}${asset.filename}`;
      if (existsSync(join(options.outDir, rel))) continue;
      const data = await download(`/${rel}`, false);
      if (typeof data === "string")
        options.warnings.push({ path: rel, message: `Wiki.js asset not downloaded (${data})` });
      else write(rel, data);
    }
    const { assets: folders } = await gql<{ assets: { folders: { id: number; slug: string }[] } }>(FOLDERS_QUERY, {
      f: folderId,
    });
    for (const folder of folders.folders) await walk(folder.id, `${prefix}${folder.slug}/`);
  };
  await walk(0, "");

  // 3. the asset database does not know every file the pages use (pasted screenshots, …):
  //    fetch everything the pages reference by URL
  const references = new Set<string>();
  for (const file of listFiles(options.outDir).filter(isPage)) {
    for (const match of readFileSync(file, "utf8").matchAll(REFERENCE)) references.add(unquotePath(match[1] ?? ""));
  }
  const missing: string[] = [];
  for (const rel of [...references].toSorted()) {
    if (existsSync(join(options.outDir, rel))) continue;
    const data = await download(rel, true);
    if (typeof data === "string") missing.push(`${rel}: ${data}`);
    else write(rel, data);
  }
  for (const entry of missing) {
    options.warnings.push({
      path: entry.split(":")[0] ?? entry,
      message: `referenced file missing on Wiki.js (${entry})`,
    });
  }

  const files = listFiles(options.outDir);
  const pages = files.filter(isPage).length;
  log(`Wiki.js export: ${pages} pages, ${files.length - pages} assets, ${missing.length} missing → ${options.outDir}`);
  return { pages, assets: files.length - pages, missing };
}
