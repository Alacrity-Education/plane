/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TPageState = {
  id: string;
  path: string;
  title: string;
  /** Hash of the last description written (skips unchanged pages on re-runs). */
  contentHash?: string | undefined;
  /** Identifier of the Plane project whose wiki section holds the page. */
  project?: string | undefined;
  /** Set when the page is the project section's root page: the root keeps this name. */
  rootName?: string | undefined;
};

export type TImportState = {
  version: 1;
  baseUrl?: string;
  workspaceSlug?: string;
  /** Normalized Wiki.js path → Plane page. */
  pages: Record<string, TPageState>;
  /** Normalized Wiki.js path → image sha256 → Plane asset id. */
  assets: Record<string, Record<string, string>>;
};

export function emptyState(): TImportState {
  return { version: 1, pages: {}, assets: {} };
}

export function loadState(file: string): TImportState {
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TImportState>;
  return { ...emptyState(), ...parsed, pages: parsed.pages ?? {}, assets: parsed.assets ?? {} };
}

/** Writes atomically so an interrupted run never leaves a truncated state file. */
export function saveState(file: string, state: TImportState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
