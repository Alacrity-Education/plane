/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix, relative, sep } from "node:path";
import { decodeSegment } from "./paths";

/** Image types Plane's asset API accepts for page images. */
export const UPLOADABLE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Types converted to PNG before upload. */
export const CONVERTIBLE_EXTENSIONS = new Set([".svg", ".avif", ".ico", ".bmp", ".tif", ".tiff", ".heic"]);

export type TImageSource =
  | { kind: "file"; file: string }
  | { kind: "data"; mime: string; data: Buffer }
  | { kind: "remote"; url: string };

/** A prepared image ready for upload. */
export type TPreparedImage = {
  name: string;
  mime: string;
  data: Buffer;
  sha256: string;
  width: number;
  height: number;
  convertedFrom?: string;
};

/** Index of every image in the repository by lowercase basename (fallback for moved images). */
export function indexRepositoryImages(repoDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const ext = extname(entry.name).toLowerCase();
        if (UPLOADABLE_TYPES[ext] || CONVERTIBLE_EXTENSIONS.has(ext)) {
          const rel = relative(repoDir, full).split(sep).join("/");
          const key = entry.name.toLowerCase();
          index.set(key, [...(index.get(key) ?? []), rel]);
        }
      }
    }
  };
  walk(repoDir);
  return index;
}

/**
 * Finds the file an image reference points to. Wiki.js references are absolute from the
 * repository root; `.github/sync.py` later moved single-use images next to their page, so a
 * reference may be stale — fall back to the page's folder, then to a unique basename match.
 */
