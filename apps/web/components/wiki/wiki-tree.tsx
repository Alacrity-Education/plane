/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import { ChevronRightOutline, ProjectsOutline } from "@makeplane/propel/icons";
// plane imports
import { EPageAccess } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TPageNavigationTabs } from "@plane/types";
import { calculateTotalFilters, cn } from "@plane/utils";
// components
import { ListLayout } from "@/components/core/list";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// local imports
import { CreateWikiPageModal } from "./modals/create-wiki-page-modal";
import { MoveWikiPageModal } from "./modals/move-page-modal";
import { MoveToProjectWikiModal } from "./modals/move-to-project-wiki-modal";
import { WikiTreeRow } from "./wiki-tree-row";

const getExpandedStorageKey = (workspaceSlug: string) => `wiki_tree_${workspaceSlug}`;

const readExpandedPageIds = (workspaceSlug: string): string[] => {
  try {
    const storedValue = window.localStorage.getItem(getExpandedStorageKey(workspaceSlug));
    const parsedValue: unknown = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue) ? parsedValue.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const writeExpandedPageIds = (workspaceSlug: string, pageIds: string[]) => {
  try {
    window.localStorage.setItem(getExpandedStorageKey(workspaceSlug), JSON.stringify(pageIds));
  } catch {
    // storage can be unavailable (private mode, quota), the tree then simply forgets its state
  }
};

const getProjectsGroupStorageKey = (workspaceSlug: string) => `wiki_tree_${workspaceSlug}_projects_collapsed`;

const readIsProjectsGroupCollapsed = (workspaceSlug: string): boolean => {
  try {
    return window.localStorage.getItem(getProjectsGroupStorageKey(workspaceSlug)) === "true";
  } catch {
    return false;
  }
};

const writeIsProjectsGroupCollapsed = (workspaceSlug: string, isCollapsed: boolean) => {
  try {
    window.localStorage.setItem(getProjectsGroupStorageKey(workspaceSlug), String(isCollapsed));
  } catch {
    // storage can be unavailable (private mode, quota), the group then simply forgets its state
  }
};

type TWikiProjectsGroupHeaderProps = {
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
};

/**
 * @description header of the virtual "Projects" group that holds the root pages of the project wiki sections
 */
function WikiProjectsGroupHeader(props: TWikiProjectsGroupHeaderProps) {
  const { count, isExpanded, onToggle } = props;
  // plane hooks
  const { t } = useTranslation();

  return (
    <div className="border-b border-subtle bg-layer-transparent" data-testid="wiki-projects-group">
      <button
        type="button"
        className="flex min-h-[44px] w-full items-center gap-1.5 px-page-x text-left text-13 font-medium text-secondary hover:bg-layer-transparent-hover"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={
          isExpanded ? t("wiki.project_section.collapse_projects") : t("wiki.project_section.expand_projects")
        }
        data-testid="wiki-projects-group-toggle"
      >
        <span className="grid size-5 flex-shrink-0 place-items-center text-tertiary">
          <ChevronRightOutline className={cn("size-3.5 transition-transform", { "rotate-90": isExpanded })} />
        </span>
        <ProjectsOutline className="size-4 flex-shrink-0 text-tertiary" />
        <span className="truncate">{t("wiki.project_section.projects")}</span>
        <span className="flex-shrink-0 text-11 text-tertiary">{count}</span>
      </button>
    </div>
  );
}

type TWikiTreeNodeProps = {
  pageId: string;
  depth: number;
  pageType: TPageNavigationTabs;
  expandedPageIds: string[];
  // ancestors of the node, guards against rendering a parent cycle forever
  ancestorIds: string[];
  onToggle: (pageId: string) => void;
  onAddSubPage: (pageId: string) => void;
  onMove: (pageId: string) => void;
  onMoveToProject: (pageId: string) => void;
};

const WikiTreeNode = observer(function WikiTreeNode(props: TWikiTreeNodeProps) {
  const { pageId, depth, pageType, expandedPageIds, ancestorIds, onToggle, onAddSubPage, onMove, onMoveToProject } =
    props;
  // store hooks
  const { getChildPageIds } = usePageStore(EPageStoreType.WORKSPACE);
  // derived values
  const childPageIds = getChildPageIds(pageId, pageType).filter((childId) => !ancestorIds.includes(childId));
  const isExpanded = expandedPageIds.includes(pageId);
  const childAncestorIds = [...ancestorIds, pageId];

  return (
    <>
      <WikiTreeRow
        pageId={pageId}
        depth={depth}
        childCount={childPageIds.length}
        isExpanded={isExpanded}
        onToggle={onToggle}
        onAddSubPage={onAddSubPage}
        onMove={onMove}
        onMoveToProject={onMoveToProject}
      />
      {isExpanded &&
        childPageIds.map((childId) => (
          <WikiTreeNode
            key={childId}
            pageId={childId}
            depth={depth + 1}
            pageType={pageType}
            expandedPageIds={expandedPageIds}
            ancestorIds={childAncestorIds}
            onToggle={onToggle}
            onAddSubPage={onAddSubPage}
            onMove={onMove}
            onMoveToProject={onMoveToProject}
          />
        ))}
    </>
  );
});

type Props = {
  pageType: TPageNavigationTabs;
  workspaceSlug: string;
  // scopes the tree to a single page and its sub-pages (project wiki section), the root is expanded by default
  rootPageId?: string;
};

/**
 * @description wiki home list: a nested tree of pages, or a flat list for the archived tab and while searching/filtering.
 * Project wiki section roots are grouped under a virtual "Projects" group at the top of the tree.
 */
export const WikiTree = observer(function WikiTree(props: Props) {
  const { pageType, workspaceSlug, rootPageId } = props;
  // store hooks
  const { filters, getRootPageIds, getProjectWikiRootPageIds, getChildPageIds, getCurrentProjectFilteredPageIdsByTab } =
    usePageStore(EPageStoreType.WORKSPACE);
  // states
  const [expandedPageIds, setExpandedPageIds] = useState<string[]>(() => readExpandedPageIds(workspaceSlug));
  const [isProjectsGroupCollapsed, setIsProjectsGroupCollapsed] = useState<boolean>(() =>
    readIsProjectsGroupCollapsed(workspaceSlug)
  );
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [movePageId, setMovePageId] = useState<string | undefined>(undefined);
  const [moveToProjectPageId, setMoveToProjectPageId] = useState<string | undefined>(undefined);
  // derived values
  const isScoped = !!rootPageId;
  const isFlatList =
    !isScoped &&
    (pageType === "archived" ||
      filters.searchQuery.trim().length > 0 ||
      calculateTotalFilters(filters.filters ?? {}) > 0);
  const projectRootPageIds = isScoped || isFlatList ? [] : getProjectWikiRootPageIds(pageType);
  const pageIds = isScoped
    ? [rootPageId]
    : isFlatList
      ? (getCurrentProjectFilteredPageIdsByTab(pageType) ?? [])
      : getRootPageIds(pageType).filter((pageId) => !projectRootPageIds.includes(pageId));

  // the expanded state is stored per workspace
  useEffect(() => {
    setExpandedPageIds(readExpandedPageIds(workspaceSlug));
    setIsProjectsGroupCollapsed(readIsProjectsGroupCollapsed(workspaceSlug));
  }, [workspaceSlug]);

  const updateExpandedPageIds = useCallback(
    (updater: (pageIds: string[]) => string[]) => {
      setExpandedPageIds((prev) => {
        const next = updater(prev);
        writeExpandedPageIds(workspaceSlug, next);
        return next;
      });
    },
    [workspaceSlug]
  );

  const expandPage = useCallback(
    (pageId: string | null) => {
      if (!pageId) return;
      updateExpandedPageIds((prev) => (prev.includes(pageId) ? prev : [...prev, pageId]));
    },
    [updateExpandedPageIds]
  );

  // a scoped tree opens on its root page
  useEffect(() => {
    expandPage(rootPageId ?? null);
  }, [rootPageId, expandPage]);

  const handleToggleProjectsGroup = useCallback(() => {
    setIsProjectsGroupCollapsed((prev) => {
      writeIsProjectsGroupCollapsed(workspaceSlug, !prev);
      return !prev;
    });
  }, [workspaceSlug]);

  const handleToggle = useCallback(
    (pageId: string) =>
      updateExpandedPageIds((prev) => (prev.includes(pageId) ? prev.filter((id) => id !== pageId) : [...prev, pageId])),
    [updateExpandedPageIds]
  );

  const handleAddSubPage = useCallback(
    (pageId: string) => {
      // keep the parent open so the new page is visible when coming back to the list
      expandPage(pageId);
      setCreateParentId(pageId);
      setIsCreateModalOpen(true);
    },
    [expandPage]
  );

  const handleMove = useCallback((pageId: string) => setMovePageId(pageId), []);

  const handleMoveToProject = useCallback((pageId: string) => setMoveToProjectPageId(pageId), []);

  return (
    <>
      <CreateWikiPageModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        workspaceSlug={workspaceSlug}
        defaultParentId={createParentId}
        defaultAccess={pageType === "private" ? EPageAccess.PRIVATE : EPageAccess.PUBLIC}
      />
      <MoveWikiPageModal
        isOpen={!!movePageId}
        onClose={() => setMovePageId(undefined)}
        onMoved={expandPage}
        pageId={movePageId}
        workspaceSlug={workspaceSlug}
      />
      <MoveToProjectWikiModal
        isOpen={!!moveToProjectPageId}
        onClose={() => setMoveToProjectPageId(undefined)}
        onMoved={expandPage}
        pageId={moveToProjectPageId}
        workspaceSlug={workspaceSlug}
      />
      <ListLayout>
        {projectRootPageIds.length > 0 && (
          <>
            <WikiProjectsGroupHeader
              count={projectRootPageIds.length}
              isExpanded={!isProjectsGroupCollapsed}
              onToggle={handleToggleProjectsGroup}
            />
            {!isProjectsGroupCollapsed &&
              projectRootPageIds.map((pageId) => (
                <WikiTreeNode
                  key={pageId}
                  pageId={pageId}
                  depth={1}
                  pageType={pageType}
                  expandedPageIds={expandedPageIds}
                  ancestorIds={[]}
                  onToggle={handleToggle}
                  onAddSubPage={handleAddSubPage}
                  onMove={handleMove}
                  onMoveToProject={handleMoveToProject}
                />
              ))}
          </>
        )}
        {isFlatList
          ? pageIds.map((pageId) => (
              <WikiTreeRow
                key={pageId}
                pageId={pageId}
                depth={0}
                childCount={getChildPageIds(pageId, pageType).length}
                onAddSubPage={handleAddSubPage}
                onMove={handleMove}
                onMoveToProject={handleMoveToProject}
              />
            ))
          : pageIds.map((pageId) => (
              <WikiTreeNode
                key={pageId}
                pageId={pageId}
                depth={0}
                pageType={pageType}
                expandedPageIds={expandedPageIds}
                ancestorIds={[]}
                onToggle={handleToggle}
                onAddSubPage={handleAddSubPage}
                onMove={handleMove}
                onMoveToProject={handleMoveToProject}
              />
            ))}
      </ListLayout>
    </>
  );
});
