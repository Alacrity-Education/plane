/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { EPageAccess } from "@plane/constants";
import type { TPageNavigationTabs } from "@plane/types";
import { calculateTotalFilters } from "@plane/utils";
// components
import { ListLayout } from "@/components/core/list";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// local imports
import { CreateWikiPageModal } from "./modals/create-wiki-page-modal";
import { MoveWikiPageModal } from "./modals/move-page-modal";
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
};

const WikiTreeNode = observer(function WikiTreeNode(props: TWikiTreeNodeProps) {
  const { pageId, depth, pageType, expandedPageIds, ancestorIds, onToggle, onAddSubPage, onMove } = props;
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
          />
        ))}
    </>
  );
});

type Props = {
  pageType: TPageNavigationTabs;
  workspaceSlug: string;
};

/**
 * @description wiki home list: a nested tree of pages, or a flat list for the archived tab and while searching/filtering
 */
export const WikiTree = observer(function WikiTree(props: Props) {
  const { pageType, workspaceSlug } = props;
  // store hooks
  const { filters, getRootPageIds, getChildPageIds, getCurrentProjectFilteredPageIdsByTab } = usePageStore(
    EPageStoreType.WORKSPACE
  );
  // states
  const [expandedPageIds, setExpandedPageIds] = useState<string[]>(() => readExpandedPageIds(workspaceSlug));
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [movePageId, setMovePageId] = useState<string | undefined>(undefined);
  // derived values
  const isFlatList =
    pageType === "archived" ||
    filters.searchQuery.trim().length > 0 ||
    calculateTotalFilters(filters.filters ?? {}) > 0;
  const pageIds = isFlatList ? (getCurrentProjectFilteredPageIdsByTab(pageType) ?? []) : getRootPageIds(pageType);

  // the expanded state is stored per workspace
  useEffect(() => {
    setExpandedPageIds(readExpandedPageIds(workspaceSlug));
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
      <ListLayout>
        {isFlatList
          ? pageIds.map((pageId) => (
              <WikiTreeRow
                key={pageId}
                pageId={pageId}
                depth={0}
                childCount={getChildPageIds(pageId, pageType).length}
                onAddSubPage={handleAddSubPage}
                onMove={handleMove}
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
              />
            ))}
      </ListLayout>
    </>
  );
});
