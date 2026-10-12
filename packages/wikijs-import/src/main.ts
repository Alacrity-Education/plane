/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchFileSizeLimit, PlaneSession, PlaneWikiApi } from "./api";
import { defaultCacheDir, runImport } from "./importer";
import { renderMarkdownReport } from "./report";
import { ensureDir } from "./images";
import { loadState } from "./state";

export const USAGE = `Usage: plane-wikijs-import --source <wiki.js repo> [options]

Options:
  --source <dir>          Wiki.js git-sync repository (required)
  --dry-run               Print the page tree with the resolved visibility; no writes
  --only <path prefix>    Only import pages under this Wiki.js path (e.g. Courses/AirboxBootcamp)
  --state <file>          State file (default .wikijs-import/state.json)
  --report <file>         Report file; writes <file> (JSON) and <file>.md (default .wikijs-import/report.json)
  --force                 Rewrite page descriptions even when unchanged since the last run
  --adopt                 Without a state entry, reuse an existing page with the same name and
                          parent instead of creating one (recovery after losing the state file)
  --login-email <email>   Sign in with email/password instead of a session cookie
  --login-password <pw>   (or PLANE_LOGIN_EMAIL / PLANE_LOGIN_PASSWORD)
  -h, --help              Show this help

Environment:
  PLANE_URL               Plane API origin, e.g. https://plane.example.com (dev: http://localhost:8000)
  PLANE_WORKSPACE_SLUG    Target workspace slug
  PLANE_SESSION_COOKIE    Raw Cookie header copied from a signed-in browser (session-id=…; csrftoken=…)
`;

const DEFAULT_FILE_SIZE_LIMIT = 5 * 1024 * 1024;

export type TMainIo = {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export async function main(argv: string[], io: TMainIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      only: { type: "string" },
      state: { type: "string", default: ".wikijs-import/state.json" },
      report: { type: "string", default: ".wikijs-import/report.json" },
      force: { type: "boolean", default: false },
      adopt: { type: "boolean", default: false },
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
  if (!values.source) {
    io.stderr("--source is required\n");
    io.stderr(USAGE);
    return 2;
  }
  const sourceDir = resolve(values.source);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    io.stderr(`source directory not found: ${sourceDir}`);
    return 2;
  }
  const dryRun = values["dry-run"] ?? false;
  const statePath = resolve(values.state ?? ".wikijs-import/state.json");
  const reportPath = resolve(values.report ?? ".wikijs-import/report.json");
  const baseUrl = io.env.PLANE_URL?.replace(/\/+$/, "");
  const workspaceSlug = io.env.PLANE_WORKSPACE_SLUG ?? "";

  let api: PlaneWikiApi | undefined;
  let maxImageBytes = DEFAULT_FILE_SIZE_LIMIT;
  const state = loadState(statePath);
  if (!dryRun) {
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
    state.baseUrl = baseUrl;
    state.workspaceSlug = workspaceSlug;
    const session = new PlaneSession(baseUrl, io.env.PLANE_SESSION_COOKIE ?? "");
    const email = values["login-email"] ?? io.env.PLANE_LOGIN_EMAIL;
    const password = values["login-password"] ?? io.env.PLANE_LOGIN_PASSWORD;
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
    api = new PlaneWikiApi(session, workspaceSlug);
    maxImageBytes = (await fetchFileSizeLimit(session)) ?? DEFAULT_FILE_SIZE_LIMIT;
  }

  const report = await runImport({
    sourceDir,
    dryRun,
    only: values.only,
    force: values.force,
    adopt: values.adopt,
    statePath,
    state,
    cacheDir: defaultCacheDir(statePath),
    maxImageBytes,
    api,
    workspaceSlug: workspaceSlug || "<workspace>",
    baseUrl,
    log: io.stdout,
  });

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
    io.stdout(`  ${folder}: ${counts.public} public, ${counts.private} private`);
  }
  if (report.publishPending.length) io.stdout(`Pages waiting to be published: ${report.publishPending.length}`);
  io.stdout(`Report: ${reportPath} and ${markdownPath}`);
  const failed = report.pages.filter((p) => p.action === "failed" || p.content === "failed" || p.publish === "failed");
  return failed.length ? 1 : 0;
}
