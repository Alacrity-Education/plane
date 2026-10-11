/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TPageNavigationTabs } from "@plane/types";
import { cn } from "@plane/utils";

type TWikiTabNavigation = {
  workspaceSlug: string;
  pageType: TPageNavigationTabs;
};

// wiki tab options
const WIKI_TABS: { key: TPageNavigationTabs; i18n_label: string }[] = [
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
    key: "archived",
    i18n_label: "wiki.pages.tabs.archived",
  },
];

export function WikiTabNavigation(props: TWikiTabNavigation) {
  const { workspaceSlug, pageType } = props;
  // plane hooks
  const { t } = useTranslation();

  const handleTabClick = (e: React.MouseEvent<HTMLAnchorElement>, tabKey: TPageNavigationTabs) => {
    if (tabKey === pageType) e.preventDefault();
  };

  return (
    <div className="relative flex h-full items-center">
      {WIKI_TABS.map((tab) => (
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
}
