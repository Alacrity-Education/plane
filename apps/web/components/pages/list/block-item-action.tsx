/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import {
  GlobeOutline,
  InfoOutline,
  LockOutline,
  MembersOutline,
  MinusOutline,
  ShieldOutline,
} from "@makeplane/propel/icons";
// plane imports
import { Avatar } from "@makeplane/propel/components/avatar";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { FavoriteStar } from "@plane/blocks/common";
import { EPageAccess } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { renderFormattedDate, getFileURL } from "@plane/utils";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { usePageOperations } from "@/hooks/use-page-operations";
// plane web hooks
import type { EPageStoreType } from "@/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";
// local imports
import type { TPageActions, TPageActionsMenuItem } from "../dropdowns";
import { PageActions } from "../dropdowns";

const DEFAULT_OPTIONS_ORDER: TPageActions[] = [
  "open-in-new-tab",
  "copy-link",
  "make-a-copy",
  "toggle-lock",
  "toggle-access",
  "archive-restore",
  "delete",
];

type Props = {
  extraOptions?: TPageActionsMenuItem[];
  optionsOrder?: TPageActions[];
  page: TPageInstance;
  parentRef: React.RefObject<HTMLElement | null>;
  storeType: EPageStoreType;
};

export const BlockItemAction = observer(function BlockItemAction(props: Props) {
  const { extraOptions, optionsOrder = DEFAULT_OPTIONS_ORDER, page, parentRef, storeType } = props;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { getUserDetails } = useMember();
  // page operations
  const { pageOperations } = usePageOperations({
    page,
  });
  // derived values
  const { access, created_at, is_favorite, owned_by, canCurrentUserFavoritePage } = page;
  const ownerDetails = owned_by ? getUserDetails(owned_by) : undefined;

  return (
    <>
      {/* page details */}
      <div className="cursor-default">
        <Tooltip label={`Owned by: ${ownerDetails?.display_name ?? ""}`} layout="stacked">
          <Avatar
            alt={ownerDetails?.display_name}
            fallback={ownerDetails?.display_name?.[0]?.toUpperCase()}
            src={getFileURL(ownerDetails?.avatar_url ?? "")}
            size="xs"
          />
        </Tooltip>
      </div>
      <div className="cursor-default text-tertiary">
        {/* admins-only and members-only exist for wiki pages only */}
        {access === EPageAccess.ADMIN ? (
          <Tooltip label={t("wiki.access.admins_only")}>
            <ShieldOutline className="h-4 w-4" data-testid="page-access-admins-only" />
          </Tooltip>
        ) : access === EPageAccess.MEMBERS ? (
          <Tooltip label={t("wiki.access.members_only")}>
            <MembersOutline className="h-4 w-4" data-testid="page-access-members-only" />
          </Tooltip>
        ) : (
          <Tooltip label={access === EPageAccess.PUBLIC ? "Public" : "Private"}>
            {access === EPageAccess.PUBLIC ? <GlobeOutline className="h-4 w-4" /> : <LockOutline className="h-4 w-4" />}
          </Tooltip>
        )}
      </div>
      {/* vertical divider */}
      <MinusOutline className="-mx-3 h-5 w-5 rotate-90 text-placeholder" />

      {/* page info */}
      <Tooltip label={`Created on ${renderFormattedDate(created_at)}`} layout="stacked">
        <span className="grid h-4 w-4 cursor-default place-items-center">
          <InfoOutline className="h-4 w-4 text-tertiary" />
        </span>
      </Tooltip>

      {/* favorite/unfavorite */}
      {canCurrentUserFavoritePage && (
        <FavoriteStar
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            pageOperations.toggleFavorite();
          }}
          selected={is_favorite}
        />
      )}

      {/* quick actions dropdown */}
      <PageActions
        extraOptions={extraOptions}
        optionsOrder={optionsOrder}
        page={page}
        parentRef={parentRef}
        storeType={storeType}
      />
    </>
  );
});
