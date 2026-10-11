/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import type { TPageNavigationTabs } from "@plane/types";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// local imports
import { WikiListHeaderRoot } from "./wiki-list-header-root";
import { WikiListMainContent } from "./wiki-list-main-content";

type TWikiListView = {
  children: React.ReactNode;
  pageType: TPageNavigationTabs;
  workspaceSlug: string;
};

export const WikiListView = observer(function WikiListView(props: TWikiListView) {
  const { children, pageType, workspaceSlug } = props;
  // store hooks
  const { isAnyPageAvailable, fetchPagesList } = usePageStore(EPageStoreType.WORKSPACE);
  // fetching pages list
  useSWR(
    workspaceSlug && pageType ? `WORKSPACE_WIKI_PAGES_${workspaceSlug}_${pageType}` : null,
    workspaceSlug && pageType ? () => fetchPagesList(workspaceSlug, pageType) : null
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* tab header */}
      {isAnyPageAvailable && <WikiListHeaderRoot pageType={pageType} workspaceSlug={workspaceSlug} />}
      <WikiListMainContent pageType={pageType} workspaceSlug={workspaceSlug}>
        {children}
      </WikiListMainContent>
    </div>
  );
});
