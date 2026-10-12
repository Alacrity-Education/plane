/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchFileSizeLimit, PlaneSession, PlaneWikiApi } from "./api";
import { defaultCacheDir, runImport } from "./importer";
import { renderMarkdownReport } from "./report";
import { ensureDir } from "./images";
import { parseProjectMap } from "./projects";
import { loadState } from "./state";
import type { TWarning } from "./types";
import { exportWikiJs } from "./wikijs-live";

export const USAGE = `Usage: plane-wikijs-import (--source <wiki.js repo> | --wikijs-url <url>) [options]

Options:
  --source <dir>          Wiki.js git-sync repository
  --wikijs-url <url>      Export the live Wiki.js (GraphQL API, token in WIKIJS_TOKEN) into the
                          --wikijs-cache folder and import from there instead of --source
  --wikijs-cache <dir>    Folder for the live export (default: wikijs-source next to the state file)
  --dry-run               Print the page tree with the resolved visibility; no writes
  --only <path prefix>    Only import pages under this Wiki.js path (e.g. Courses/AirboxBootcamp)
  --state <file>          State file (default .wikijs-import/state.json)
  --report <file>         Report file; writes <file> (JSON) and <file>.md (default .wikijs-import/report.json)
  --force                 Rewrite page descriptions even when unchanged since the last run
  --prune                 Archive the pages of earlier runs that are no longer in the source
                          (without it they are only listed in the report)
  --project-map <json>    JSON object { "<Wiki.js path>": "<project identifier or name>" } placing
                          Projects/ pages into those projects' wiki sections (else matched by name)
  --create-missing-projects
                          Create a Plane project for every Projects/ page that matches none
  --no-project-sections   Never match Projects/ pages to Plane projects: keep them all under the
                          plain "Projects" folder page (move them into projects by hand later)
  --adopt                 Without a state entry, reuse an existing page with the same name and
                          parent instead of creating one (recovery after losing the state file)
  --login-email <email>   Sign in with email/password instead of a session cookie
  --login-password <pw>   (or PLANE_LOGIN_EMAIL / PLANE_LOGIN_PASSWORD)
  -h, --help              Show this help

Environment:
  PLANE_URL               Plane API origin, e.g. https://plane.example.com (dev: http://localhost:8000)
  PLANE_WORKSPACE_SLUG    Target workspace slug
  PLANE_SESSION_COOKIE    Raw Cookie header copied from a signed-in browser (session-id=…; csrftoken=…)
  PLANE_API_KEY           Optional Plane API key (Profile settings → API tokens) of the same user: needed
                          to upload linked files other than PNG/JPEG/GIF/WebP (SVG, PDF, archives…)
  WIKIJS_TOKEN            Wiki.js API key for --wikijs-url (Administration → API Access)
`;

const DEFAULT_FILE_SIZE_LIMIT = 5 * 1024 * 1024;

