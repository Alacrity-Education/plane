/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { CloseOutline, ProjectsOutline, SearchOutline } from "@makeplane/propel/icons";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogCloseGroup,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { InputField } from "@makeplane/propel/components/input-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  // called with the project wiki root page id once the page has been moved
  onMoved?: (rootPageId: string) => void;
  pageId: string | undefined;
  workspaceSlug: string;
};

/**
 * @description moves a wiki page (with its sub-pages) under the root page of a project wiki section,
 * the projects are the ones whose wiki section root page is loaded
 */
export const MoveToProjectWikiModal = observer(function MoveToProjectWikiModal(props: Props) {
  const { isOpen, onClose, onMoved, pageId, workspaceSlug } = props;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { fetchPagesList, getPageById, getProjectWikiRootPageIds, movePage } = usePageStore(EPageStoreType.WORKSPACE);
  // states
  const [searchQuery, setSearchQuery] = useState("");
  const [rootPageId, setRootPageId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // make sure every non archived page is loaded (same key as the "All" tab of the wiki list)
  useSWR(isOpen && workspaceSlug ? `WORKSPACE_WIKI_PAGES_${workspaceSlug}_all` : null, () =>
    fetchPagesList(workspaceSlug, "all")
  );
  // derived values
  const page = pageId ? getPageById(pageId) : undefined;
  const projectOptions = getProjectWikiRootPageIds("all")
    .map((id) => {
      const projectWiki = getPageById(id)?.project_wiki;
      return projectWiki
        ? {
            rootPageId: id,
            project_id: projectWiki.project_id,
            identifier: projectWiki.identifier,
            name: projectWiki.name,
          }
        : undefined;
    })
    .filter((option) => option !== undefined);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? projectOptions.filter(
        (option) =>
          option.identifier.toLowerCase().includes(normalizedQuery) ||
          option.name.toLowerCase().includes(normalizedQuery)
      )
    : projectOptions;

  // start from a blank selection every time the modal opens
  useEffect(() => {
    if (!isOpen) return;
    setSearchQuery("");
    setRootPageId(null);
    setIsSubmitting(false);
  }, [isOpen, pageId]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pageId || !rootPageId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      // appended as the last child of the section root page
      await movePage(workspaceSlug, pageId, rootPageId);
      setToast({
        type: "success",
        title: t("toast.success"),
        message: t("wiki.project_section.move_to_project.success"),
      });
      onMoved?.(rootPageId);
      onClose();
    } catch (error) {
      setToast({
        type: "error",
        title: t("toast.error"),
        message: (error as { error?: string } | undefined)?.error || t("wiki.project_section.move_to_project.error"),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!page) return null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="sm" data-testid="wiki-move-to-project-modal">
        <DialogCloseGroup>
          <IconButton
            variant="ghost"
            size="xs"
            icon={<Icon icon={CloseOutline} />}
            aria-label={t("close")}
            render={<DialogClose />}
          />
        </DialogCloseGroup>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 flex-col">
          <DialogMain>
            <DialogHeader>
              <DialogHeading>
                <DialogTitle>{t("wiki.project_section.move_to_project.title")}</DialogTitle>
              </DialogHeading>
            </DialogHeader>
            <DialogBody tabIndex={0}>
              <div className="flex flex-col gap-2">
                <InputField
                  size="lg"
                  orientation="vertical"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("wiki.project_section.move_to_project.search_placeholder")}
                  aria-label={t("wiki.project_section.move_to_project.search_placeholder")}
                  startIcon={<SearchOutline className="size-3.5 text-placeholder" />}
                  data-testid="wiki-move-to-project-search"
                />
                <div
                  role="radiogroup"
                  aria-label={t("wiki.project_section.move_to_project.title")}
                  className="vertical-scrollbar scrollbar-sm flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-subtle p-1"
                  data-testid="wiki-move-to-project-list"
                >
                  {filteredOptions.map((option) => {
                    const isSelected = rootPageId === option.rootPageId;
                    return (
                      <button
                        key={option.rootPageId}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setRootPageId(option.rootPageId)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 text-secondary",
                          {
                            "bg-layer-transparent-selected text-primary": isSelected,
                            "hover:bg-layer-transparent-hover": !isSelected,
                          }
                        )}
                        data-testid={`wiki-move-to-project-option-${option.project_id}`}
                      >
                        <ProjectsOutline className="size-4 flex-shrink-0 text-tertiary" />
                        <span className="flex-shrink-0 rounded-sm bg-layer-2 px-1 text-11 font-medium text-secondary">
                          {option.identifier}
                        </span>
                        <span className="flex-grow truncate">{option.name}</span>
                      </button>
                    );
                  })}
                  {projectOptions.length === 0 ? (
                    <p className="px-2 py-1.5 text-13 text-tertiary" data-testid="wiki-move-to-project-empty">
                      {t("wiki.project_section.move_to_project.empty")}
                    </p>
                  ) : (
                    filteredOptions.length === 0 && (
                      <p className="px-2 py-1.5 text-13 text-tertiary">{t("wiki.pages.parent_picker.no_results")}</p>
                    )
                  )}
                </div>
              </div>
            </DialogBody>
          </DialogMain>
          <DialogActions>
            <Button variant="secondary" size="md" stretch="auto" label={t("common.cancel")} onClick={onClose} />
            <Button
              variant="primary"
              size="md"
              stretch="auto"
              type="submit"
              label={
                isSubmitting
                  ? t("page_actions.move_page.submit_button.loading")
                  : t("wiki.project_section.move_to_project.submit")
              }
              loading={isSubmitting}
              disabled={!rootPageId}
              data-testid="wiki-move-to-project-submit"
            />
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
});
