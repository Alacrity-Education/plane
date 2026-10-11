/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useTheme } from "next-themes";
import useSWR from "swr";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { setToast } from "@plane/blocks/toast";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EUserProjectRoles } from "@plane/types";
// assets
import wikiDarkAsset from "@/app/assets/empty-state/wiki/all-dark.webp?url";
import wikiLightAsset from "@/app/assets/empty-state/wiki/all-light.webp?url";
// components
import { PageHead } from "@/components/core/page-title";
import { DetailedEmptyState } from "@/components/empty-state/detailed-empty-state-root";
import { PageLoader } from "@/components/pages/loaders/page-loader";
import { WikiTree } from "@/components/wiki/wiki-tree";
// hooks
import { EPageStoreType, usePageStore } from "@/hooks/store";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import type { Route } from "./+types/page";

function ProjectWikiPage({ params }: Route.ComponentProps) {
  const { workspaceSlug, projectId } = params;
  // router
  const router = useAppRouter();
  // theme hook
  const { resolvedTheme } = useTheme();
  // plane hooks
  const { t } = useTranslation();
  // states
  const [isCreating, setIsCreating] = useState(false);
  // store hooks
  const { getProjectById } = useProject();
  const { allowPermissions } = useUserPermissions();
  const {
    loader,
    projectWikiSections,
    fetchPagesList,
    fetchProjectWikiSection,
    createProjectWikiSection,
    getPageById,
  } = usePageStore(EPageStoreType.WORKSPACE);
  // fetch the project wiki section and the wiki pages (same key as the "All" tab of the wiki home)
  const { error: sectionError } = useSWR(`PROJECT_WIKI_SECTION_${workspaceSlug}_${projectId}`, () =>
    fetchProjectWikiSection(workspaceSlug, projectId)
  );
  useSWR(`WORKSPACE_WIKI_PAGES_${workspaceSlug}_all`, () => fetchPagesList(workspaceSlug, "all"));
  // derived values
  const project = getProjectById(projectId);
  const section = projectWikiSections[projectId];
  const rootPage = section ? getPageById(section.root_page) : undefined;
  const canCreateSection = allowPermissions(
    [EUserProjectRoles.ADMIN, EUserProjectRoles.MEMBER],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug,
    projectId
  );
  const pageTitle = project?.name ? `${project.name} - ${t("sidebar.wiki")}` : undefined;
  const assetPath = resolvedTheme === "light" ? wikiLightAsset : wikiDarkAsset;

  const handleCreateSection = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const createdSection = await createProjectWikiSection(workspaceSlug, projectId);
      router.push(`/${workspaceSlug}/wiki/${createdSection.root_page}`);
    } catch (error) {
      // the section may have been created meanwhile (409), pick it up instead of failing
      const existingSection = await fetchProjectWikiSection(workspaceSlug, projectId).catch(() => null);
      if (existingSection) {
        router.push(`/${workspaceSlug}/wiki/${existingSection.root_page}`);
        return;
      }
      setToast({
        type: "error",
        title: t("toast.error"),
        message: (error as { error?: string } | undefined)?.error || t("wiki.project_section.create_error"),
      });
    } finally {
      setIsCreating(false);
    }
  };

  // section not fetched yet
  if (section === undefined && !sectionError) return <PageLoader />;

  // no section (or it could not be fetched): empty state, with the create action for project admins and members
  if (!section)
    return (
      <>
        <PageHead title={pageTitle} />
        <div className="h-full w-full" data-testid="project-wiki-empty">
          <DetailedEmptyState
            title={t("wiki.project_section.empty_state.title")}
            description={
              canCreateSection
                ? t("wiki.project_section.empty_state.description")
                : t("wiki.project_section.empty_state.no_permission")
            }
            assetPath={assetPath}
            customPrimaryButton={
              canCreateSection ? (
                <Button
                  variant="primary"
                  size="md"
                  stretch="auto"
                  label={isCreating ? t("wiki.project_section.creating") : t("wiki.project_section.create")}
                  loading={isCreating}
                  disabled={isCreating}
                  onClick={() => void handleCreateSection()}
                  data-testid="project-wiki-create"
                />
              ) : undefined
            }
          />
        </div>
      </>
    );

  if (!rootPage && loader === "init-loader") return <PageLoader />;

  // the section root page is not reachable (archived, private or deleted)
  if (!rootPage || rootPage.archived_at)
    return (
      <>
        <PageHead title={pageTitle} />
        <DetailedEmptyState
          title={t("wiki.project_section.root_unavailable.title")}
          description={t("wiki.project_section.root_unavailable.description")}
          assetPath={assetPath}
          primaryButton={{
            text: t("wiki.project_section.open_in_wiki"),
            onClick: () => router.push(`/${workspaceSlug}/wiki`),
          }}
        />
      </>
    );

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="h-full w-full overflow-hidden" data-testid="project-wiki-tree">
        <WikiTree pageType="all" workspaceSlug={workspaceSlug} rootPageId={section.root_page} />
      </div>
    </>
  );
}

export default observer(ProjectWikiPage);
