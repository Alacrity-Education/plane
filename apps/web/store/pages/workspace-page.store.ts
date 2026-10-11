/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { unset, set } from "lodash-es";
import { makeObservable, observable, runInAction, action, reaction, computed } from "mobx";
import { computedFn } from "mobx-utils";
// plane imports
import { EUserPermissions } from "@plane/constants";
import type { TPage, TPageFilters, TPageNavigationTabs } from "@plane/types";
import { filterPagesByPageType, getPageName, orderPages, shouldFilterPage } from "@plane/utils";
// services
import { WorkspacePageService } from "@/services/page";
// store
import type { CoreRootStore } from "../root.store";
import type { TWorkspacePage } from "./workspace-page";
import { WorkspacePage } from "./workspace-page";

type TLoader = "init-loader" | "mutation-loader" | undefined;

type TError = { title: string; description: string };

export const ROLE_PERMISSIONS_TO_CREATE_WORKSPACE_PAGE = [EUserPermissions.ADMIN, EUserPermissions.MEMBER];

/**
 * @description store for workspace level (wiki) pages.
 * Member names intentionally mirror IProjectPageStore so that shared page components
 * (PagesListRoot, PageListBlock, DeletePageModal, useRealtimePageEvents, ...) work unchanged.
 */
export interface IWorkspacePageStore {
  // observables
  loader: TLoader;
  data: Record<string, TWorkspacePage>; // pageId => Page
  error: TError | undefined;
  filters: TPageFilters;
  // computed
  isAnyPageAvailable: boolean;
  canCurrentUserCreatePage: boolean;
  // helper actions
  getCurrentProjectPageIdsByTab: (pageType: TPageNavigationTabs) => string[] | undefined;
  getCurrentProjectFilteredPageIdsByTab: (pageType: TPageNavigationTabs) => string[] | undefined;
  getCurrentWorkspacePageIds: () => string[];
  getPageById: (pageId: string) => TWorkspacePage | undefined;
  updateFilters: <T extends keyof TPageFilters>(filterKey: T, filterValue: TPageFilters[T]) => void;
  clearAllFilters: () => void;
  // actions
  fetchPagesList: (workspaceSlug: string, pageType?: TPageNavigationTabs) => Promise<TPage[] | undefined>;
  fetchPageDetails: (
    workspaceSlug: string,
    pageId: string,
    options?: { trackVisit?: boolean }
  ) => Promise<TPage | undefined>;
  createPage: (pageData: Partial<TPage>) => Promise<TPage | undefined>;
  removePage: (params: { pageId: string; shouldSync?: boolean }) => Promise<void>;
}

export class WorkspacePageStore implements IWorkspacePageStore {
  // observables
  loader: TLoader = "init-loader";
  data: Record<string, TWorkspacePage> = {}; // pageId => Page
  error: TError | undefined = undefined;
  filters: TPageFilters = {
    searchQuery: "",
    sortKey: "updated_at",
    sortBy: "desc",
  };
  // service
  service: WorkspacePageService;
  rootStore: CoreRootStore;

  constructor(private store: CoreRootStore) {
    makeObservable(this, {
      // observables
      loader: observable.ref,
      data: observable,
      error: observable,
      filters: observable,
      // computed
      isAnyPageAvailable: computed,
      canCurrentUserCreatePage: computed,
      // helper actions
      updateFilters: action,
      clearAllFilters: action,
      // actions
      fetchPagesList: action,
      fetchPageDetails: action,
      createPage: action,
      removePage: action,
    });
    this.rootStore = store;
    // service
    this.service = new WorkspacePageService();
    // page instances capture the workspace slug, reset everything when the workspace changes
    reaction(
      () => this.store.router.workspaceSlug,
      (workspaceSlug, previousWorkspaceSlug) => {
        if (!workspaceSlug || !previousWorkspaceSlug || workspaceSlug === previousWorkspaceSlug) return;
        runInAction(() => {
          Object.values(this.data).forEach((page) => page.cleanup());
          this.data = {};
          this.loader = "init-loader";
          this.error = undefined;
          this.filters.searchQuery = "";
          set(this.filters, ["filters"], {});
        });
      }
    );
  }

