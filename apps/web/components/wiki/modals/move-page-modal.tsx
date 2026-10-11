/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { CloseOutline } from "@makeplane/propel/icons";
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
import { useTranslation } from "@plane/i18n";
import { setToast } from "@plane/blocks/toast";
import { getPageName } from "@plane/utils";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
// local imports
import { WikiPageParentPicker } from "./wiki-page-parent-picker";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  // called with the new parent id once the page has been moved
  onMoved?: (parentId: string | null) => void;
  pageId: string | undefined;
  workspaceSlug: string;
};

export const MoveWikiPageModal = observer(function MoveWikiPageModal(props: Props) {
  const { isOpen, onClose, onMoved, pageId, workspaceSlug } = props;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { getPageById, getDescendantIds, movePage } = usePageStore(EPageStoreType.WORKSPACE);
  // derived values
  const page = pageId ? getPageById(pageId) : undefined;
  const currentParentId = page?.parent ?? null;
  // states
  const [parentId, setParentId] = useState<string | null>(currentParentId);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // the page itself and its descendants cannot become its parent
  const disabledReasons: Record<string, string> = {};
  if (pageId) {
    disabledReasons[pageId] = t("wiki.pages.parent_picker.this_page");
    getDescendantIds(pageId).forEach((descendantId) => {
      disabledReasons[descendantId] = t("wiki.pages.parent_picker.sub_page");
    });
  }

  // start from the current parent every time the modal opens
  useEffect(() => {
    if (!isOpen) return;
    setParentId(currentParentId);
    setIsSubmitting(false);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only reset when the modal (re)opens
  }, [isOpen, pageId]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pageId || isSubmitting || parentId === currentParentId) return;
    setIsSubmitting(true);
    try {
      await movePage(workspaceSlug, pageId, parentId);
      setToast({
        type: "success",
        title: t("page_actions.move_page.toasts.success.title"),
        message: t("page_actions.move_page.toasts.success.message"),
      });
      onMoved?.(parentId);
      onClose();
    } catch (error) {
      const errorMessage = (error as { error?: string } | undefined)?.error;
      setToast({
        type: "error",
        title: t("page_actions.move_page.toasts.error.title"),
        message: errorMessage || t("page_actions.move_page.toasts.error.message"),
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
      <DialogContent size="sm" data-testid="wiki-move-page-modal">
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
                <DialogTitle>{t("wiki.pages.move_modal.title", { name: getPageName(page.name) })}</DialogTitle>
              </DialogHeading>
            </DialogHeader>
            <DialogBody tabIndex={0}>
              <WikiPageParentPicker
                value={parentId}
                onChange={setParentId}
                disabledReasons={disabledReasons}
                currentParentId={currentParentId}
              />
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
                  : t("page_actions.move_page.submit_button.default")
              }
              loading={isSubmitting}
              disabled={parentId === currentParentId}
              data-testid="wiki-move-page-submit"
            />
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
});
