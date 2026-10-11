/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { PdfExportService } from "@/services/pdf-export/pdf-export.service";

vi.mock("@plane/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { API_BASE_URL: "http://api.test", LIVE_SERVER_SECRET_KEY: "secret", LIVE_BASE_PATH: "/live" },
}));

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[] };

const extract = (doc: Node) =>
  Effect.runSync(
    Effect.gen(function* () {
      const service = yield* PdfExportService;
      return service.extractImageAssetIds(doc);
    }).pipe(Effect.provide(PdfExportService.Default))
  );

const IMAGE_ID = "4a6e1c36-0d6b-4d0e-9a0e-0f9a3c1b2d11";
const DRAWING_ID = "8b1d2e47-5c3f-4e2a-b7d9-1c2b3a4d5e22";

describe("PdfExportService.extractImageAssetIds", () => {
  it("collects excalidrawComponent src alongside imageComponent src", () => {
    const doc: Node = {
      type: "doc",
      content: [
        { type: "imageComponent", attrs: { src: IMAGE_ID } },
        {
          type: "excalidrawComponent",
          attrs: { id: "node-1", src: DRAWING_ID, width: "100%", aspectRatio: 1.5, status: "uploaded" },
        },
      ],
    };
    expect(extract(doc)).toEqual([IMAGE_ID, DRAWING_ID]);
  });

  it("finds drawings nested in other blocks and dedupes", () => {
    const doc: Node = {
      type: "doc",
      content: [
        {
          type: "calloutComponent",
          content: [{ type: "excalidrawComponent", attrs: { src: DRAWING_ID } }],
        },
        { type: "excalidrawComponent", attrs: { src: DRAWING_ID } },
      ],
    };
    expect(extract(doc)).toEqual([DRAWING_ID]);
  });

  it("skips drawings without src and with absolute/data urls", () => {
    const doc: Node = {
      type: "doc",
      content: [
        { type: "excalidrawComponent", attrs: { src: null, status: "pending" } },
        { type: "excalidrawComponent", attrs: { src: "https://cdn.example/x.png" } },
        { type: "excalidrawComponent", attrs: { src: "data:image/png;base64,AAAA" } },
        { type: "excalidrawComponent" },
      ],
    };
    expect(extract(doc)).toEqual([]);
  });
});