  /**
   * @description returns the pages that belong to the current workspace
   */
  private getCurrentWorkspacePages = computedFn((): TWorkspacePage[] => {
    const currentWorkspaceId = this.store.workspaceRoot.currentWorkspace?.id;
    if (!currentWorkspaceId) return [];
    return Object.values(this.data ?? {}).filter((page) => page.workspace === currentWorkspaceId);
  });

  /**
   * @description check if any page is available
   */
  get isAnyPageAvailable() {
    if (this.loader) return true;
    return this.getCurrentWorkspacePages().length > 0;
  }

  /**
   * @description returns true if the current logged in user can create a page
   */
  get canCurrentUserCreatePage() {
    const { workspaceSlug } = this.store.router;
    const currentUserWorkspaceRole = this.store.user.permission.getWorkspaceRoleByWorkspaceSlug(
      workspaceSlug?.toString() || ""
    ) as EUserPermissions | undefined;
    return !!currentUserWorkspaceRole && ROLE_PERMISSIONS_TO_CREATE_WORKSPACE_PAGE.includes(currentUserWorkspaceRole);
  }

  /**
   * @description get the current workspace page ids based on the pageType
   * Note: name kept for compatibility with the shared page components
   * @param {TPageNavigationTabs} pageType
   */
  getCurrentProjectPageIdsByTab = computedFn((pageType: TPageNavigationTabs) => {
    const { workspaceSlug } = this.store.router;
    if (!workspaceSlug) return undefined;
    const pagesByType = filterPagesByPageType(pageType, this.getCurrentWorkspacePages());
    return pagesByType.map((page) => page.id).filter((id): id is string => !!id);
  });

  /**
   * @description get the current workspace page ids
   */
  getCurrentWorkspacePageIds = computedFn(() =>
    this.getCurrentWorkspacePages()
      .map((page) => page.id)
      .filter((id): id is string => !!id)
  );

  /**
   * @description get the current workspace filtered page ids based on the pageType
   * Note: name kept for compatibility with the shared page components
   * @param {TPageNavigationTabs} pageType
   */
  getCurrentProjectFilteredPageIdsByTab = computedFn((pageType: TPageNavigationTabs) => {
    const { workspaceSlug } = this.store.router;
    if (!workspaceSlug) return undefined;

    const pagesByType = filterPagesByPageType(pageType, this.getCurrentWorkspacePages());
    let filteredPages = pagesByType.filter(
      (p) =>
        getPageName(p.name).toLowerCase().includes(this.filters.searchQuery.toLowerCase()) &&
        shouldFilterPage(p, this.filters.filters)
    );
    filteredPages = orderPages(filteredPages, this.filters.sortKey, this.filters.sortBy);

    return filteredPages.map((page) => page.id).filter((id): id is string => !!id);
  });

  /**
   * @description get the page store by id
   * @param {string} pageId
   */
  getPageById = computedFn((pageId: string) => this.data?.[pageId] || undefined);

  updateFilters = <T extends keyof TPageFilters>(filterKey: T, filterValue: TPageFilters[T]) => {
    runInAction(() => {
      set(this.filters, [filterKey], filterValue);
    });
  };

  /**
   * @description clear all the filters
   */
  clearAllFilters = () =>
    runInAction(() => {
      set(this.filters, ["filters"], {});
    });

