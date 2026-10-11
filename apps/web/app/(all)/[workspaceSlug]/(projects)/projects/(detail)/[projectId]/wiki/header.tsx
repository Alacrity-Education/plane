/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { PagesOutline } from "@makeplane/propel/icons";
import { Breadcrumbs } from "@plane/blocks/breadcrumb";
import { Header } from "@plane/blocks/layout";
import { useTranslation } from "@plane/i18n";
// components
import { CommonProjectBreadcrumbs } from "@/components/breadcrumbs/common";
import { useProjectCrumbProps } from "@/components/breadcrumbs/use-project-crumb-props";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
import { useProject } from "@/hooks/store/use-project";
import { useAppRouter } from "@/hooks/use-app-router";

export const ProjectWikiHeader = observer(function ProjectWikiHeader() {
  // router
  const router = useAppRouter();
  const { workspaceSlug, projectId } = useParams();
  const projectCrumb = useProjectCrumbProps(workspaceSlug?.toString(), projectId?.toString());
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { loader } = useProject();
  const { projectWikiSections } = usePageStore(EPageStoreType.WORKSPACE);
  // derived values
  const section = projectId ? projectWikiSections[projectId.toString()] : undefined;

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
        </Header.RightItem>
      )}
    </Header>
  );
});
