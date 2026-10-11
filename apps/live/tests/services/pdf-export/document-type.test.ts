/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { PdfExportService } from "@/services/pdf-export/pdf-export.service";
import type { PdfExportInput } from "@/services/pdf-export/types";

vi.mock("@plane/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { API_BASE_URL: "http://api.test", LIVE_SERVER_SECRET_KEY: "secret", LIVE_BASE_PATH: "/live" },
}));

const baseInput: PdfExportInput = { pageId: "page-1", workspaceSlug: "acme", cookie: "c=1", requestId: "r-1" };

const getDocumentType = (input: PdfExportInput) =>
  Effect.runSync(
    Effect.gen(function* () {
      const service = yield* PdfExportService;
      return service.getDocumentType(input);
    }).pipe(Effect.provide(PdfExportService.Default))
  );

describe("PdfExportService.getDocumentType", () => {
  it("infers project_page when projectId is present", () => {
    expect(getDocumentType({ ...baseInput, projectId: "p-1" })).toBe("project_page");
  });

  it("infers workspace_page when projectId is absent", () => {
    expect(getDocumentType(baseInput)).toBe("workspace_page");
  });

  it("honours an explicit documentType", () => {
    expect(getDocumentType({ ...baseInput, projectId: "p-1", documentType: "workspace_page" })).toBe("workspace_page");
  });
});
