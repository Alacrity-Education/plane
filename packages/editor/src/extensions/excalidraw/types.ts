/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Node } from "@tiptap/core";
// types
import type { TFileHandler } from "@/types";

export enum EExcalidrawAttributeNames {
  ID = "id",
  SOURCE = "src",
  WIDTH = "width",
  HEIGHT = "height",
  ASPECT_RATIO = "aspectRatio",
  ALIGNMENT = "alignment",
  STATUS = "status",
}

export enum EExcalidrawStatus {
  PENDING = "pending",
  UPLOADING = "uploading",
  UPLOADED = "uploaded",
  DUPLICATING = "duplicating",
  DUPLICATION_FAILED = "duplication-failed",
}

export type TExcalidrawPixel = `${number}px`;

export type TExcalidrawAlignment = "left" | "center" | "right";

export type TExcalidrawAttributes = {
  [EExcalidrawAttributeNames.ID]: string | null;
  [EExcalidrawAttributeNames.SOURCE]: string | null;
  [EExcalidrawAttributeNames.WIDTH]: TExcalidrawPixel | "100%" | null;
  [EExcalidrawAttributeNames.HEIGHT]: TExcalidrawPixel | "auto" | null;
  [EExcalidrawAttributeNames.ASPECT_RATIO]: number | null;
  [EExcalidrawAttributeNames.ALIGNMENT]: TExcalidrawAlignment;
  [EExcalidrawAttributeNames.STATUS]: EExcalidrawStatus;
};

export type InsertExcalidrawComponentProps = {
  pos?: number;
};

export type ExcalidrawExtensionOptions = {
  getAssetSrc?: TFileHandler["getAssetSrc"];
  restoreAsset?: TFileHandler["restore"];
  uploadAsset?: TFileHandler["upload"];
  duplicateAsset?: TFileHandler["duplicate"];
};

export type ExcalidrawExtensionStorage = {
  /** asset ids removed from the document (read by the file delete/restore plugins) */
  deletedImageSet: Map<string, boolean>;
  /** ids of freshly inserted drawings whose editor should open on mount */
  pendingOpen: Set<string>;
  maxFileSize: number;
};

export type ExcalidrawExtensionType = Node<ExcalidrawExtensionOptions, ExcalidrawExtensionStorage>;
