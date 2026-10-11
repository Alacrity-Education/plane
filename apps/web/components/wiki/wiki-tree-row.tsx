/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef } from "react";
import { observer } from "mobx-react";
import { ChevronRightOutline, PagesOutline } from "@makeplane/propel/icons";
// plane imports
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { Logo } from "@plane/blocks/emoji-icon-picker";
import { ControlLink, Row } from "@plane/blocks/layout";
import { useTranslation } from "@plane/i18n";
import { cn, getPageName } from "@plane/utils";
// components
import type { TPageActions } from "@/components/pages/dropdowns";
import { BlockItemAction } from "@/components/pages/list/block-item-action";
// hooks
import { EPageStoreType, usePage } from "@/hooks/store";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePlatformOS } from "@/hooks/use-platform-os";
// local imports
import { useWikiPageExtraOptions } from "./use-wiki-page-extra-options";

const WIKI_ROW_OPTIONS_ORDER: TPageActions[] = [
  "open-in-new-tab",
  "copy-link",
  "make-a-copy",
  "add-sub-page",
  "move",
  "toggle-lock",
  "toggle-access",
  "archive-restore",
  "delete",
];

// indentation added for every tree level
const INDENT_PER_LEVEL = 24;

type Props = {
  pageId: string;
  depth: number;
  // number of visible children, rendered as the "N nested pages" hint
  childCount: number;
  // undefined when the row has no disclosure toggle (flat list)
  isExpanded?: boolean;
  onToggle?: (pageId: string) => void;
  onAddSubPage: (pageId: string) => void;
  onMove: (pageId: string) => void;
};

/**
 * @description a wiki list row with an optional disclosure toggle; mirrors the markup of ListItem/PageListBlock
 * but keeps the toggle outside of the row link
 */
export const WikiTreeRow = observer(function WikiTreeRow(props: Props) {
  const { pageId, depth, childCount, isExpanded, onToggle, onAddSubPage, onMove } = props;
  // refs
  const parentRef = useRef<HTMLDivElement>(null);
  // router
  const router = useAppRouter();
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const page = usePage({ pageId, storeType: EPageStoreType.WORKSPACE });
  const { isMobile } = usePlatformOS();
  // wiki actions
  const extraOptions = useWikiPageExtraOptions({ page, onAddSubPage, onMove });

  if (!page) return null;
  // derived values
  const { name, logo_props, project_wiki, getRedirectionLink } = page;
  const pageName = getPageName(name);
  const itemLink = getRedirectionLink();
  const hasToggle = isExpanded !== undefined;

  return (
    <div ref={parentRef} className="relative" data-testid="wiki-tree-row" data-page-id={pageId} data-depth={depth}>
      <Row className="group flex min-h-[52px] w-full flex-col items-center justify-between gap-3 border-b border-subtle bg-layer-transparent py-4 text-13 hover:bg-layer-transparent-hover lg:flex-row lg:gap-5 lg:py-0">
        <div
          className="relative flex w-full items-center gap-1.5 truncate"
          style={{ paddingLeft: `${depth * INDENT_PER_LEVEL}px` }}
        >
          {hasToggle &&
            (childCount > 0 ? (
              <button
                type="button"
                className="grid size-5 flex-shrink-0 place-items-center rounded-sm text-tertiary hover:bg-layer-transparent-hover hover:text-secondary"
                onClick={() => onToggle?.(pageId)}
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded ? t("wiki_collections.list.collapse_page") : t("wiki_collections.list.expand_page")
                }
                data-testid="wiki-tree-toggle"
              >
                <ChevronRightOutline className={cn("size-3.5 transition-transform", { "rotate-90": isExpanded })} />
              </button>
            ) : (
              <span className="size-5 flex-shrink-0" aria-hidden />
            ))}
          <ControlLink
            className="relative flex w-full items-center gap-3 overflow-hidden"
            href={itemLink}
            target="_self"
            onClick={() => router.push(itemLink)}
          >
            <div className={cn("flex items-center truncate", project_wiki ? "gap-2" : "gap-4")}>
              <span className="flex flex-shrink-0 items-center">
                {logo_props?.in_use ? (
                  <Logo logo={logo_props} size={16} type="lucide" />
                ) : (
                  <PagesOutline className="h-4 w-4 text-tertiary" />
                )}
              </span>
              {project_wiki && (
                <Tooltip label={project_wiki.name} disabled={isMobile}>
                  <span
                    className="flex-shrink-0 rounded-sm bg-layer-2 px-1.5 py-0.5 text-11 font-medium text-secondary"
                    data-testid="wiki-project-badge"
                  >
                    {project_wiki.identifier}
                  </span>
                </Tooltip>
              )}
              <Tooltip label={pageName} layout="stacked" disabled={isMobile}>
                <span className="truncate text-13">{pageName}</span>
              </Tooltip>
            </div>
            {childCount > 0 && (
              <span
                className="flex-shrink-0 text-11 whitespace-nowrap text-tertiary"
                data-testid="wiki-tree-nested-count"
              >
                {t("wiki.pages.tree.nested_pages", { count: childCount })}
              </span>
            )}
          </ControlLink>
        </div>
        <div className="relative flex w-full flex-shrink-0 flex-wrap items-center justify-start gap-4 lg:w-auto lg:flex-shrink-0 lg:flex-nowrap">
          <BlockItemAction
            page={page}
            parentRef={parentRef}
            storeType={EPageStoreType.WORKSPACE}
            extraOptions={extraOptions}
            optionsOrder={WIKI_ROW_OPTIONS_ORDER}
          />
        </div>
      </Row>
    </div>
  );
});
