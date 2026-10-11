/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { APIService } from "@/services/api.service";
import { WorkspacePageService } from "@/services/page/workspace-page.service";

vi.mock("@plane/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { API_BASE_URL: "http://api.test", LIVE_SERVER_SECRET_KEY: "secret", LIVE_BASE_PATH: "/live" },
}));

class TestableWorkspacePageService extends WorkspacePageService {
  getBasePath() {
    return this.basePath;
  }
}

const createService = () => new TestableWorkspacePageService({ workspaceSlug: "acme", cookie: "session-id=abc" });

describe("WorkspacePageService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the workspace wiki base path and forwards the cookie", () => {
    const service = createService();
    expect(service.getBasePath()).toBe("/api/workspaces/acme/wiki");
    expect(service.getHeader()).toEqual({ Cookie: "session-id=abc" });
  });

  it("throws without a workspaceSlug", () => {
    expect(() => new WorkspacePageService({ workspaceSlug: null, cookie: "c=1" })).toThrow("Missing required fields.");
  });

  it("throws without a cookie", () => {
    expect(() => new WorkspacePageService({ workspaceSlug: "acme", cookie: null })).toThrow("Cookie is required.");
  });

  it("fetchDescriptionBinary GETs the wiki description endpoint", async () => {
    const getSpy = vi.spyOn(APIService.prototype, "get").mockResolvedValue({ data: Buffer.from([1, 2]) } as never);
    const result = await createService().fetchDescriptionBinary("page-1");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toBe("/api/workspaces/acme/wiki/pages/page-1/description/");
    expect(getSpy.mock.calls[0][1]).toMatchObject({
      headers: { Cookie: "session-id=abc" },
      responseType: "arraybuffer",
    });
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it("fetchDetails GETs the wiki page without tracking a visit", async () => {
    const getSpy = vi.spyOn(APIService.prototype, "get").mockResolvedValue({ data: { id: "page-1" } } as never);
    await createService().fetchDetails("page-1");
    expect(getSpy.mock.calls[0][0]).toBe("/api/workspaces/acme/wiki/pages/page-1/");
    expect(getSpy.mock.calls[0][1]).toMatchObject({
      headers: { Cookie: "session-id=abc" },
      params: { track_visit: false },
    });
  });

  it("updateDescriptionBinary PATCHes the wiki description endpoint", async () => {
    const patchSpy = vi.spyOn(APIService.prototype, "patch").mockResolvedValue({ data: {} } as never);
    const payload = { description_binary: "AA==", description_html: "<p></p>", description_json: {} };
    await createService().updateDescriptionBinary("page-1", payload);
    expect(patchSpy).toHaveBeenCalledWith("/api/workspaces/acme/wiki/pages/page-1/description/", payload, {
      headers: { Cookie: "session-id=abc" },
    });
  });

  it("updatePageProperties PATCHes the wiki page endpoint", async () => {
    const patchSpy = vi
      .spyOn(APIService.prototype, "patch")
      .mockResolvedValue({ data: { id: "page-1", name: "New" } } as never);
    const result = await createService().updatePageProperties("page-1", { data: { name: "New" } });
    expect(patchSpy.mock.calls[0][0]).toBe("/api/workspaces/acme/wiki/pages/page-1/");
    expect(patchSpy.mock.calls[0][1]).toEqual({ name: "New" });
    expect(result).toEqual({ id: "page-1", name: "New" });
  });

  it("resolveImageAssetUrl always uses the project-less workspace asset endpoint", async () => {
    const getSpy = vi.spyOn(APIService.prototype, "get").mockResolvedValue({
      status: 302,
      headers: { location: "https://s3.example/asset" },
    } as never);
    const url = await createService().resolveImageAssetUrl("acme", "asset-1", "project-1");
    expect(url).toBe("https://s3.example/asset");
    expect(getSpy.mock.calls[0][0]).toBe("/api/assets/v2/workspaces/acme/asset-1/?disposition=inline");
  });
});
