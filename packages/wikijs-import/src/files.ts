/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Links to repository files that are not pages (downloads: logo variants, PDFs, archives…).
// They are uploaded as workspace assets and the link points at Plane's session download route.

import { extname } from "node:path";

/** MIME type by file extension (only types Plane's asset APIs can accept are useful here). */
export const FILE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".ico": "image/vnd.microsoft.icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".odg": "application/vnd.oasis.opendocument.graphics",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".sql": "application/x-sql",
  ".vsd": "application/vnd.visio",
  ".vsdx": "application/vnd.visio",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/x-rar-compressed",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/x-m4a",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".stl": "application/octet-stream",
  ".step": "application/octet-stream",
  ".stp": "application/octet-stream",
  ".bin": "application/octet-stream",
};

/** What the session-authenticated v2 workspace asset endpoint accepts (`WorkspaceFileAssetEndpoint`). */
export const SESSION_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/jpg", "image/gif"]);

/** `settings.ATTACHMENT_MIME_TYPES`: what the v1 `GenericAssetEndpoint` (API key) accepts. */
export const API_KEY_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/svg+xml",
  "image/webp",
  "image/tiff",
  "image/bmp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "application/rtf",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.graphics",
  "application/vnd.visio",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/x-m4a",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "application/zip",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
  "model/gltf-binary",
  "model/gltf+json",
  "application/octet-stream",
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/json",
  "text/xml",
  "text/csv",
  "application/xml",
  "application/x-sql",
]);

export type TFileUploadRoute = "session" | "api-key" | "unsupported";

/** MIME type of a linked file, from its extension (`.md` gets text/markdown). */
export function fileMimeType(name: string): string | undefined {
  const ext = extname(name).toLowerCase();
  if (ext === ".md") return "text/markdown";
  return FILE_MIME_TYPES[ext];
}

/**
 * Which endpoint can store a file of this type: the session v2 endpoint (page-bound, images
 * only), the v1 API-key endpoint (everything in ATTACHMENT_MIME_TYPES), or neither.
 */
export function uploadRouteFor(mime: string | undefined): TFileUploadRoute {
  if (!mime) return "unsupported";
  if (SESSION_UPLOAD_TYPES.has(mime)) return "session";
  if (API_KEY_UPLOAD_TYPES.has(mime)) return "api-key";
  return "unsupported";
}

/**
 * Root-relative URL of Plane's session download route (`WorkspaceAssetDownloadEndpoint`): it
 * redirects a signed-in workspace member to a signed URL with `Content-Disposition: attachment`.
 * Root-relative so it survives a change of the Plane host name.
 */
export const assetDownloadPath = (workspaceSlug: string, assetId: string): string =>
  `/api/assets/v2/workspaces/${encodeURIComponent(workspaceSlug)}/download/${assetId}/`;
