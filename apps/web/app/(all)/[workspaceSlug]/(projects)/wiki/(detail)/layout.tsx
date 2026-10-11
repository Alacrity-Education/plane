/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Outlet } from "react-router";
import useSWR from "swr";
// components
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// local components
import type { Route } from "./+types/layout";
import { WikiPageDetailsHeader } from "./header";

export default function WikiPageDetailsLayout({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { fetchPagesList } = usePageStore(EPageStoreType.WORKSPACE);
  // fetching pages list, used by the page switcher in the header
  useSWR(workspaceSlug ? `WORKSPACE_WIKI_PAGES_${workspaceSlug}` : null, () => fetchPagesList(workspaceSlug));
  return (
    <>
      <AppHeader header={<WikiPageDetailsHeader />} />
      <ContentWrapper>
        <Outlet />
      </ContentWrapper>
    </>
  );
}
