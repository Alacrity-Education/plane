/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { PagesOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import type { BreadcrumbNavigationItem } from "@plane/blocks/breadcrumb";
import { Breadcrumbs, BreadcrumbNavigationSelect } from "@plane/blocks/breadcrumb";
import { Header } from "@plane/blocks/layout";
import { getPageName } from "@plane/utils";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { PageAccessIcon } from "@/components/common/page-access-icon";
import { SwitcherIcon, SwitcherLabel } from "@/components/common/switcher-label";
import { PageHeaderActions } from "@/components/pages/header/actions";
import { PageSyncingBadge } from "@/components/pages/header/syncing-badge";
import { CreateWikiPageModal } from "@/components/wiki/modals/create-wiki-page-modal";
import { MoveWikiPageModal } from "@/components/wiki/modals/move-page-modal";
import { useWikiPageExtraOptions } from "@/components/wiki/use-wiki-page-extra-options";
// hooks
import { EPageStoreType, usePage, usePageStore } from "@/hooks/store";
import { useAppRouter } from "@/hooks/use-app-router";

const storeType = EPageStoreType.WORKSPACE;

export const WikiPageDetailsHeader = observer(function WikiPageDetailsHeader() {
  // plane hooks
  const { t } = useTranslation();
  // router
  const router = useAppRouter();
  const { workspaceSlug, pageId } = useParams();
  // states
  const [subPageParentId, setSubPageParentId] = useState<string | null>(null);
  const [movePageId, setMovePageId] = useState<string | undefined>(undefined);
  // store hooks
  const { getPageById, getAncestorIds, getCurrentWorkspacePageIds } = usePageStore(storeType);
  const page = usePage({
    pageId: pageId?.toString() ?? "",
    storeType,
  });
  // derived values
  const workspacePageIds = getCurrentWorkspacePageIds();
  const ancestorPages = (pageId ? getAncestorIds(pageId.toString()) : [])
    .map((ancestorId) => getPageById(ancestorId))
    .filter((ancestorPage) => !!ancestorPage?.id);
  // wiki actions
  const handleAddSubPage = useCallback((targetPageId: string) => setSubPageParentId(targetPageId), []);
  const handleMove = useCallback((targetPageId: string) => setMovePageId(targetPageId), []);
  const extraOptions = useWikiPageExtraOptions({ page, onAddSubPage: handleAddSubPage, onMove: handleMove });

  const switcherOptions = workspacePageIds
    .map<BreadcrumbNavigationItem | undefined>((id) => {
      const _page = id === pageId ? page : getPageById(id);
      if (!_page?.id) return;
      return {
        key: _page.id,
        label: getPageName(_page.name),
        content: (
          <div className="flex items-center justify-between gap-2">
            <SwitcherLabel logo_props={_page.logo_props} name={getPageName(_page.name)} LabelIcon={PagesOutline} />
            <PageAccessIcon {..._page} />
          </div>
        ),
      };
    })
    .filter((option) => option !== undefined);

  if (!page) return null;

  return (
    <Header>
      <Header.LeftItem>
        <div>
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  label={t("sidebar.wiki")}
                  href={`/${workspaceSlug}/wiki`}
                  icon={<PagesOutline className="h-4 w-4 text-tertiary" />}
                />
              }
            />
            {ancestorPages.map((ancestorPage) => (
              <Breadcrumbs.Item
                key={ancestorPage?.id}
                component={
                  <BreadcrumbLink
                    label={getPageName(ancestorPage?.name)}
                    href={`/${workspaceSlug}/wiki/${ancestorPage?.id}`}
                    icon={<SwitcherIcon logo_props={ancestorPage?.logo_props} LabelIcon={PagesOutline} size={16} />}
                  />
                }
              />
            ))}
            <Breadcrumbs.Item
              component={
                <BreadcrumbNavigationSelect
                  selectedItemKey={pageId?.toString() ?? ""}
                  navigationItems={switcherOptions}
                  onChange={(value: string) => {
                    router.push(`/${workspaceSlug}/wiki/${value}`);
                  }}
                  label={getPageName(page?.name)}
                  icon={<SwitcherIcon logo_props={page.logo_props} LabelIcon={PagesOutline} size={16} />}
                  placeholder={t("pages")}
                  searchPlaceholder={t("common.search.label")}
                  emptyMessage={t("common.search.no_matches_found")}
                  isLast
                />
              }
              isLast
            />
          </Breadcrumbs>
        </div>
      </Header.LeftItem>
      <Header.RightItem>
        <PageSyncingBadge syncStatus={page.isSyncingWithServer} />
        <PageHeaderActions page={page} storeType={storeType} extraOptions={extraOptions} />
        <CreateWikiPageModal
          isOpen={!!subPageParentId}
          onClose={() => setSubPageParentId(null)}
          workspaceSlug={workspaceSlug?.toString() ?? ""}
          defaultParentId={subPageParentId}
        />
        <MoveWikiPageModal
          isOpen={!!movePageId}
          onClose={() => setMovePageId(undefined)}
          pageId={movePageId}
          workspaceSlug={workspaceSlug?.toString() ?? ""}
        />
      </Header.RightItem>
    </Header>
  );
});
