/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import { Database } from "@/extensions/database";
import { forceCloseDocumentAcrossServers } from "@/extensions/force-close-handler";
import { AppError } from "@/lib/errors";
import { getPageService } from "@/services/page/handler";
import type { HocusPocusServerContext, StorePayloadWithContext } from "@/types";
import { CloseCode, ForceCloseReason } from "@/types/admin-commands";
import { broadcastError } from "@/utils/broadcast-error";

vi.mock("@plane/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { API_BASE_URL: "http://api.test", LIVE_SERVER_SECRET_KEY: "secret", LIVE_BASE_PATH: "/live" },
}));
vi.mock("@plane/editor", () => ({
  getAllDocumentFormatsFromDocumentEditorBinaryData: vi.fn(() => ({
    contentBinaryEncoded: "AA==",
    contentHTML: "<p></p>",
    contentJSON: {},
  })),
  getBinaryDataFromDocumentEditorHTMLString: vi.fn(),
}));
vi.mock("@/services/page/handler", () => ({ getPageService: vi.fn() }));
vi.mock("@/utils/broadcast-error", () => ({ broadcastError: vi.fn() }));
vi.mock("@/extensions/force-close-handler", () => ({ forceCloseDocumentAcrossServers: vi.fn() }));

const context: HocusPocusServerContext = {
  projectId: null,
  cookie: "session-id=abc",
  documentType: "workspace_page",
  workspaceSlug: "acme",
  userId: "user-1",
};
const instance = {} as Hocuspocus;

const apiError = (status: number, data: unknown) =>
  new AppError({
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    config: { method: "patch", url: "/api/workspaces/acme/wiki/pages/page-1/description/" },
    response: { status, data },
  });

const store = (error: unknown) => {
  vi.mocked(getPageService).mockReturnValue({
    updateDescriptionBinary: vi.fn().mockRejectedValue(error),
  } as unknown as ReturnType<typeof getPageService>);
  const payload = { context, state: new Uint8Array(), documentName: "page-1", instance };
  return new Database().configuration.store(payload as unknown as StorePayloadWithContext);
};

describe("Database.storeDocument error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps API 400 error_code 4701 to page_locked", async () => {
    await expect(store(apiError(400, { error_code: 4701, error_message: "PAGE_LOCKED" }))).rejects.toBeInstanceOf(
      AppError
    );
    expect(broadcastError).toHaveBeenCalledWith(
      instance,
      "page-1",
      expect.any(String),
      "store",
      context,
      "page_locked",
      false
    );
    expect(forceCloseDocumentAcrossServers).not.toHaveBeenCalled();
  });

  it("maps API 400 error_code 4702 to page_archived", async () => {
    await expect(store(apiError(400, { error_code: 4702, error_message: "PAGE_ARCHIVED" }))).rejects.toBeInstanceOf(
      AppError
    );
    expect(broadcastError).toHaveBeenCalledWith(
      instance,
      "page-1",
      expect.any(String),
      "store",
      context,
      "page_archived",
      false
    );
  });

  it("leaves other 400s without an error code", async () => {
    await expect(store(apiError(400, { error: "bad" }))).rejects.toBeInstanceOf(AppError);
    expect(broadcastError).toHaveBeenCalledWith(
      instance,
      "page-1",
      "Unable to save the page. Please try again.",
      "store",
      context,
      undefined,
      false
    );
  });

  it("still force-closes on 413", async () => {
    await expect(store(apiError(413, "too large"))).resolves.toBeUndefined();
    expect(broadcastError).toHaveBeenCalledWith(
      instance,
      "page-1",
      expect.any(String),
      "store",
      context,
      "content_too_large",
      true
    );
    expect(forceCloseDocumentAcrossServers).toHaveBeenCalledWith(
      instance,
      "page-1",
      ForceCloseReason.DOCUMENT_TOO_LARGE,
      CloseCode.DOCUMENT_TOO_LARGE
    );
  });
});
