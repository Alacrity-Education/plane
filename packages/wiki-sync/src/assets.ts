/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IWikiSource, TLogger, TWikiAsset } from "./types";

export type TResolvedAsset = {
  id: string;
  name: string;
  /** Public URL used in the Markdown, e.g. /wiki-assets/<id>.png */
  url: string;
  fileName: string;
};

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "application/pdf": "pdf",
};

const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAssetId = (value: string): boolean => UUID.test(value);

/** File extension from the MIME type, falling back to the original file name. */
export function getAssetExtension(type?: string | null, name?: string | null): string {
  const mime = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fromMime = MIME_EXTENSIONS[mime];
  if (fromMime) return fromMime;
  const fromName = (name ?? "").split(/[?#]/)[0]?.split(".").pop()?.toLowerCase() ?? "";
  if (name?.includes(".") && SAFE_EXTENSION.test(fromName)) return fromName === "jpeg" ? "jpg" : fromName;
  return "bin";
}

/** Asset ids referenced by <image-component src="<uuid>"> / <excalidraw-component src="<uuid>"> in TipTap HTML. */
export function extractImageAssetIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /<(?:image|excalidraw)-component\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(re)) {
    const src = match[1]?.trim() ?? "";
    if (isAssetId(src)) ids.add(src.toLowerCase());
  }
  return [...ids];
}

export type TAssetStoreOptions = {
  source: IWikiSource;
  /** Directory on disk, e.g. static/wiki-assets */
  dir: string;
  /** Public URL prefix, e.g. /wiki-assets */
  publicPath: string;
  logger: TLogger;
};

/**
 * Downloads page images into `dir/<id>.<ext>`. Asset ids are immutable, so an existing file is
 * never downloaded again. Concurrent requests for the same id share one download.
 */
export class AssetStore {
  private readonly options: TAssetStoreOptions;
  private readonly inflight = new Map<string, Promise<TResolvedAsset | null>>();
  private existing: Map<string, string> | null = null;
  /** File names referenced by this run (for stale cleanup). */
  readonly used = new Set<string>();

  constructor(options: TAssetStoreOptions) {
    this.options = options;
  }

  private publicUrl(fileName: string): string {
    return `${this.options.publicPath.replace(/\/+$/, "")}/${fileName}`;
  }

  private async scanExisting(): Promise<Map<string, string>> {
    if (this.existing) return this.existing;
    const map = new Map<string, string>();
    try {
      for (const file of await readdir(this.options.dir)) {
        const id = file.split(".")[0] ?? "";
        if (isAssetId(id) && !file.endsWith(".tmp")) map.set(id.toLowerCase(), file);
      }
    } catch {
      // directory does not exist yet
    }
    this.existing = map;
    return map;
  }

  resolve(assetId: string, meta?: TWikiAsset): Promise<TResolvedAsset | null> {
    const id = assetId.toLowerCase();
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.fetchAsset(id, meta);
      this.inflight.set(id, pending);
    }
    return pending;
  }

  private async fetchAsset(id: string, meta?: TWikiAsset): Promise<TResolvedAsset | null> {
    const existing = await this.scanExisting();
    const cached = existing.get(id);
    const name = meta?.name ?? "";
    if (cached) {
      this.used.add(cached);
      return { id, name, url: this.publicUrl(cached), fileName: cached };
    }
    try {
      const info = await this.options.source.getAssetUrl(id);
      const file = await this.options.source.download(info.asset_url);
      const ext = getAssetExtension(meta?.type || info.asset_type || file.contentType, meta?.name || info.asset_name);
      const fileName = `${id}.${ext}`;
      await mkdir(this.options.dir, { recursive: true });
      const target = join(this.options.dir, fileName);
      await writeFile(`${target}.tmp`, file.data);
      await rename(`${target}.tmp`, target);
      existing.set(id, fileName);
      this.used.add(fileName);
      return { id, name: name || info.asset_name || "", url: this.publicUrl(fileName), fileName };
    } catch (error) {
      this.options.logger.warn(`asset ${id}: download failed, image dropped (${(error as Error).message})`);
      return null;
    }
  }
}
