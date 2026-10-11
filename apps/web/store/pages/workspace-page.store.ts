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

// sort_order used for the first page under a parent and the gap kept between appended siblings
// (mirrors DEFAULT_SORT_ORDER / SORT_ORDER_STEP of @plane/wiki-sync)
const DEFAULT_WIKI_SORT_ORDER = 65535;
const WIKI_SORT_ORDER_STEP = 10000;

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
  // tree helpers
  getRootPageIds: (pageType: TPageNavigationTabs) => string[];
  getChildPageIds: (pageId: string, pageType: TPageNavigationTabs) => string[];
  getAncestorIds: (pageId: string) => string[];
  getDescendantIds: (pageId: string) => string[];
  getNextChildSortOrder: (parentId: string | null, excludePageId?: string) => number;
  setDescendantsArchivedAt: (pageId: string, archivedAt: string | null) => void;
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
  movePage: (workspaceSlug: string, pageId: string, parentId: string | null, sortOrder?: number) => Promise<void>;
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
      movePage: action,
      setDescendantsArchivedAt: action,
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

  /**
   * @description returns the current workspace pages of a tab, ordered by the current sort filters
   * @param {TPageNavigationTabs} pageType
   */
  private getOrderedPagesByTab = computedFn((pageType: TPageNavigationTabs) =>
    orderPages(
      filterPagesByPageType(pageType, this.getCurrentWorkspacePages()),
      this.filters.sortKey,
      this.filters.sortBy
    )
  );

  /**
   * @description get the ids of the tree roots of a tab: pages without a parent, or whose parent is not visible in the tab
   * @param {TPageNavigationTabs} pageType
   */
  getRootPageIds = computedFn((pageType: TPageNavigationTabs) => {
    const pages = this.getOrderedPagesByTab(pageType);
    const visiblePageIds = new Set(pages.map((page) => page.id));
    return pages
      .filter((page) => !page.parent || !visiblePageIds.has(page.parent))
      .map((page) => page.id)
      .filter((id): id is string => !!id);
  });

  /**
   * @description get the ids of the direct children of a page that are visible in a tab
   * @param {string} pageId
   * @param {TPageNavigationTabs} pageType
   */
  getChildPageIds = computedFn((pageId: string, pageType: TPageNavigationTabs) =>
    this.getOrderedPagesByTab(pageType)
      .filter((page) => page.parent === pageId)
      .map((page) => page.id)
      .filter((id): id is string => !!id)
  );

  /**
   * @description get the ids of the loaded ancestors of a page, root first
   * @param {string} pageId
   */
  getAncestorIds = computedFn((pageId: string) => {
    const ancestorIds: string[] = [];
    const visitedIds = new Set<string>([pageId]);
    let parentId = this.getPageById(pageId)?.parent;
    while (parentId && !visitedIds.has(parentId)) {
      const parentPage = this.getPageById(parentId);
      if (!parentPage) break;
      visitedIds.add(parentId);
      ancestorIds.unshift(parentId);
      parentId = parentPage.parent;
    }
    return ancestorIds;
  });

  /**
   * @description get the ids of all the loaded descendants of a page (archived ones included)
   * @param {string} pageId
   */
  getDescendantIds = computedFn((pageId: string) => {
    const pages = this.getCurrentWorkspacePages();
    const descendantIds: string[] = [];
    const visitedIds = new Set<string>([pageId]);
    const queue = [pageId];
    while (queue.length > 0) {
      const currentId = queue.shift();
      for (const page of pages) {
        if (!page.id || page.parent !== currentId || visitedIds.has(page.id)) continue;
        visitedIds.add(page.id);
        descendantIds.push(page.id);
        queue.push(page.id);
      }
    }
    return descendantIds;
  });

  /**
   * @description sort_order that appends a page after the existing (non archived) children of a parent
   * @param {string | null} parentId - null for top level pages
   * @param {string} excludePageId - page being moved, ignored when looking at its future siblings
   */
  getNextChildSortOrder = (parentId: string | null, excludePageId?: string) => {
    const siblingSortOrders = this.getCurrentWorkspacePages()
      .filter((page) => page.id !== excludePageId && !page.archived_at && (page.parent ?? null) === parentId)
      .map((page) => page.sort_order)
      .filter((sortOrder): sortOrder is number => typeof sortOrder === "number" && Number.isFinite(sortOrder));
    if (siblingSortOrders.length === 0) return DEFAULT_WIKI_SORT_ORDER;
    return Math.max(...siblingSortOrders) + WIKI_SORT_ORDER_STEP;
  };

  /**
   * @description archiving/restoring a page cascades to its descendants on the server, mirror it locally
   * @param {string} pageId
   * @param {string | null} archivedAt
   */
  setDescendantsArchivedAt = (pageId: string, archivedAt: string | null) => {
    this.getDescendantIds(pageId).forEach((descendantId) => {
      this.getPageById(descendantId)?.mutateProperties({ archived_at: archivedAt });
    });
  };

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

  /**
   * @description move a page under another page (or to the top level), optimistic with rollback
   * @param {string} workspaceSlug
   * @param {string} pageId
   * @param {string | null} parentId - null moves the page to the top level
   * @param {number} sortOrder - defaults to the end of the new siblings
   */
  movePage = async (workspaceSlug: string, pageId: string, parentId: string | null, sortOrder?: number) => {
    const page = this.getPageById(pageId);
    if (!workspaceSlug || !page) return;

    const previousParentId = page.parent ?? null;
    const previousSortOrder = page.sort_order;
    const nextSortOrder = sortOrder ?? this.getNextChildSortOrder(parentId, pageId);
    const isParentChanged = previousParentId !== parentId;

    const updateSubPagesCount = (targetPageId: string | null, delta: number) => {
      if (!targetPageId) return;
      const targetPage = this.getPageById(targetPageId);
      if (!targetPage) return;
      targetPage.mutateProperties({ sub_pages_count: Math.max(0, (targetPage.sub_pages_count ?? 0) + delta) });
    };

    runInAction(() => {
      page.mutateProperties({ parent: parentId, sort_order: nextSortOrder });
      if (isParentChanged) {
        updateSubPagesCount(previousParentId, -1);
        updateSubPagesCount(parentId, 1);
      }
    });

    try {
      const response = await this.service.update(workspaceSlug, pageId, {
        parent: parentId,
        sort_order: nextSortOrder,
      });
      runInAction(() => {
        if (response)
          page.mutateProperties({
            parent: response.parent ?? null,
            sort_order: response.sort_order ?? nextSortOrder,
          });
      });
    } catch (error) {
      runInAction(() => {
        page.mutateProperties({ parent: previousParentId, sort_order: previousSortOrder });
        if (isParentChanged) {
          updateSubPagesCount(parentId, -1);
          updateSubPagesCount(previousParentId, 1);
        }
      });
      throw error;
    }
  };
}
