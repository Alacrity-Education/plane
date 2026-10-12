/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, computed, makeObservable, runInAction } from "mobx";
import { computedFn } from "mobx-utils";
// plane imports
import { EPageAccess, EUserPermissions } from "@plane/constants";
import type { TPage } from "@plane/types";
// plane web store
import type { RootStore } from "@/store/root.store";
// services
import { WorkspacePageService } from "@/services/page";
// store
import { BasePage } from "./base-page";
import type { TPageInstance } from "./base-page";

const workspacePageService = new WorkspacePageService();

// wiki only access levels between public and private
export type TWikiRestrictedAccess = EPageAccess.ADMIN | EPageAccess.MEMBERS;

export type TWorkspacePage = TPageInstance & {
  canCurrentUserPublishPage: boolean;
  canCurrentUserSetRestrictedAccess: boolean;
  setRestrictedAccess: (access: TWikiRestrictedAccess) => Promise<void>;
};

/**
 * @description workspace level (wiki) page, permissions are derived from the workspace role
 */
export class WorkspacePage extends BasePage implements TWorkspacePage {
  constructor(store: RootStore, page: TPage) {
    // required fields for API calls
    const { workspaceSlug } = store.router;
    // initialize base instance
    super(store, page, {
      update: async (payload) => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        return await workspacePageService.update(workspaceSlug, page.id, payload);
      },
      updateDescription: async (document) => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        await workspacePageService.updateDescription(workspaceSlug, page.id, document);
      },
      updateAccess: async (payload) => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        await workspacePageService.updateAccess(workspaceSlug, page.id, payload);
        // the server unpublishes pages that are no longer public
        if (payload.access !== EPageAccess.PUBLIC) {
          store.workspacePages.getPageById(page.id)?.mutateProperties({ is_published: false });
        }
      },
      lock: async () => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        await workspacePageService.lock(workspaceSlug, page.id);
      },
      unlock: async () => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        await workspacePageService.unlock(workspaceSlug, page.id);
      },
      archive: async () => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        const response = await workspacePageService.archive(workspaceSlug, page.id);
        // the server archives (and unpublishes) the descendants as well
        store.workspacePages.setDescendantsArchivedAt(page.id, response.archived_at);
        [page.id, ...store.workspacePages.getDescendantIds(page.id)].forEach((id) =>
          store.workspacePages.getPageById(id)?.mutateProperties({ is_published: false })
        );
        return response;
      },
      restore: async () => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        await workspacePageService.restore(workspaceSlug, page.id);
        // the server restores the descendants as well
        store.workspacePages.setDescendantsArchivedAt(page.id, null);
      },
      duplicate: async () => {
        if (!workspaceSlug || !page.id) throw new Error("Missing required fields.");
        return await workspacePageService.duplicate(workspaceSlug, page.id);
      },
    });
    makeObservable(this, {
      // computed
      canCurrentUserAccessPage: computed,
      canCurrentUserEditPage: computed,
      canCurrentUserDuplicatePage: computed,
      canCurrentUserLockPage: computed,
      canCurrentUserChangeAccess: computed,
      canCurrentUserArchivePage: computed,
      canCurrentUserDeletePage: computed,
      canCurrentUserFavoritePage: computed,
      canCurrentUserMovePage: computed,
      canCurrentUserPublishPage: computed,
      canCurrentUserSetRestrictedAccess: computed,
      isContentEditable: computed,
      // actions
      setRestrictedAccess: action,
    });
  }

  /**
   * @description returns the current user's role in the current workspace
   */
  private getWorkspaceRole = computedFn((): EUserPermissions | undefined => {
    const { workspaceSlug } = this.rootStore.router;
    if (!workspaceSlug) return undefined;
    const role = this.rootStore.user.permission.getWorkspaceRoleByWorkspaceSlug(workspaceSlug.toString());
    return role as EUserPermissions | undefined;
  });

  private get isWorkspaceAdmin() {
    return this.getWorkspaceRole() === EUserPermissions.ADMIN;
  }

  private get isAtLeastWorkspaceMember() {
    const role = this.getWorkspaceRole();
    return !!role && role >= EUserPermissions.MEMBER;
  }

  /**
   * @description true when the access of the page lets the current user see it (mirrors the API visibility rule):
   * public pages and own pages for everyone, members-only pages for workspace admins and members, admins-only pages
   * for workspace admins
   */
  private get isVisibleToCurrentUser() {
    if (this.access === EPageAccess.PUBLIC || this.isCurrentUserOwner) return true;
    if (this.access === EPageAccess.MEMBERS) return this.isAtLeastWorkspaceMember;
    return this.access === EPageAccess.ADMIN && this.isWorkspaceAdmin;
  }

  private get isRestrictedAccess() {
    return this.access === EPageAccess.ADMIN || this.access === EPageAccess.MEMBERS;
  }

  /**
   * @description returns true if the current logged in user can access the page
   */
  get canCurrentUserAccessPage() {
    return this.isVisibleToCurrentUser;
  }

  /**
   * @description returns true if the current logged in user can edit the page
   */
  get canCurrentUserEditPage() {
    // guests are always read-only in the wiki, even on pages they own
    if (!this.isAtLeastWorkspaceMember) return false;
    return this.isVisibleToCurrentUser;
  }

  /**
   * @description returns true if the current logged in user can create a duplicate the page
   */
  get canCurrentUserDuplicatePage() {
    return this.isAtLeastWorkspaceMember;
  }

  /**
   * @description returns true if the current logged in user can lock the page
   */
  get canCurrentUserLockPage() {
    return this.isCurrentUserOwner || this.isWorkspaceAdmin;
  }

  /**
   * @description returns true if the current logged in user can toggle the page between public and private
   * (the owner), or make an admins-only / members-only page public (the owner and workspace admins)
   */
  get canCurrentUserChangeAccess() {
    if (!this.isAtLeastWorkspaceMember) return false;
    return this.isCurrentUserOwner || (this.isRestrictedAccess && this.isWorkspaceAdmin);
  }

  /**
   * @description returns true if the current logged in user can make the page admins-only or members-only
   * (workspace admins, and the owner when they are a workspace member or admin)
   */
  get canCurrentUserSetRestrictedAccess() {
    if (!this.isAtLeastWorkspaceMember) return false;
    return this.isCurrentUserOwner || this.isWorkspaceAdmin;
  }

  /**
   * @description returns true if the current logged in user can archive the page
   */
  get canCurrentUserArchivePage() {
    return this.isCurrentUserOwner || this.isWorkspaceAdmin;
  }

  /**
   * @description returns true if the current logged in user can delete the page
   */
  get canCurrentUserDeletePage() {
    return this.isCurrentUserOwner || this.isWorkspaceAdmin;
  }

  /**
   * @description returns true if the current logged in user can favorite the page
   */
  get canCurrentUserFavoritePage() {
    return this.isAtLeastWorkspaceMember;
  }

  /**
   * @description returns true if the current logged in user can move (re-parent) the page
   */
  get canCurrentUserMovePage() {
    return this.isAtLeastWorkspaceMember && (this.isCurrentUserOwner || this.isWorkspaceAdmin);
  }

  /**
   * @description returns true if the current logged in user can publish the page to the docs site
   * (workspace admins and members, guests never)
   */
  get canCurrentUserPublishPage() {
    return this.isAtLeastWorkspaceMember;
  }

  /**
   * @description returns true if the page can be edited
   */
  get isContentEditable() {
    const isArchived = this.archived_at;
    const isLocked = this.is_locked;

    // guests are always read-only in the wiki, even on pages they own
    return !isArchived && !isLocked && this.isAtLeastWorkspaceMember && this.isVisibleToCurrentUser;
  }

  /**
   * @description make the page admins-only or members-only (the server unpublishes it)
   */
  setRestrictedAccess = async (access: TWikiRestrictedAccess) => {
    const previousAccess = this.access;
    runInAction(() => {
      this.access = access;
    });
    try {
      await this.services.updateAccess({ access });
    } catch (error) {
      runInAction(() => {
        this.access = previousAccess;
      });
      throw error;
    }
  };

  getRedirectionLink = computedFn(() => {
    const { workspaceSlug } = this.rootStore.router;
    return `/${workspaceSlug}/wiki/${this.id}`;
  });
}
