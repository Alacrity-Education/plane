/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { logger } from "@plane/logger";
import type { TPage } from "@plane/types";
import { AppError } from "@/lib/errors";
import { PageService } from "./extended.service";

interface WorkspacePageServiceParams {
  workspaceSlug: string | null;
  cookie: string | null;
  [key: string]: unknown;
}

/**
 * Page service for workspace-level (wiki) pages.
 * Inherited calls hit `/api/workspaces/<slug>/wiki/pages/<pageId>/...`.
 */
export class WorkspacePageService extends PageService {
  protected basePath: string;

  constructor(params: WorkspacePageServiceParams) {
    super();
    const { workspaceSlug } = params;
    if (!workspaceSlug) throw new AppError("Missing required fields.");
    // validate cookie
    if (!params.cookie) throw new AppError("Cookie is required.");
    // set cookie
    this.setHeader("Cookie", params.cookie);
    // set base path
    this.basePath = `/api/workspaces/${workspaceSlug}/wiki`;
  }

  /**
   * Server-side fetches (e.g. title sync) must not be recorded as a user visit.
   */
  async fetchDetails(pageId: string): Promise<TPage> {
    try {
      const response = await this.get(`${this.basePath}/pages/${pageId}/`, {
        headers: this.getHeader(),
        params: { track_visit: false },
      });
      return response?.data as TPage;
    } catch (error) {
      const appError = new AppError(error, {
        context: { operation: "fetchDetails", pageId },
      });
      logger.error("Failed to fetch page details", appError);
      throw appError;
    }
  }

  /**
   * Wiki page assets are workspace-level, so always resolve through the project-less asset endpoint.
   */
  async resolveImageAssetUrl(workspaceSlug: string, assetId: string, _projectId?: string | null) {
    return super.resolveImageAssetUrl(workspaceSlug, assetId, null);
  }
}
