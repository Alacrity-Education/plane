/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { EPageAccess, EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TPageNavigationTabs } from "@plane/types";
import { cn } from "@plane/utils";
// hooks
import { useUserPermissions } from "@/hooks/store/user";

type TWikiTabNavigation = {
  workspaceSlug: string;
  pageType: TPageNavigationTabs;
};

// wiki tab options
/**
 * @description access of the pages created from a wiki tab (the private / admins-only tabs create pages of that access)
 */
export const getWikiPageAccessForTab = (pageType: string | null | undefined): EPageAccess => {
  if (pageType === "private") return EPageAccess.PRIVATE;
  if (pageType === "admins") return EPageAccess.ADMIN;
  if (pageType === "members") return EPageAccess.MEMBERS;
  return EPageAccess.PUBLIC;
};

// minRole: the tab is only shown to users with at least this workspace role
const WIKI_TABS: { key: TPageNavigationTabs; i18n_label: string; minRole?: EUserPermissions }[] = [
  {
    key: "all",
    i18n_label: "wiki.pages.tabs.all",
  },
  {
    key: "public",
    i18n_label: "wiki.pages.tabs.public",
  },
  {
    key: "private",
    i18n_label: "wiki.pages.tabs.private",
  },
  {
    key: "members",
    i18n_label: "wiki.pages.tabs.members",
    minRole: EUserPermissions.MEMBER,
  },
  {
    key: "admins",
    i18n_label: "wiki.pages.tabs.admins",
    minRole: EUserPermissions.ADMIN,
  },
  {
    key: "archived",
    i18n_label: "wiki.pages.tabs.archived",
  },
];

export const WikiTabNavigation = observer(function WikiTabNavigation(props: TWikiTabNavigation) {
  const { workspaceSlug, pageType } = props;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { allowPermissions } = useUserPermissions();
  // derived values
  const isWorkspaceAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const isAtLeastWorkspaceMember = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE
  );
  const tabs = WIKI_TABS.filter(
    (tab) => !tab.minRole || (tab.minRole === EUserPermissions.ADMIN ? isWorkspaceAdmin : isAtLeastWorkspaceMember)
  );

  const handleTabClick = (e: React.MouseEvent<HTMLAnchorElement>, tabKey: TPageNavigationTabs) => {
    if (tabKey === pageType) e.preventDefault();
  };

  return (
    <div className="relative flex h-full items-center">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={`/${workspaceSlug}/wiki?type=${tab.key}`}
          onClick={(e) => handleTabClick(e, tab.key)}
          className="flex h-full flex-col"
        >
          <div
            className={cn(`flex flex-1 items-center justify-center px-4 text-13 font-medium transition-all`, {
              "text-accent-primary": tab.key === pageType,
            })}
          >
            {t(tab.i18n_label)}
          </div>
          <div
            className={cn(`w-full rounded-t border-t-2 border-transparent transition-all`, {
              "border-accent-strong": tab.key === pageType,
            })}
          />
        </Link>
      ))}
    </div>
  );
});