export type TMainIo = {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export async function main(argv: string[], io: TMainIo): Promise<number> {
  const sourceWarnings: TWarning[] = [];
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      "wikijs-url": { type: "string" },
      "wikijs-cache": { type: "string" },
      prune: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      only: { type: "string" },
      state: { type: "string", default: ".wikijs-import/state.json" },
      report: { type: "string", default: ".wikijs-import/report.json" },
      force: { type: "boolean", default: false },
      adopt: { type: "boolean", default: false },
      "project-map": { type: "string" },
      "create-missing-projects": { type: "boolean", default: false },
      "no-project-sections": { type: "boolean", default: false },
      "login-email": { type: "string" },
      "login-password": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const dryRun = values["dry-run"] ?? false;
  const statePath = resolve(values.state ?? ".wikijs-import/state.json");
  const wikijsUrl = values["wikijs-url"]?.replace(/\/+$/, "");
  if (!values.source === !wikijsUrl) {
    io.stderr("pass either --source or --wikijs-url\n");
    io.stderr(USAGE);
    return 2;
  }
  let sourceDir: string;
  if (wikijsUrl) {
    const token = io.env.WIKIJS_TOKEN?.trim();
    if (!token) {
      io.stderr("--wikijs-url needs the Wiki.js API key in WIKIJS_TOKEN");
      return 2;
    }
    sourceDir = resolve(values["wikijs-cache"] ?? join(dirname(statePath), "wikijs-source"));
    const exportWarnings: TWarning[] = [];
    try {
      await exportWikiJs({ baseUrl: wikijsUrl, token, outDir: sourceDir, warnings: exportWarnings, log: io.stdout });
    } catch (error) {
      io.stderr(`Wiki.js export failed: ${(error as Error).message}`);
      return 1;
    }
    for (const warning of exportWarnings) io.stdout(`warning  ${warning.path}: ${warning.message}`);
    sourceWarnings.push(...exportWarnings);
  } else {
    sourceDir = resolve(values.source ?? "");
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      io.stderr(`source directory not found: ${sourceDir}`);
      return 2;
    }
  }
  const reportPath = resolve(values.report ?? ".wikijs-import/report.json");
  const baseUrl = io.env.PLANE_URL?.replace(/\/+$/, "");
  const workspaceSlug = io.env.PLANE_WORKSPACE_SLUG ?? "";

  let api: PlaneWikiApi | undefined;
  let maxImageBytes = DEFAULT_FILE_SIZE_LIMIT;
  const state = loadState(statePath);
  const email = values["login-email"] ?? io.env.PLANE_LOGIN_EMAIL;
  const password = values["login-password"] ?? io.env.PLANE_LOGIN_PASSWORD;
  const hasCredentials = !!(email && password) || !!io.env.PLANE_SESSION_COOKIE;
  let projectMap: Map<string, string> | undefined;
  if (values["project-map"]) {
    projectMap = parseProjectMap(JSON.parse(readFileSync(resolve(values["project-map"]), "utf8")));
  }
  // A dry run with credentials connects read-only, to show how project pages match projects
  if (!dryRun || (baseUrl && workspaceSlug && hasCredentials)) {
    if (!baseUrl || !workspaceSlug) {
      io.stderr("PLANE_URL and PLANE_WORKSPACE_SLUG are required (or use --dry-run)");
      return 2;
    }
    if (state.workspaceSlug && (state.workspaceSlug !== workspaceSlug || state.baseUrl !== baseUrl)) {
      io.stderr(
        `state file ${statePath} belongs to ${state.baseUrl} / ${state.workspaceSlug}; use another --state for ${baseUrl} / ${workspaceSlug}`
      );
      return 2;
    }
    if (!dryRun) {
      state.baseUrl = baseUrl;
      state.workspaceSlug = workspaceSlug;
    }
    const session = new PlaneSession(baseUrl, io.env.PLANE_SESSION_COOKIE ?? "");
    if (email && password) {
      await session.login(email, password);
      io.stdout(`Signed in as ${email}`);
    } else if (!io.env.PLANE_SESSION_COOKIE) {
      io.stderr("Set PLANE_SESSION_COOKIE or pass --login-email/--login-password");
      return 2;
    } else {
      const me = await session.assertAuthenticated();
      io.stdout(`Authenticated as ${me.email}`);
    }
    const apiKey = io.env.PLANE_API_KEY?.trim() || undefined;
    if (apiKey) {
      const check = await fetch(`${baseUrl}/api/v1/users/me/`, { headers: { "X-Api-Key": apiKey } });
      if (!check.ok) {
        io.stderr(`PLANE_API_KEY was rejected by ${baseUrl} (HTTP ${check.status})`);
        return 2;
      }
    }
    api = new PlaneWikiApi(session, workspaceSlug, apiKey);
    maxImageBytes = (await fetchFileSizeLimit(session)) ?? DEFAULT_FILE_SIZE_LIMIT;
  }

  const report = await runImport({
    sourceDir,
    dryRun,
    only: values.only,
    force: values.force,
    prune: values.prune,
    adopt: values.adopt,
    projectMap,
    createMissingProjects: values["create-missing-projects"],
    noProjectSections: values["no-project-sections"],
    statePath,
    state,
    cacheDir: defaultCacheDir(statePath),
    maxImageBytes,
    api,
    canUploadAnyFile: !!io.env.PLANE_API_KEY?.trim(),
    workspaceSlug: workspaceSlug || "<workspace>",
    baseUrl,
    log: io.stdout,
  });

  report.warnings.unshift(...sourceWarnings);
  report.summary.warnings = report.warnings.length;
  ensureDir(reportPath);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdownPath = reportPath.replace(/\.json$/i, "") + ".md";
  writeFileSync(markdownPath, renderMarkdownReport(report));

  io.stdout("");
  io.stdout(
    `Summary: ${Object.entries(report.summary)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
  for (const [folder, counts] of Object.entries(report.visibility)) {
    io.stdout(`  ${folder}: ${counts.public} public, ${counts.members} members only, ${counts.admins} admins only`);
  }
  const unmatched = report.projects.filter((p) => !p.project);
  if (report.projects.length) {
    io.stdout(`Project pages: ${report.projects.length - unmatched.length} matched, ${unmatched.length} unmatched`);
    for (const p of unmatched) io.stdout(`  unmatched ${p.path} → add ${p.suggestion} to --project-map`);
  }
  if (report.publishPending.length) io.stdout(`Pages waiting to be published: ${report.publishPending.length}`);
  io.stdout(`Report: ${reportPath} and ${markdownPath}`);
  const failed = report.pages.filter((p) => p.action === "failed" || p.content === "failed" || p.publish === "failed");
  return failed.length ? 1 : 0;
}
