/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@makeplane/propel/components/menu";
import { MoreHorizontalOutline, PagesOutline, UnlinkOutline } from "@makeplane/propel/icons";
import { Breadcrumbs } from "@plane/blocks/breadcrumb";
import { Header } from "@plane/blocks/layout";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EUserProjectRoles } from "@plane/types";
// components
import { CommonProjectBreadcrumbs } from "@/components/breadcrumbs/common";
import { useProjectCrumbProps } from "@/components/breadcrumbs/use-project-crumb-props";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { CreateWikiPageModal } from "@/components/wiki/modals/create-wiki-page-modal";
import { UnlinkProjectWikiModal } from "@/components/wiki/modals/unlink-project-wiki-modal";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";

export const ProjectWikiHeader = observer(function ProjectWikiHeader() {
  // router
  const router = useAppRouter();
  const { workspaceSlug, projectId } = useParams();
  const projectCrumb = useProjectCrumbProps(workspaceSlug?.toString(), projectId?.toString());
  // plane hooks
  const { t } = useTranslation();
  // states
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isUnlinkModalOpen, setIsUnlinkModalOpen] = useState(false);
  // store hooks
  const { loader } = useProject();
  const { allowPermissions } = useUserPermissions();
  const { projectWikiSections, canCurrentUserCreatePage } = usePageStore(EPageStoreType.WORKSPACE);
  // derived values
  const section = projectId ? projectWikiSections[projectId.toString()] : undefined;
  const canUnlinkSection = allowPermissions(
    [EUserProjectRoles.ADMIN],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug?.toString(),
    projectId?.toString()
  );

  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs isLoading={loader === "init-loader"}>
          <CommonProjectBreadcrumbs
            workspaceSlug={workspaceSlug?.toString()}
            projectId={projectId?.toString()}
            {...projectCrumb}
          />
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={t("sidebar.wiki")}
                href={`/${workspaceSlug}/projects/${projectId}/wiki`}
                icon={<PagesOutline className="h-4 w-4 text-tertiary" />}
                isLast
              />
            }
            isLast
          />
        </Breadcrumbs>
      </Header.LeftItem>
      {section && (
        <Header.RightItem>
          <Button
            variant="secondary"
            size="md"
            stretch="auto"
            label={t("wiki.project_section.open_in_wiki")}
            onClick={() => router.push(`/${workspaceSlug}/wiki/${section.root_page}`)}
            data-testid="project-wiki-open-in-wiki"
          />
          {canCurrentUserCreatePage && (
            <Button
              variant="primary"
              size="md"
              stretch="auto"
              label={t("wiki.project_section.add_sub_page")}
              onClick={() => setIsCreateModalOpen(true)}
              data-testid="project-wiki-add-sub-page"
            />
          )}
          {canUnlinkSection && (
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t("wiki.project_section.options")}
                    icon={<Icon icon={MoreHorizontalOutline} />}
                    data-testid="project-wiki-options"
                  />
                }
              />
              <MenuContent side="bottom" align="end">
                <MenuItem
                  variant="danger"
                  label={t("wiki.project_section.unlink")}
                  icon={<Icon icon={UnlinkOutline} />}
                  onClick={() => setIsUnlinkModalOpen(true)}
                  data-testid="project-wiki-unlink"
                />
              </MenuContent>
            </Menu>
          )}
          <CreateWikiPageModal
            isOpen={isCreateModalOpen}
            onClose={() => setIsCreateModalOpen(false)}
            workspaceSlug={workspaceSlug?.toString() ?? ""}
            defaultParentId={section.root_page}
          />
        </Header.RightItem>
      )}
      {/* kept outside of the section guard so that the dialog can close after the section is unlinked */}
      <UnlinkProjectWikiModal
        isOpen={isUnlinkModalOpen}
        onClose={() => setIsUnlinkModalOpen(false)}
        workspaceSlug={workspaceSlug?.toString() ?? ""}
        projectId={projectId?.toString() ?? ""}
      />
    </Header>
  );
});
