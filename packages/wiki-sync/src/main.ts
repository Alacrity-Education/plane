/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PlaneApiClient } from "./api";
import { FixtureSource } from "./fixture";
import { runSync } from "./sync";
import type { IWikiSource, TCalloutMode } from "./types";

const VERSION = "0.3.1";

const HELP = `plane-wiki-sync ${VERSION}

Export the public pages of a Plane workspace Wiki into a Docusaurus docs folder
(CommonMark .md files + _category_.json) and download their images.

Usage:
  plane-wiki-sync [options]

Environment:
  PLANE_URL              Plane base URL, e.g. https://plane.example.com (required)
  PLANE_WORKSPACE_SLUG   Workspace slug (required)
  PLANE_API_KEY          API token sent as X-Api-Key (required)

Options:
  --out <dir>            Docs instance folder                 (default: wiki)
  --assets <dir>         Folder for images and linked files   (default: static/wiki-assets)
  --public-path <path>   URL of the assets folder on the site (default: /wiki-assets)
  --route-base <path>    routeBasePath of the docs instance   (default: /wiki)
  --base-url <path>      Docusaurus baseUrl, e.g. /my-repo/    (default: $DOCS_BASE_URL or /)
  --cache <file>         Manifest used for incremental runs   (default: .wiki-cache/manifest.json)
  --concurrency <n>      Parallel API requests                (default: 5)
  --callouts <mode>      admonition | html                    (default: admonition)
  --projects-dir <name>  Folder for project wiki sections     (default: projects)
  --projects-label <txt> Sidebar label of that folder         (default: Projects)
  --force                Re-render every page, ignoring the manifest
  --from-fixture <file>  Read pages from a JSON fixture instead of the API (no env needed)
  -h, --help             Show this help
  -v, --version          Show the version
`;

type TCliIO = {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export async function main(argv: string[], io: TCliIO): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        out: { type: "string", default: "wiki" },
        assets: { type: "string", default: "static/wiki-assets" },
        "public-path": { type: "string", default: "/wiki-assets" },
        "route-base": { type: "string", default: "/wiki" },
        "base-url": { type: "string" },
        cache: { type: "string", default: ".wiki-cache/manifest.json" },
        concurrency: { type: "string", default: "5" },
        callouts: { type: "string", default: "admonition" },
        "projects-dir": { type: "string", default: "projects" },
        "projects-label": { type: "string", default: "Projects" },
        force: { type: "boolean", default: false },
        "from-fixture": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (values.help) {
    io.stdout(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout(VERSION);
    return 0;
  }

  const callouts = values.callouts as TCalloutMode;
  if (callouts !== "admonition" && callouts !== "html") {
    io.stderr(`--callouts must be "admonition" or "html", got "${values.callouts}"`);
    return 2;
  }
  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    io.stderr(`--concurrency must be a positive integer, got "${values.concurrency}"`);
    return 2;
  }

  const baseUrl = (values["base-url"] ?? io.env.DOCS_BASE_URL ?? "/").trim() || "/";
  if (!baseUrl.startsWith("/") || baseUrl.startsWith("//")) {
    io.stderr(`--base-url must be a root-relative path such as "/" or "/my-repo/", got "${baseUrl}"`);
    return 2;
  }

  const projectsDir = values["projects-dir"].trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(projectsDir)) {
    io.stderr(`--projects-dir must be a single folder name ([A-Za-z0-9._-]), got "${values["projects-dir"]}"`);
    return 2;
  }
  const projectsLabel = values["projects-label"].trim();
  if (!projectsLabel) {
    io.stderr("--projects-label must not be empty");
    return 2;
  }

  let source: IWikiSource;
  let planeUrl = io.env.PLANE_URL?.trim() ?? "";
  let workspaceSlug = io.env.PLANE_WORKSPACE_SLUG?.trim() ?? "";
  if (values["from-fixture"]) {
    const fixture = await FixtureSource.fromFile(values["from-fixture"]);
    planeUrl ||= fixture.fixture.planeUrl ?? "https://plane.example.com";
    workspaceSlug ||= fixture.fixture.workspaceSlug ?? "workspace";
    source = fixture;
  } else {
    const apiKey = io.env.PLANE_API_KEY?.trim() ?? "";
    const missing = [
      !planeUrl && "PLANE_URL",
      !workspaceSlug && "PLANE_WORKSPACE_SLUG",
      !apiKey && "PLANE_API_KEY",
    ].filter(Boolean);
    if (missing.length) {
      io.stderr(`Missing environment variable(s): ${missing.join(", ")}\n\n${HELP}`);
      return 2;
    }
    source = new PlaneApiClient({ baseUrl: planeUrl, workspaceSlug, apiKey });
  }

  try {
    await runSync({
      source,
      planeUrl: planeUrl.replace(/\/+$/, ""),
      workspaceSlug,
      outDir: resolve(values.out),
      assetsDir: resolve(values.assets),
      publicPath: values["public-path"],
      routeBasePath: values["route-base"],
      baseUrl,
      cachePath: resolve(values.cache),
      concurrency,
      callouts,
      projectsDir,
      projectsLabel,
      force: values.force,
      logger: { info: (m) => io.stdout(m), warn: (m) => io.stderr(`warning: ${m}`) },
    });
    return 0;
  } catch (error) {
    io.stderr(`plane-wiki-sync failed: ${(error as Error).message}`);
    return 1;
  }
}
