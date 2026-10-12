/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TVisibility, TWarning } from "./types";

export type TPageAction = "created" | "updated" | "unchanged" | "adopted" | "skipped" | "failed" | "planned";

export type TReportPage = {
  path: string;
  title: string;
  kind: "folder" | "page";
  source?: string | undefined;
  visibility: TVisibility;
  visibilityReason: string;
  pageId?: string | undefined;
  /** What happened to the page itself (name/parent/order). */
  action: TPageAction;
  /** What happened to its content. */
  content?: "written" | "unchanged" | "empty" | "failed" | "planned" | undefined;
  images?: number | undefined;
  convertedImages?: string[] | undefined;
  publish?: "published" | "already-published" | "unpublished" | "unavailable" | "not-published" | "failed" | undefined;
  error?: string | undefined;
};

export type TImportReport = {
  startedAt: string;
  finishedAt?: string | undefined;
  dryRun: boolean;
  source: string;
  workspaceSlug?: string | undefined;
  baseUrl?: string | undefined;
  summary: Record<string, number>;
  visibility: Record<string, { public: number; private: number }>;
  pages: TReportPage[];
  warnings: TWarning[];
  publishPending: string[];
};

export function summarize(report: TImportReport): void {
  const summary: Record<string, number> = { total: report.pages.length };
  const visibility: TImportReport["visibility"] = {};
  for (const page of report.pages) {
    summary[page.action] = (summary[page.action] ?? 0) + 1;
    if (page.content) summary[`content_${page.content}`] = (summary[`content_${page.content}`] ?? 0) + 1;
    if (page.publish) summary[`publish_${page.publish}`] = (summary[`publish_${page.publish}`] ?? 0) + 1;
    summary.images = (summary.images ?? 0) + (page.images ?? 0);
    const top = page.path.includes("/") || page.kind === "folder" ? (page.path.split("/")[0] ?? "") : "(root)";
    const bucket = (visibility[top] ??= { public: 0, private: 0 });
    bucket[page.visibility]++;
  }
  summary.warnings = report.warnings.length;
  report.summary = summary;
  report.visibility = visibility;
}

export function renderMarkdownReport(report: TImportReport): string {
  const lines: string[] = [];
  lines.push(`# Wiki.js → Plane import ${report.dryRun ? "(dry run)" : ""}`.trim(), "");
  lines.push(`- Source: \`${report.source}\``);
  if (report.baseUrl) lines.push(`- Plane: ${report.baseUrl} (workspace \`${report.workspaceSlug}\`)`);
  lines.push(`- Started: ${report.startedAt}`, `- Finished: ${report.finishedAt ?? "-"}`, "");
  lines.push("## Summary", "", "| Metric | Count |", "| --- | --- |");
  for (const [key, value] of Object.entries(report.summary)) lines.push(`| ${key} | ${value} |`);
  lines.push("", "## Visibility per top-level folder", "", "| Folder | Public | Private |", "| --- | --- | --- |");
  for (const [folder, counts] of Object.entries(report.visibility)) {
    lines.push(`| ${folder} | ${counts.public} | ${counts.private} |`);
  }
  if (report.publishPending.length) {
    lines.push("", "## Pages still to publish (publish endpoint unavailable)", "");
    for (const path of report.publishPending) lines.push(`- ${path}`);
  }
  lines.push("", "## Pages", "", "| Path | Title | Visibility | Action | Content | Images | Publish |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const page of report.pages) {
    const cells = [
      `\`${page.path}\`${page.kind === "folder" ? " (folder)" : ""}`,
      page.title.replace(/\|/g, "\\|"),
      `${page.visibility} (${page.visibilityReason})`,
      page.action + (page.error ? `: ${page.error.replace(/\|/g, "\\|").slice(0, 120)}` : ""),
      page.content ?? "",
      String(page.images ?? 0) + (page.convertedImages?.length ? ` (${page.convertedImages.length} converted)` : ""),
      page.publish ?? "",
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("", `## Warnings (${report.warnings.length})`, "");
  for (const warning of report.warnings) lines.push(`- \`${warning.path || "(global)"}\`: ${warning.message}`);
  return `${lines.join("\n")}\n`;
}