  /**
   * @description fetch all the pages of the workspace wiki
   * @param {string} workspaceSlug
   * @param {TPageNavigationTabs} pageType
   */
  fetchPagesList = async (workspaceSlug: string, pageType?: TPageNavigationTabs) => {
    try {
      if (!workspaceSlug) return undefined;

      const currentPageIds = pageType ? this.getCurrentProjectPageIdsByTab(pageType) : undefined;
      runInAction(() => {
        this.loader = currentPageIds && currentPageIds.length > 0 ? `mutation-loader` : `init-loader`;
        this.error = undefined;
      });

      const pages = await this.service.fetchAll(workspaceSlug, pageType ? { type: pageType } : undefined);
      runInAction(() => {
        for (const page of pages) {
          if (page?.id) {
            const existingPage = this.getPageById(page.id);
            if (existingPage) {
              // If page already exists, update all fields except name
              const { name: _name, ...otherFields } = page;
              existingPage.mutateProperties(otherFields, false);
            } else {
              // If new page, create a new instance with all data
              set(this.data, [page.id], new WorkspacePage(this.store, page));
            }
          }
        }
        this.loader = undefined;
      });

      return pages;
    } catch (error) {
      runInAction(() => {
        this.loader = undefined;
        this.error = {
          title: "Failed",
          description: "Failed to fetch the pages, Please try again later.",
        };
      });
      throw error;
    }
  };

  /**
   * @description fetch the details of a page
   * @param {string} workspaceSlug
   * @param {string} pageId
   */
  fetchPageDetails = async (...args: Parameters<IWorkspacePageStore["fetchPageDetails"]>) => {
    const [workspaceSlug, pageId, options] = args;
    const { trackVisit } = options || {};
    try {
      if (!workspaceSlug || !pageId) return undefined;

      const currentPage = this.getPageById(pageId);
      runInAction(() => {
        this.loader = currentPage ? `mutation-loader` : `init-loader`;
        this.error = undefined;
      });

      const page = await this.service.fetchById(workspaceSlug, pageId, trackVisit ?? true);

      runInAction(() => {
        if (page?.id) {
          const pageInstance = this.getPageById(page.id);
          if (pageInstance) {
            pageInstance.mutateProperties(page, false);
          } else {
            set(this.data, [page.id], new WorkspacePage(this.store, page));
          }
        }
        this.loader = undefined;
      });

      return page;
    } catch (error) {
      runInAction(() => {
        this.loader = undefined;
        this.error = {
          title: "Failed",
          description: "Failed to fetch the page, Please try again later.",
        };
      });
      throw error;
    }
  };

  /**
   * @description create a page
   * @param {Partial<TPage>} pageData
   */
  createPage = async (pageData: Partial<TPage>) => {
    try {
      const { workspaceSlug } = this.store.router;
      if (!workspaceSlug) return undefined;

      runInAction(() => {
        this.loader = "mutation-loader";
        this.error = undefined;
      });

      const page = await this.service.create(workspaceSlug, pageData);
      runInAction(() => {
        if (page?.id) set(this.data, [page.id], new WorkspacePage(this.store, page));
        this.loader = undefined;
      });

      return page;
    } catch (error) {
      runInAction(() => {
        this.loader = undefined;
        this.error = {
          title: "Failed",
          description: "Failed to create a page, Please try again later.",
        };
      });
      throw error;
    }
  };

  /**
   * @description delete a page
   * @param {string} pageId
   * @param {boolean} shouldSync - when false the page is only removed from the store (e.g. realtime delete event)
   */
  removePage = async ({ pageId, shouldSync = true }: { pageId: string; shouldSync?: boolean }) => {
    try {
      const { workspaceSlug } = this.store.router;
      if (!workspaceSlug || !pageId) return undefined;

      if (shouldSync) await this.service.remove(workspaceSlug, pageId);
      runInAction(() => {
        this.data[pageId]?.cleanup();
        unset(this.data, [pageId]);
        if (this.rootStore.favorite.entityMap[pageId]) this.rootStore.favorite.removeFavoriteFromStore(pageId);
      });
    } catch (error) {
      runInAction(() => {
        this.loader = undefined;
        this.error = {
          title: "Failed",
          description: "Failed to delete a page, Please try again later.",
        };
      });
      throw error;
    }
  };
}
