/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
// plane imports
import { Icon } from "@makeplane/propel/components/icon";
import { Menu, MenuContent, MenuItem } from "@makeplane/propel/components/menu";
import { SplitButton } from "@makeplane/propel/components/split-button";
import { AddPageOutline, PagesOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs } from "@plane/blocks/breadcrumb";
import { Header } from "@plane/blocks/layout";
import { setToast } from "@plane/blocks/toast";
import type { TPage } from "@plane/types";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { CountChip } from "@/components/common/count-chip";
import { CreateWikiPageModal } from "@/components/wiki/modals/create-wiki-page-modal";
import { getWikiPageAccessForTab } from "@/components/wiki/wiki-tab-navigation";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";

export const WikiListHeader = observer(function WikiListHeader() {
  // states
  const [isCreatingPage, setIsCreatingPage] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // router
  const router = useRouter();
  const { workspaceSlug } = useParams();
  const searchParams = useSearchParams();
  const pageType = searchParams.get("type");
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { canCurrentUserCreatePage, createPage, getCurrentProjectPageIdsByTab } = usePageStore(
    EPageStoreType.WORKSPACE
  );
  // derived values
  const pagesCount = getCurrentProjectPageIdsByTab("all")?.length ?? 0;

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

  return (
    <Header>
      <Header.LeftItem>
        <div className="flex items-center gap-2.5">
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  label={t("sidebar.wiki")}
                  href={`/${workspaceSlug}/wiki`}
                  icon={<PagesOutline className="h-4 w-4 text-tertiary" />}
                  isLast
                />
              }
              isLast
            />
          </Breadcrumbs>
          {pagesCount > 0 && <CountChip count={pagesCount} />}
        </div>
      </Header.LeftItem>
      {canCurrentUserCreatePage && (
        <Header.RightItem>
          <CreateWikiPageModal
            isOpen={isCreateModalOpen}
            onClose={() => setIsCreateModalOpen(false)}
            workspaceSlug={workspaceSlug?.toString() ?? ""}
            defaultAccess={getWikiPageAccessForTab(pageType)}
          />
          <Menu>
            <SplitButton
              variant="primary"
              size="md"
              label={isCreatingPage ? t("wiki.pages.adding_page") : t("wiki_collections.header.add_page")}
              onClick={() => void handleCreatePage()}
              loading={isCreatingPage}
              menuLabel={t("wiki.pages.header.more_create_options")}
              data-testid="wiki-add-page"
            />
            <MenuContent side="bottom" align="end">
              <MenuItem
                label={t("wiki.pages.header.create_with_options")}
                icon={<Icon icon={AddPageOutline} />}
                onClick={() => setIsCreateModalOpen(true)}
              />
            </MenuContent>
          </Menu>
        </Header.RightItem>
      )}
    </Header>
  );
});
