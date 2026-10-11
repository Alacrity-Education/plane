/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// plane imports
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogIcon,
  AlertDialogIntro,
  AlertDialogTitle,
} from "@makeplane/propel/components/alert-dialog";
import { Button } from "@makeplane/propel/components/button";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  workspaceSlug: string;
  projectId: string;
};

/**
 * @description confirms unlinking the wiki section of a project, its pages are kept as regular wiki pages
 * (mirrors ConfirmDialog, which does not expose test ids)
 */
export const UnlinkProjectWikiModal = observer(function UnlinkProjectWikiModal(props: Props) {
  const { isOpen, onClose, workspaceSlug, projectId } = props;
  // plane hooks
  const { t } = useTranslation();
  // states
  const [isSubmitting, setIsSubmitting] = useState(false);
  // store hooks
  const { removeProjectWikiSection } = usePageStore(EPageStoreType.WORKSPACE);

  const handleUnlink = async () => {
    if (!workspaceSlug || !projectId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await removeProjectWikiSection(workspaceSlug, projectId);
      setToast({
        type: "success",
        title: t("toast.success"),
        message: t("wiki.project_section.unlink_success"),
      });
      onClose();
    } catch (error) {
      setToast({
        type: "error",
        title: t("toast.error"),
        message: (error as { error?: string } | undefined)?.error || t("wiki.project_section.unlink_error"),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (open || isSubmitting) return;
        onClose();
      }}
    >
      <AlertDialogContent data-prevent-outside-click data-testid="project-wiki-unlink-modal">
        <AlertDialogBody>
          <AlertDialogHeader>
            <AlertDialogIcon variant="warning" />
            <AlertDialogIntro>
              <AlertDialogTitle>{t("wiki.project_section.unlink_modal.title")}</AlertDialogTitle>
              <AlertDialogDescription>{t("wiki.project_section.unlink_modal.description")}</AlertDialogDescription>
            </AlertDialogIntro>
          </AlertDialogHeader>
        </AlertDialogBody>
        <AlertDialogActions>
          <Button
            variant="secondary"
            size="sm"
            stretch="auto"
            label={t("common.cancel")}
            disabled={isSubmitting}
            render={<AlertDialogClose />}
          />
          <Button
            variant="danger"
            size="sm"
            stretch="auto"
            tabIndex={0}
            onClick={() => void handleUnlink()}
            loading={isSubmitting}
            label={t("wiki.project_section.unlink_modal.confirm")}
            data-testid="project-wiki-unlink-confirm"
          />
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
});
