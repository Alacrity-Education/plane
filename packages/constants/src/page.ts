/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export enum EPageAccess {
  PUBLIC = 0,
  PRIVATE = 1,
  // workspace wiki pages only: visible to workspace admins and the page owner
  ADMIN = 2,
  // workspace wiki pages only: visible to workspace admins and members (not guests) and the page owner
  MEMBERS = 3,
}

export type TCreatePageModal = {
  isOpen: boolean;
  pageAccess?: EPageAccess;
};

export const DEFAULT_CREATE_PAGE_MODAL_DATA: TCreatePageModal = {
  isOpen: false,
  pageAccess: EPageAccess.PUBLIC,
};