export function locateImage(
  src: string,
  pageFile: string,
  repoDir: string,
  index: Map<string, string[]>
): { source: TImageSource; note?: string } | null {
  const trimmed = src.trim();
  const dataMatch = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(trimmed);
  if (dataMatch) {
    const payload = dataMatch[3] ?? "";
    const data = dataMatch[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload));
    return { source: { kind: "data", mime: dataMatch[1] ?? "application/octet-stream", data } };
  }
  if (/^https?:\/\//i.test(trimmed)) return { source: { kind: "remote", url: trimmed } };

  const clean = trimmed.replace(/[?#].*$/, "");
  const decoded = clean.split("/").map(decodeSegment).join("/");
  const pageDir = posix.dirname(pageFile);
  const candidates = clean.startsWith("/")
    ? [decoded.slice(1), clean.slice(1)]
    : [posix.join(pageDir, decoded), posix.join(pageDir, clean)];
  for (const candidate of candidates) {
    const full = join(repoDir, candidate);
    if (existsSync(full) && statSync(full).isFile()) return { source: { kind: "file", file: full } };
  }
  const name = basename(decoded);
  const besidePage = join(repoDir, pageDir, name);
  if (existsSync(besidePage)) {
    return {
      source: { kind: "file", file: besidePage },
      note: `found next to the page (${posix.join(pageDir, name)})`,
    };
  }
  const matches = index.get(name.toLowerCase()) ?? [];
  if (matches.length === 1 && matches[0]) {
    return { source: { kind: "file", file: join(repoDir, matches[0]) }, note: `found by file name (${matches[0]})` };
  }
  return null;
}

function run(cmd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync(cmd, args, { input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

let magickCommand: string | null | undefined;
function magick(): string | null {
  if (magickCommand !== undefined) return magickCommand;
  for (const candidate of ["magick", "convert"]) {
    try {
      run(candidate, ["-version"]);
      magickCommand = candidate;
      return candidate;
    } catch {
      // try the next one
    }
  }
  magickCommand = null;
  return null;
}

function hasCommand(cmd: string): boolean {
  try {
    run(cmd, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Natural size of a PNG/JPEG/GIF/WebP buffer, read from its header. */
export function probeImageSize(data: Buffer): { width: number; height: number } | null {
  // PNG
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // GIF
  if (data.length > 10 && data.toString("ascii", 0, 3) === "GIF") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  // WebP
  if (data.length > 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    }
  }
  // JPEG
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1] ?? 0;
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/** Size an SVG asks for (width/height attributes, else the viewBox). */
export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const num = (name: string) => {
    const value = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i").exec(tag)?.[1];
    return value ? Number(value) : undefined;
  };
  const width = num("width");
  const height = num("height");
  if (width && height) return { width, height };
  const viewBox = /\sviewBox\s*=\s*["']([^"']+)["']/i
    .exec(tag)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox && viewBox.length === 4 && viewBox[2] && viewBox[3]) return { width: viewBox[2], height: viewBox[3] };
  return null;
}

const SVG_RENDER_SCALE = 2;

/**
 * Turns an image into something Plane accepts: PNG/JPEG/GIF/WebP pass through, SVG is
 * rendered with rsvg-convert (or ImageMagick) at 2x, AVIF/ICO/BMP/TIFF go through ImageMagick.
 */
export function prepareImage(name: string, data: Buffer, cacheDir: string): TPreparedImage {
  const ext = extname(name).toLowerCase();
  const sha256 = createHash("sha256").update(data).digest("hex");
  const mime = UPLOADABLE_TYPES[ext];
  if (mime) {
    const size = probeImageSize(data);
    if (!size) throw new Error(`cannot read the size of ${name}`);
    return { name, mime, data, sha256, ...size };
  }
  if (!CONVERTIBLE_EXTENSIONS.has(ext)) throw new Error(`unsupported image type ${ext || "(none)"}`);

  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `${sha256}.png`);
  const pngName = `${basename(name, extname(name))}.png`;
  let display: { width: number; height: number } | null = null;

  if (ext === ".svg") {
    const intrinsic = svgIntrinsicSize(data.toString("utf8"));
    if (!existsSync(cached)) {
      if (hasCommand("rsvg-convert")) {
        writeFileSync(cached, run("rsvg-convert", ["--zoom", String(SVG_RENDER_SCALE), "--format", "png"], data));
      } else {
        const cmd = magick();
        if (!cmd) throw new Error("SVG conversion needs rsvg-convert or ImageMagick");
        const input = join(cacheDir, `${sha256}.svg`);
        writeFileSync(input, data);
        run(cmd, ["-density", String(96 * SVG_RENDER_SCALE), "-background", "none", input, cached]);
      }
    }
    const png = readFileSync(cached);
    const rendered = probeImageSize(png);
    display =
      intrinsic ??
      (rendered ? { width: rendered.width / SVG_RENDER_SCALE, height: rendered.height / SVG_RENDER_SCALE } : null);
    if (!rendered || !display) throw new Error(`cannot render ${name}`);
    return { name: pngName, mime: "image/png", data: png, sha256, ...display, convertedFrom: ext.slice(1) };
  }

  const cmd = magick();
  if (!cmd) throw new Error(`converting ${ext} needs ImageMagick (magick/convert)`);
  if (!existsSync(cached)) {
    const input = join(cacheDir, `${sha256}${ext}`);
    writeFileSync(input, data);
    // Multi-image files (ICO): keep the largest frame
    let frame = "";
    if (ext === ".ico") {
      const sizes = run(cmd === "magick" ? "magick" : "identify", [
        ...(cmd === "magick" ? ["identify"] : []),
        "-format",
        "%w\n",
        input,
      ])
        .toString()
        .trim()
        .split("\n")
        .map(Number);
      const largest = sizes.indexOf(Math.max(...sizes));
      frame = `[${Math.max(largest, 0)}]`;
    }
    run(cmd, [`${input}${frame}`, `png:${cached}`]);
  }
  const png = readFileSync(cached);
  display = probeImageSize(png);
  if (!display) throw new Error(`cannot convert ${name}`);
  return { name: pngName, mime: "image/png", data: png, sha256, ...display, convertedFrom: ext.slice(1) };
}

/**
 * Shrinks an image that exceeds the upload limit: re-encodes it as WebP (keeps transparency),
 * scaling the longest side down step by step until it fits. Returns null without ImageMagick.
 */
export function shrinkImage(image: TPreparedImage, maxBytes: number, cacheDir: string): TPreparedImage | null {
  const cmd = magick();
  if (!cmd) return null;
  mkdirSync(cacheDir, { recursive: true });
  const input = join(cacheDir, `${image.sha256}-in${extname(image.name) || ".png"}`);
  writeFileSync(input, image.data);
  for (const [side, quality] of [
    [3200, 85],
    [2400, 82],
    [1800, 80],
    [1280, 75],
  ] as const) {
    const output = join(cacheDir, `${image.sha256}-${side}.webp`);
    if (!existsSync(output)) {
      run(cmd, [`${input}[0]`, "-resize", `${side}x${side}>`, "-quality", String(quality), `webp:${output}`]);
    }
    const data = readFileSync(output);
    if (data.length <= maxBytes) {
      const size = probeImageSize(data);
      if (!size) return null;
      // Keep the display size of the original: only the stored resolution changes
      return {
        ...image,
        name: `${basename(image.name, extname(image.name))}.webp`,
        mime: "image/webp",
        data,
        convertedFrom: image.convertedFrom ?? extname(image.name).slice(1),
      };
    }
  }
  return null;
}

/** Loads the bytes of an image source. */
export async function loadImageSource(source: TImageSource): Promise<{ name: string; data: Buffer }> {
  if (source.kind === "file") return { name: basename(source.file), data: readFileSync(source.file) };
  if (source.kind === "data") {
    const ext = source.mime === "image/svg+xml" ? ".svg" : `.${source.mime.split("/")[1] ?? "bin"}`;
    return { name: `diagram${ext}`, data: source.data };
  }
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const fromType = Object.entries(UPLOADABLE_TYPES).find(([, mime]) => mime === type)?.[0];
  let name = basename(new URL(source.url).pathname) || "image";
  if (!extname(name)) name += fromType ?? (type === "image/svg+xml" ? ".svg" : ".png");
  return { name, data: Buffer.from(await response.arrayBuffer()) };
}

export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
