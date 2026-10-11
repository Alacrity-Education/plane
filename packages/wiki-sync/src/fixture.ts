/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  IWikiSource,
  TAssetUrlResponse,
  TDownloadedFile,
  TWikiMember,
  TWikiPageDetail,
  TWikiPageSummary,
} from "./types";

/**
 * Offline input for `--from-fixture <file.json>` (demos, Docusaurus smoke builds, tests):
 * { planeUrl?, workspaceSlug?, members?: [{id, display_name}], pages: TWikiPageDetail[],
 *   assets?: { "<asset uuid>": { file: "relative/to/fixture.png", type?: "image/png", name?: "x.png" } } }
 */
export type TWikiFixture = {
  planeUrl?: string;
  workspaceSlug?: string;
  members?: TWikiMember[];
  pages: TWikiPageDetail[];
  assets?: Record<string, { file: string; type?: string; name?: string }>;
};

export class FixtureSource implements IWikiSource {
  readonly fixture: TWikiFixture;
  private readonly baseDir: string;

  constructor(fixture: TWikiFixture, baseDir: string) {
    this.fixture = fixture;
    this.baseDir = baseDir;
  }

  static async fromFile(path: string): Promise<FixtureSource> {
    const fixture = JSON.parse(await readFile(path, "utf8")) as TWikiFixture;
    if (!Array.isArray(fixture.pages)) throw new Error(`${path}: fixture must have a "pages" array`);
    return new FixtureSource(fixture, dirname(resolve(path)));
  }

  async listPages(): Promise<TWikiPageSummary[]> {
    return this.fixture.pages.map(({ description_html: _html, assets: _assets, ...summary }) => summary);
  }

  async getPage(pageId: string): Promise<TWikiPageDetail> {
    const page = this.fixture.pages.find((p) => p.id === pageId);
    if (!page) throw new Error(`fixture: page ${pageId} not found`);
    return page;
  }

  async getAssetUrl(assetId: string): Promise<TAssetUrlResponse> {
    const asset = this.fixture.assets?.[assetId];
    if (!asset) throw new Error(`fixture: asset ${assetId} not found`);
    return {
      asset_id: assetId,
      asset_url: pathToFileURL(resolve(this.baseDir, asset.file)).href,
      asset_name: asset.name ?? asset.file.split("/").pop() ?? "",
      asset_type: asset.type ?? "",
    };
  }

  async download(url: string): Promise<TDownloadedFile> {
    const data = await readFile(fileURLToPath(url));
    return { data: new Uint8Array(data), contentType: null };
  }

  async listMembers(): Promise<TWikiMember[]> {
    return this.fixture.members ?? [];
  }
}
