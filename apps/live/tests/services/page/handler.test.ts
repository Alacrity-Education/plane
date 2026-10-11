/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect, vi } from "vitest";
import { getPageService } from "@/services/page/handler";
import { ProjectPageService } from "@/services/page/project-page.service";
import { WorkspacePageService } from "@/services/page/workspace-page.service";
import type { HocusPocusServerContext, TDocumentTypes } from "@/types";

vi.mock("@plane/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { API_BASE_URL: "http://api.test", LIVE_SERVER_SECRET_KEY: "secret", LIVE_BASE_PATH: "/live" },
}));

const baseContext: HocusPocusServerContext = {
  projectId: null,
  cookie: "session-id=abc",
  documentType: "workspace_page",
  workspaceSlug: "acme",
  userId: "user-1",
};

describe("getPageService", () => {
  it("returns a WorkspacePageService for workspace_page without a projectId", () => {
    const service = getPageService("workspace_page", baseContext);
    expect(service).toBeInstanceOf(WorkspacePageService);
  });

  it("returns a ProjectPageService for project_page with a projectId", () => {
    const service = getPageService("project_page", { ...baseContext, documentType: "project_page", projectId: "p-1" });
    expect(service).toBeInstanceOf(ProjectPageService);
  });

  it("throws for project_page without a projectId", () => {
    expect(() => getPageService("project_page", { ...baseContext, documentType: "project_page" })).toThrow(
      "Missing required fields."
    );
  });

  it("throws for workspace_page without a workspaceSlug", () => {
    expect(() => getPageService("workspace_page", { ...baseContext, workspaceSlug: null })).toThrow(
      "Missing required fields."
    );
  });

  it("throws for an unknown document type", () => {
    expect(() => getPageService("team_page" as TDocumentTypes, baseContext)).toThrow("Invalid document type");
  });
});
