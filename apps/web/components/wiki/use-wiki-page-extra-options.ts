/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { AddPageOutline, MovePageOutline } from "@makeplane/propel/icons";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import type { TPageActionsMenuItem } from "@/components/pages/dropdowns";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";

type TArgs = {
  page: TPageInstance | undefined;
  onAddSubPage: (pageId: string) => void;
  onMove: (pageId: string) => void;
};

/**
 * @description wiki only page actions ("Add sub-page" and "Move"), injected into PageActions via extraOptions
 */
export const useWikiPageExtraOptions = (args: TArgs): TPageActionsMenuItem[] => {
  const { page, onAddSubPage, onMove } = args;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { canCurrentUserCreatePage } = usePageStore(EPageStoreType.WORKSPACE);
  // derived values
  const pageId = page?.id;
  const isArchived = !!page?.archived_at;
  const isLocked = !!page?.is_locked;
  // the root page of a project wiki section always stays at the top level
  const isProjectWikiRoot = !!page?.project_wiki;
  const canCurrentUserMovePage = !!page?.canCurrentUserMovePage;

  return useMemo(
    (): TPageActionsMenuItem[] => [
      {
        key: "add-sub-page",
        action: () => {
          if (pageId) onAddSubPage(pageId);
        },
        title: t("wiki.pages.actions.add_sub_page"),
        icon: AddPageOutline,
        shouldRender: !!pageId && canCurrentUserCreatePage && !isArchived,
      },
      {
        key: "move",
        action: () => {
          if (pageId) onMove(pageId);
        },
        title: t("page_actions.move_page.submit_button.default"),
        description: isProjectWikiRoot
          ? t("wiki.project_section.move_disabled")
          : isLocked
            ? t("wiki.pages.move_modal.locked")
            : undefined,
        icon: MovePageOutline,
        disabled: isLocked || isProjectWikiRoot,
        shouldRender: !!pageId && canCurrentUserMovePage && !isArchived,
      },
    ],
    [
      pageId,
      canCurrentUserCreatePage,
      canCurrentUserMovePage,
      isArchived,
      isLocked,
      isProjectWikiRoot,
      onAddSubPage,
      onMove,
      t,
    ]
  );
};
