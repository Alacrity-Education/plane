/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { onAuthenticate } from "@/lib/auth";
import { UserService } from "@/services/user.service";
import type { HocusPocusServerContext } from "@/types";

vi.mock("@plane/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { API_BASE_URL: "http://api.test", LIVE_SERVER_SECRET_KEY: "secret", LIVE_BASE_PATH: "/live" },
}));

const token = JSON.stringify({ id: "user-1", name: "User", color: "#000" });
const requestHeaders = { cookie: "session-id=abc" };

const authenticate = (query: string) => {
  const context = {} as HocusPocusServerContext;
  const promise = onAuthenticate({
    requestHeaders,
    requestParameters: new URLSearchParams(query),
    context,
    token,
  });
  return { context, promise };
};

describe("onAuthenticate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an unknown documentType without calling the API", async () => {
    const currentUser = vi.spyOn(UserService.prototype, "currentUser");
    await expect(authenticate("documentType=team_page&workspaceSlug=acme").promise).rejects.toMatchObject({
      code: "AUTH_INVALID_DOCUMENT_TYPE",
    });
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("rejects a missing documentType", async () => {
    await expect(authenticate("workspaceSlug=acme").promise).rejects.toMatchObject({
      code: "AUTH_INVALID_DOCUMENT_TYPE",
    });
  });

  it("rejects a missing workspaceSlug", async () => {
    const currentUser = vi.spyOn(UserService.prototype, "currentUser");
    await expect(authenticate("documentType=workspace_page").promise).rejects.toMatchObject({
      code: "AUTH_MISSING_WORKSPACE_SLUG",
    });
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("accepts a workspace_page connection without projectId", async () => {
    vi.spyOn(UserService.prototype, "currentUser").mockResolvedValue({ id: "user-1", display_name: "User" } as never);
    const { context, promise } = authenticate("documentType=workspace_page&workspaceSlug=acme");
    await expect(promise).resolves.toEqual({ user: { id: "user-1", name: "User" } });
    expect(context).toEqual({
      cookie: "session-id=abc",
      documentType: "workspace_page",
      projectId: null,
      userId: "user-1",
      workspaceSlug: "acme",
    });
  });
});
