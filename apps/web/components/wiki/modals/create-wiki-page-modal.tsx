/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { CloseOutline, GlobeOutline, LockOutline, MembersOutline, ShieldOutline } from "@makeplane/propel/icons";
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
import { Radio, RadioGroup } from "@makeplane/propel/components/radio";
import { EPageAccess } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { setToast } from "@plane/blocks/toast";
import type { TPage } from "@plane/types";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
import { useAppRouter } from "@/hooks/use-app-router";
// local imports
import { WikiPageParentPicker } from "./wiki-page-parent-picker";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  workspaceSlug: string;
  // parent pre-selected when the modal opens, null (default) for the top level
  defaultParentId?: string | null;
  defaultAccess?: EPageAccess;
};

const MAX_PAGE_NAME_LENGTH = 255;

// the creator owns the page, so every user who can create a wiki page (workspace admins and members) may pick
// any of these, admins-only and members-only included
const ACCESS_OPTIONS = [
  {
    key: EPageAccess.PUBLIC,
    icon: GlobeOutline,
    labelKey: "wiki.pages.create_modal.public_label",
    descriptionKey: "wiki.pages.create_modal.public_description",
  },
  {
    key: EPageAccess.PRIVATE,
    icon: LockOutline,
    labelKey: "wiki.pages.create_modal.private_label",
    descriptionKey: "wiki.pages.create_modal.private_description",
  },
  {
    key: EPageAccess.MEMBERS,
    icon: MembersOutline,
    labelKey: "wiki.pages.create_modal.members_label",
    descriptionKey: "wiki.pages.create_modal.members_description",
  },
  {
    key: EPageAccess.ADMIN,
    icon: ShieldOutline,
    labelKey: "wiki.pages.create_modal.admins_label",
    descriptionKey: "wiki.pages.create_modal.admins_description",
  },
] as const;

export const CreateWikiPageModal = observer(function CreateWikiPageModal(props: Props) {
  const { isOpen, onClose, workspaceSlug, defaultParentId = null, defaultAccess = EPageAccess.PUBLIC } = props;
  // states
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(defaultParentId);
  const [access, setAccess] = useState<EPageAccess>(defaultAccess);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // router
  const router = useAppRouter();
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { createPage, getPageById } = usePageStore(EPageStoreType.WORKSPACE);
  // derived values
  const isNameTooLong = name.length > MAX_PAGE_NAME_LENGTH;

  // reset the form every time the modal opens
  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setParentId(defaultParentId);
    setAccess(defaultAccess);
    setIsSubmitting(false);
  }, [isOpen, defaultParentId, defaultAccess]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting || isNameTooLong) return;
    setIsSubmitting(true);

    const payload: Partial<TPage> = {
      name: name.trim(),
      access,
      parent: parentId,
    };

    try {
      const page = await createPage(payload);
      // keep the parent's nested pages count in sync until the next fetch
      const parentPage = parentId ? getPageById(parentId) : undefined;
      parentPage?.mutateProperties({ sub_pages_count: (parentPage.sub_pages_count ?? 0) + 1 });
      onClose();
      if (page?.id) router.push(`/${workspaceSlug}/wiki/${page.id}`);
    } catch (error) {
      const errorMessage = (error as { error?: string; detail?: string } | undefined)?.error;
      setToast({
        type: "error",
        title: t("toast.error"),
        message: errorMessage || t("wiki_collections.toasts.create_page_error"),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="sm" data-testid="wiki-create-page-modal">
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
                <DialogTitle>{t("wiki.pages.create_modal.title")}</DialogTitle>
              </DialogHeading>
            </DialogHeader>
            <DialogBody tabIndex={0}>
              <div className="flex flex-col gap-4">
                <InputField
                  size="lg"
                  orientation="vertical"
                  type="text"
                  label={t("common.title")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("wiki.pages.create_modal.name_placeholder")}
                  error={isNameTooLong ? t("wiki.pages.create_modal.name_max_length") : undefined}
                  data-testid="wiki-create-page-title"
                  // the title is the first field of the dialog, focus it on open like the project page form
                  // oxlint-disable-next-line jsx_a11y/no-autofocus
                  autoFocus
                />
                <div className="flex flex-col gap-1.5">
                  <span className="text-13 font-medium text-secondary">
                    {t("wiki.pages.create_modal.parent_label")}
                  </span>
                  <WikiPageParentPicker value={parentId} onChange={setParentId} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span id="wiki-create-page-access-label" className="text-13 font-medium text-secondary">
                    {t("wiki.pages.create_modal.access_label")}
                  </span>
                  <RadioGroup<EPageAccess>
                    density="compact"
                    value={access}
                    onValueChange={(value) => setAccess(value)}
                    aria-labelledby="wiki-create-page-access-label"
                    data-testid="wiki-create-page-access"
                  >
                    {ACCESS_OPTIONS.map((option) => (
                      // oxlint-disable-next-line jsx_a11y/label-has-associated-control -- the radio button is the control
                      <label
                        key={option.key}
                        className="flex cursor-pointer items-center gap-3"
                        data-testid={`wiki-create-page-access-${option.key}`}
                      >
                        <Radio value={option.key} />
                        <option.icon className="size-4 flex-shrink-0 text-tertiary" />
                        <span className="flex flex-col">
                          <span className="text-13 font-medium text-primary">{t(option.labelKey)}</span>
                          <span className="text-11 text-tertiary">{t(option.descriptionKey)}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
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
              label={isSubmitting ? t("wiki.pages.create_modal.submitting") : t("wiki.pages.create_modal.submit")}
              loading={isSubmitting}
              disabled={isNameTooLong}
              data-testid="wiki-create-page-submit"
            />
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
});
