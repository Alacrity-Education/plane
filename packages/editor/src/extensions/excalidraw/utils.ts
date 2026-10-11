/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// local imports
import { EExcalidrawAttributeNames, EExcalidrawStatus } from "./types";
import type { TExcalidrawAttributes } from "./types";

export const DEFAULT_EXCALIDRAW_ATTRIBUTES: TExcalidrawAttributes = {
  [EExcalidrawAttributeNames.ID]: null,
  [EExcalidrawAttributeNames.SOURCE]: null,
  [EExcalidrawAttributeNames.WIDTH]: "100%",
  [EExcalidrawAttributeNames.HEIGHT]: "auto",
  [EExcalidrawAttributeNames.ASPECT_RATIO]: null,
  [EExcalidrawAttributeNames.ALIGNMENT]: "left",
  [EExcalidrawAttributeNames.STATUS]: EExcalidrawStatus.PENDING,
};

export const getExcalidrawBlockId = (id: string) => `editor-excalidraw-block-${id}`;

/** Parses the (lowercased by HTML parsers) aspect ratio attribute into a finite number or null. */
export const parseExcalidrawAspectRatio = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const isDarkThemeActive = (): boolean => {
  if (typeof document === "undefined") return false;
  return !!document.documentElement.getAttribute("data-theme")?.includes("dark");
};
