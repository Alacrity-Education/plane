/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { AddPageOutline, GlobeOutline, LogOutOutline, MovePageOutline, ProjectsOutline } from "@makeplane/propel/icons";
// plane imports
import { setToast } from "@plane/blocks/toast";
import { EPageAccess } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// components
import type { TPageActionsMenuItem } from "@/components/pages/dropdowns";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";
import type { TWorkspacePage } from "@/store/pages/workspace-page";

type TArgs = {
  page: TPageInstance | undefined;
  onAddSubPage: (pageId: string) => void;
  onMove: (pageId: string) => void;
  onMoveToProject: (pageId: string) => void;
};

/**
 * @description wiki only page actions ("Add sub-page", "Move", the project wiki moves and docs site publishing),
 * injected into PageActions via extraOptions
 */
export const useWikiPageExtraOptions = (args: TArgs): TPageActionsMenuItem[] => {
  const { page, onAddSubPage, onMove, onMoveToProject } = args;
  // router
  const { workspaceSlug } = useParams();
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { canCurrentUserCreatePage, getProjectWikiRootForPage, movePage, publishPage, unpublishPage } = usePageStore(
    EPageStoreType.WORKSPACE
  );
  // derived values
  const pageId = page?.id;
  const isArchived = !!page?.archived_at;
  const isLocked = !!page?.is_locked;
  // the root page of a project wiki section always stays at the top level
  const isProjectWikiRoot = !!page?.project_wiki;
  // root page of the project wiki section the page is nested in (null when it is not inside a section)
  const projectWikiRootId = pageId && !isProjectWikiRoot ? getProjectWikiRootForPage(pageId) : null;
  const isInsideProjectWiki = !!projectWikiRootId;
  const canCurrentUserMovePage = !!page?.canCurrentUserMovePage;
  // docs site publishing (only workspace pages carry the publish permission)
  const canCurrentUserPublishPage = !!(page as TWorkspacePage | undefined)?.canCurrentUserPublishPage;
  const isPublished = !!page?.is_published;
  const isPrivate = page?.access === EPageAccess.PRIVATE;

  // moving a page out of a project wiki section makes it a top level page (with its own sub-pages)
  const handleMoveOutOfProjectWiki = useCallback(async () => {
    if (!pageId || !workspaceSlug) return;
    try {
      await movePage(workspaceSlug.toString(), pageId, null);
      setToast({
        type: "success",
        title: t("toast.success"),
        message: t("wiki.project_section.move_out.success"),
      });
    } catch (error) {
      setToast({
        type: "error",
        title: t("toast.error"),
        message: (error as { error?: string } | undefined)?.error || t("wiki.project_section.move_out.error"),
      });
    }
  }, [pageId, workspaceSlug, movePage, t]);

  const handleTogglePublish = useCallback(async () => {
    if (!pageId) return;
    try {
      if (isPublished) await unpublishPage(pageId);
      else await publishPage(pageId);
      setToast({
        type: "success",
        title: t("toast.success"),
        message: t(isPublished ? "wiki.publish.unpublish_success" : "wiki.publish.success"),
      });
    } catch (error) {
      setToast({
        type: "error",
        title: t("toast.error"),
        message:
          (error as { error?: string } | undefined)?.error ||
          t(isPublished ? "wiki.publish.unpublish_error" : "wiki.publish.error"),
      });
    }
  }, [pageId, isPublished, publishPage, unpublishPage, t]);

  // a published page can always be unpublished, publishing needs a public, active page
  const publishDisabledReason = isPublished
    ? undefined
    : isArchived
      ? t("wiki.publish.disabled_archived")
      : isPrivate
        ? t("wiki.publish.disabled_private")
        : undefined;

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
      {
        key: "move-to-project-wiki",
        action: () => {
          if (pageId) onMoveToProject(pageId);
        },
        title: t("wiki.project_section.move_to_project.title"),
        description: isLocked ? t("wiki.pages.move_modal.locked") : undefined,
        icon: ProjectsOutline,
        disabled: isLocked,
        shouldRender: !!pageId && canCurrentUserMovePage && !isArchived && !isProjectWikiRoot && !isInsideProjectWiki,
      },
      {
        key: "move-out-of-project-wiki",
        action: () => {
          void handleMoveOutOfProjectWiki();
        },
        title: t("wiki.project_section.move_out.label"),
        description: isLocked ? t("wiki.pages.move_modal.locked") : undefined,
        icon: LogOutOutline,
        disabled: isLocked,
        shouldRender: !!pageId && canCurrentUserMovePage && !isArchived && isInsideProjectWiki,
      },
      {
        key: "publish",
        action: () => {
          void handleTogglePublish();
        },
        title: t(isPublished ? "wiki.publish.unpublish_action" : "wiki.publish.action"),
        description: publishDisabledReason,
        icon: GlobeOutline,
        disabled: !!publishDisabledReason,
        shouldRender: !!pageId && canCurrentUserPublishPage,
      },
    ],
    [
      pageId,
      canCurrentUserCreatePage,
      canCurrentUserMovePage,
      isArchived,
      isLocked,
      isProjectWikiRoot,
      isInsideProjectWiki,
      onAddSubPage,
      onMove,
      onMoveToProject,
      handleMoveOutOfProjectWiki,
      canCurrentUserPublishPage,
      isPublished,
      publishDisabledReason,
      handleTogglePublish,
      t,
    ]
  );
};
