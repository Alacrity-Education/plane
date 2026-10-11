/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { API_BASE_URL } from "@plane/constants";
import type { TDocumentPayload, TPage, TPageNavigationTabs, TProjectWikiSection } from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export type TWorkspacePagesSummary = {
  public_pages: number;
  private_pages: number;
  archived_pages: number;
};

export type TWorkspacePageListParams = {
  type?: TPageNavigationTabs;
  parent?: string | null;
  order_by?: string;
};

/**
 * @description service for workspace level (wiki) pages, served under /api/workspaces/:workspaceSlug/wiki/
 */
export class WorkspacePageService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private getBasePath(workspaceSlug: string) {
    return `/api/workspaces/${workspaceSlug}/wiki`;
  }

  async fetchSummary(workspaceSlug: string): Promise<TWorkspacePagesSummary> {
    return this.get(`${this.getBasePath(workspaceSlug)}/pages-summary/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async fetchAll(workspaceSlug: string, params?: TWorkspacePageListParams): Promise<TPage[]> {
    const queryParams: Record<string, string> = {};
    if (params?.type) queryParams.type = params.type;
    if (params?.parent !== undefined) queryParams.parent = params.parent === null ? "null" : params.parent;
    if (params?.order_by) queryParams.order_by = params.order_by;

    return this.get(`${this.getBasePath(workspaceSlug)}/pages/`, { params: queryParams })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async fetchById(workspaceSlug: string, pageId: string, trackVisit: boolean): Promise<TPage> {
    return this.get(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/`, {
      params: {
        track_visit: trackVisit,
      },
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async create(workspaceSlug: string, data: Partial<TPage>): Promise<TPage> {
    return this.post(`${this.getBasePath(workspaceSlug)}/pages/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async update(workspaceSlug: string, pageId: string, data: Partial<TPage>): Promise<TPage> {
    return this.patch(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateAccess(workspaceSlug: string, pageId: string, data: Pick<TPage, "access">): Promise<void> {
    return this.post(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/access/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async remove(workspaceSlug: string, pageId: string): Promise<void> {
    return this.delete(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async archive(
    workspaceSlug: string,
    pageId: string
  ): Promise<{
    archived_at: string;
  }> {
    return this.post(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/archive/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async restore(workspaceSlug: string, pageId: string): Promise<void> {
    return this.delete(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/archive/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async lock(workspaceSlug: string, pageId: string): Promise<void> {
    return this.post(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/lock/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async unlock(workspaceSlug: string, pageId: string): Promise<void> {
    return this.delete(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/lock/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async fetchDescriptionBinary(workspaceSlug: string, pageId: string): Promise<ArrayBuffer> {
    return this.get(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/description/`, {
      headers: {
        "Content-Type": "application/octet-stream",
      },
      responseType: "arraybuffer",
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateDescription(workspaceSlug: string, pageId: string, data: TDocumentPayload): Promise<void> {
    return this.patch(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/description/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error;
      });
  }

  async duplicate(workspaceSlug: string, pageId: string): Promise<TPage> {
    return this.post(`${this.getBasePath(workspaceSlug)}/pages/${pageId}/duplicate/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  private getProjectWikiPath(workspaceSlug: string, projectId: string) {
    return `/api/workspaces/${workspaceSlug}/projects/${projectId}/wiki/`;
  }

  /**
   * @description fetch the wiki section of a project, null when the project has no section (404)
   */
  async fetchProjectWikiSection(workspaceSlug: string, projectId: string): Promise<TProjectWikiSection | null> {
    return this.get(this.getProjectWikiPath(workspaceSlug, projectId))
      .then((response) => response?.data ?? null)
      .catch((error) => {
        if (error?.response?.status === 404) return null;
        throw error?.response?.data;
      });
  }

  /**
   * @description create the wiki section of a project (a top level wiki page named after the project)
   */
  async createProjectWikiSection(workspaceSlug: string, projectId: string): Promise<TProjectWikiSection> {
    return this.post(this.getProjectWikiPath(workspaceSlug, projectId))
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /**
   * @description unlink the wiki section of a project, its pages are kept
   */
  async removeProjectWikiSection(workspaceSlug: string, projectId: string): Promise<void> {
    return this.delete(this.getProjectWikiPath(workspaceSlug, projectId))
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}
