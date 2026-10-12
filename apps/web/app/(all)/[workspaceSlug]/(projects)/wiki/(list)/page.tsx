/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TPageNavigationTabs } from "@plane/types";
// components
import { PageHead } from "@/components/core/page-title";
import { WikiListView } from "@/components/wiki/wiki-list-view";
import { WikiTree } from "@/components/wiki/wiki-tree";
import type { Route } from "./+types/page";

const getWikiPageType = (pageType?: string | null): TPageNavigationTabs => {
  if (pageType === "public") return "public";
  if (pageType === "private") return "private";
  if (pageType === "admins") return "admins";
  if (pageType === "members") return "members";
  if (pageType === "archived") return "archived";
  return "all";
};

function WikiPagesPage({ params }: Route.ComponentProps) {
  // router
  const searchParams = useSearchParams();
  const type = searchParams.get("type");
  const { workspaceSlug } = params;
  // plane hooks
  const { t } = useTranslation();
  // derived values
  const pageType = getWikiPageType(type);

  return (
    <>
      <PageHead title={t("sidebar.wiki")} />
      <WikiListView pageType={pageType} workspaceSlug={workspaceSlug}>
        <WikiTree pageType={pageType} workspaceSlug={workspaceSlug} />
      </WikiListView>
    </>
  );
}

export default observer(WikiPagesPage);
