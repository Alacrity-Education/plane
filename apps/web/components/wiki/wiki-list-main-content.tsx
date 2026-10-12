/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
// plane imports
import { useTranslation } from "@plane/i18n";
import { EmptyStateDetailed } from "@plane/blocks/empty-state";
import { setToast } from "@plane/blocks/toast";
import type { TPage, TPageNavigationTabs } from "@plane/types";
// assets
import allDarkAsset from "@/app/assets/empty-state/wiki/all-dark.webp?url";
import allLightAsset from "@/app/assets/empty-state/wiki/all-light.webp?url";
import archivedDarkAsset from "@/app/assets/empty-state/wiki/archived-dark.webp?url";
import archivedLightAsset from "@/app/assets/empty-state/wiki/archived-light.webp?url";
import privateDarkAsset from "@/app/assets/empty-state/wiki/private-dark.webp?url";
import privateLightAsset from "@/app/assets/empty-state/wiki/private-light.webp?url";
import publicDarkAsset from "@/app/assets/empty-state/wiki/public-dark.webp?url";
import publicLightAsset from "@/app/assets/empty-state/wiki/public-light.webp?url";
// components
import { DetailedEmptyState } from "@/components/empty-state/detailed-empty-state-root";
import { PageLoader } from "@/components/pages/loaders/page-loader";
import { getWikiPageAccessForTab } from "@/components/wiki/wiki-tab-navigation";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";

type Props = {
  children: React.ReactNode;
  pageType: TPageNavigationTabs;
  workspaceSlug: string;
};

const WIKI_EMPTY_STATES: Record<
  TPageNavigationTabs,
  { titleKey: string; descriptionKey: string; lightAsset: string; darkAsset: string }
> = {
  all: {
    titleKey: "workspace_empty_state.wiki.title",
    descriptionKey: "wiki.pages.empty_state.all.description",
    lightAsset: allLightAsset,
    darkAsset: allDarkAsset,
  },
  public: {
    titleKey: "wiki.pages.empty_state.public.title",
    descriptionKey: "wiki.pages.empty_state.public.description",
    lightAsset: publicLightAsset,
    darkAsset: publicDarkAsset,
  },
  private: {
    titleKey: "wiki.pages.empty_state.private.title",
    descriptionKey: "wiki.pages.empty_state.private.description",
    lightAsset: privateLightAsset,
    darkAsset: privateDarkAsset,
  },
  members: {
    titleKey: "wiki.pages.empty_state.members.title",
    descriptionKey: "wiki.pages.empty_state.members.description",
    lightAsset: privateLightAsset,
    darkAsset: privateDarkAsset,
  },
  admins: {
    titleKey: "wiki.pages.empty_state.admins.title",
    descriptionKey: "wiki.pages.empty_state.admins.description",
    lightAsset: privateLightAsset,
    darkAsset: privateDarkAsset,
  },
  archived: {
    titleKey: "wiki.pages.empty_state.archived.title",
    descriptionKey: "wiki.pages.empty_state.archived.description",
    lightAsset: archivedLightAsset,
    darkAsset: archivedDarkAsset,
  },
};

export const WikiListMainContent = observer(function WikiListMainContent(props: Props) {
  const { children, pageType, workspaceSlug } = props;
  // plane hooks
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  // router
  const router = useRouter();
  // store hooks
  const {
    canCurrentUserCreatePage,
    createPage,
    getCurrentProjectFilteredPageIdsByTab,
    getCurrentProjectPageIdsByTab,
    isAnyPageAvailable,
    loader,
  } = usePageStore(EPageStoreType.WORKSPACE);
  // states
  const [isCreatingPage, setIsCreatingPage] = useState(false);
  // derived values
  const pageIds = getCurrentProjectPageIdsByTab(pageType);
  const filteredPageIds = getCurrentProjectFilteredPageIdsByTab(pageType);

  // handle page create
  const handleCreatePage = async () => {
    setIsCreatingPage(true);

    const payload: Partial<TPage> = {
      access: getWikiPageAccessForTab(pageType),
    };

    await createPage(payload)
      // oxlint-disable-next-line promise/always-return
      .then((res) => {
        if (res?.id) router.push(`/${workspaceSlug}/wiki/${res.id}`);
      })
      .catch((err) => {
        setToast({
          type: "error",
          title: t("toast.error"),
          message: err?.data?.error || t("wiki_collections.toasts.create_page_error"),
        });
      })
      .finally(() => setIsCreatingPage(false));
  };

  if (loader === "init-loader") return <PageLoader />;

  // if no pages exist in the active page type
  if (!isAnyPageAvailable || pageIds?.length === 0) {
    // when the wiki has no pages at all, always show the generic "all" empty state
    const emptyState = WIKI_EMPTY_STATES[isAnyPageAvailable ? pageType : "all"];
    const canCreateFromEmptyState = canCurrentUserCreatePage && pageType !== "archived";
    return (
      <DetailedEmptyState
        title={t(emptyState.titleKey)}
        description={t(emptyState.descriptionKey)}
        assetPath={resolvedTheme === "light" ? emptyState.lightAsset : emptyState.darkAsset}
        primaryButton={
          canCreateFromEmptyState
            ? {
                text: t("workspace_empty_state.wiki.cta_primary"),
                onClick: () => {
                  void handleCreatePage();
                },
                disabled: isCreatingPage,
              }
            : undefined
        }
      />
    );
  }

  // if no pages match the filter criteria
  if (filteredPageIds?.length === 0)
    return (
      <EmptyStateDetailed
        assetKey="search"
        title={t("common_empty_state.search.title")}
        description={t("common_empty_state.search.description")}
      />
    );

  return <div className="h-full w-full overflow-hidden">{children}</div>;
});
