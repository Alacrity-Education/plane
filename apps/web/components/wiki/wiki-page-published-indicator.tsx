/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { GlobeOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
// store
import type { TPageInstance } from "@/store/pages/base-page";

type Props = {
  page: TPageInstance;
};

/**
 * @description header indicator shown while a wiki page is published to the public docs site
 */
export const WikiPagePublishedIndicator = observer(function WikiPagePublishedIndicator({ page }: Props) {
  const { t } = useTranslation();

  if (!page.is_published) return null;

  const label = t("wiki.publish.published_tooltip");

  return (
    <Tooltip label={label} side="bottom">
      <span
        role="img"
        aria-label={label}
        data-testid="wiki-page-published-indicator"
        className="grid size-6 flex-shrink-0 place-items-center rounded-sm text-accent-primary"
      >
        <GlobeOutline className="size-3.5" />
      </span>
    </Tooltip>
  );
});
