/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { HomeOutline, PagesOutline, SearchOutline } from "@makeplane/propel/icons";
// plane imports
import { InputField } from "@makeplane/propel/components/input-field";
import { Logo } from "@plane/blocks/emoji-icon-picker";
import { useTranslation } from "@plane/i18n";
import { cn, getPageName } from "@plane/utils";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";

type TPickerOption = {
  id: string;
  depth: number;
};

type Props = {
  // selected parent id, null for the top level
  value: string | null;
  onChange: (parentId: string | null) => void;
  // pages that cannot be picked, with the reason shown next to them
  disabledReasons?: Record<string, string>;
  // the current parent of the page being moved, highlighted with a "Current" badge
  currentParentId?: string | null;
};

/**
 * @description searchable single-select list of wiki pages (archived pages excluded) with a "Top level" option
 */
export const WikiPageParentPicker = observer(function WikiPageParentPicker(props: Props) {
  const { value, onChange, disabledReasons = {}, currentParentId } = props;
  // states
  const [searchQuery, setSearchQuery] = useState("");
  // plane hooks
  const { t } = useTranslation();
  // router
  const { workspaceSlug } = useParams();
  // store hooks
  const { fetchPagesList, getPageById, getRootPageIds, getChildPageIds } = usePageStore(EPageStoreType.WORKSPACE);
  // make sure every non archived page is loaded, the list may have been fetched for a single tab only
  // (same key as the "All" tab of the wiki list, so the requests are shared)
  useSWR(workspaceSlug ? `WORKSPACE_WIKI_PAGES_${workspaceSlug.toString()}_all` : null, () =>
    fetchPagesList(workspaceSlug?.toString() ?? "", "all")
  );
  // derived values
  const rootPageIds = getRootPageIds("all");
  // flatten the (non archived) tree depth first so that the options keep the wiki hierarchy
  const treeOptions: TPickerOption[] = [];
  const visitedIds = new Set<string>();
  const visit = (pageId: string, depth: number) => {
    if (visitedIds.has(pageId)) return;
    visitedIds.add(pageId);
    treeOptions.push({ id: pageId, depth });
    getChildPageIds(pageId, "all").forEach((childId) => visit(childId, depth + 1));
  };
  rootPageIds.forEach((pageId) => visit(pageId, 0));
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const options = normalizedQuery
    ? treeOptions
        .filter((option) => getPageName(getPageById(option.id)?.name).toLowerCase().includes(normalizedQuery))
        .map((option) => ({ id: option.id, depth: 0 }))
    : treeOptions;
  const showTopLevel =
    !normalizedQuery || t("wiki.pages.parent_picker.top_level").toLowerCase().includes(normalizedQuery);

  const optionClassName = (isSelected: boolean, isDisabled: boolean) =>
    cn("flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 text-secondary", {
      "bg-layer-transparent-selected text-primary": isSelected,
      "hover:bg-layer-transparent-hover": !isSelected && !isDisabled,
      "cursor-not-allowed opacity-60": isDisabled,
    });

  return (
    <div className="flex flex-col gap-2">
      <InputField
        size="lg"
        orientation="vertical"
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={t("wiki.pages.parent_picker.search_placeholder")}
        aria-label={t("wiki.pages.parent_picker.search_placeholder")}
        startIcon={<SearchOutline className="size-3.5 text-placeholder" />}
        data-testid="wiki-parent-picker-search"
      />
      <div
        role="radiogroup"
        aria-label={t("wiki.pages.create_modal.parent_label")}
        className="vertical-scrollbar scrollbar-sm flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-subtle p-1"
        data-testid="wiki-parent-picker"
      >
        {showTopLevel && (
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            onClick={() => onChange(null)}
            className={optionClassName(value === null, false)}
            data-testid="wiki-parent-option-top-level"
          >
            <HomeOutline className="size-4 flex-shrink-0 text-tertiary" />
            <span className="flex-grow truncate">{t("wiki.pages.parent_picker.top_level")}</span>
            {currentParentId === null && (
              <span className="flex-shrink-0 text-11 text-tertiary">
                {t("wiki.pages.parent_picker.current_parent")}
              </span>
            )}
          </button>
        )}
        {options.map((option) => {
          const page = getPageById(option.id);
          if (!page) return null;
          const disabledReason = disabledReasons[option.id];
          const isDisabled = !!disabledReason;
          const isSelected = value === option.id;
          const pageName = getPageName(page.name);
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-disabled={isDisabled}
              disabled={isDisabled}
              onClick={() => onChange(option.id)}
              className={optionClassName(isSelected, isDisabled)}
              style={{ paddingLeft: `${8 + option.depth * 16}px` }}
              data-testid={`wiki-parent-option-${option.id}`}
            >
              <span className="grid size-4 flex-shrink-0 place-items-center">
                {page.logo_props?.in_use ? (
                  <Logo logo={page.logo_props} size={14} type="lucide" />
                ) : (
                  <PagesOutline className="size-4 text-tertiary" />
                )}
              </span>
              <span className="flex-grow truncate">{pageName}</span>
              {disabledReason ? (
                <span className="flex-shrink-0 text-11 text-tertiary">{disabledReason}</span>
              ) : (
                currentParentId === option.id && (
                  <span className="flex-shrink-0 text-11 text-tertiary">
                    {t("wiki.pages.parent_picker.current_parent")}
                  </span>
                )
              )}
            </button>
          );
        })}
        {!showTopLevel && options.length === 0 && (
          <p className="px-2 py-1.5 text-13 text-tertiary">{t("wiki.pages.parent_picker.no_results")}</p>
        )}
      </div>
    </div>
  );
});
