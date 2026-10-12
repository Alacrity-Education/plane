/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main";
import { readSourcePages } from "../src/source";
import type { TWarning } from "../src/types";
import { exportWikiJs, quotePath } from "../src/wikijs-live";

const BASE = "https://wiki.example.com";
const TOKEN = "secret-token";

const PAGES: Record<number, object> = {
  1: {
    path: "home",
    title: "Home",
    description: "Start here",
    editor: "markdown",
    isPublished: true,
    tags: [{ tag: "public" }, { tag: "intro" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    content: "# Hi\n\n![a](/Courses/a%20b.png) ![logo](/logo.png) ![gone](/gone.png)\n\n",
  },
  2: {
    path: "Courses/legacy",
    title: "Legacy",
    description: "",
    editor: "ckeditor",
    isPublished: false,
    tags: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-02-02T00:00:00.000Z",
    content: '<p><img src="/html.png"></p><p><img src="/page.png"></p>',
  },
};

/** Wiki.js stand-in: GraphQL plus files; unknown paths answer with the HTML app shell, like Wiki.js. */
function fakeWikiJs() {
  const requests: { url: string; auth: string | null }[] = [];
  const files: Record<string, string> = {
    "/logo.png": "LOGO",
    "/Courses/a%20b.png": "AB",
    "/courses/diagrams/flow.svg": "<svg/>",
    "/html.png": "HTML-IMG",
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, auth });
    if (url === `${BASE}/graphql`) {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { id?: number; f?: number };
      };
      let data: object;
      if (query.includes("list(limit")) data = { pages: { list: [{ id: 1 }, { id: 2 }] } };
      else if (query.includes("single(")) data = { pages: { single: PAGES[variables.id ?? 0] } };
      else if (query.includes("folders(")) {
        data = {
          assets: {
            folders:
              variables.f === 0 ? [{ id: 7, slug: "courses" }] : variables.f === 7 ? [{ id: 8, slug: "diagrams" }] : [],
          },
        };
      } else {
        const lists: Record<number, { filename: string }[]> = {
          0: [{ filename: "logo.png" }],
          7: [],
          8: [{ filename: "flow.svg" }],
        };
        data = { assets: { list: lists[variables.f ?? 0] ?? [] } };
      }
      return Response.json({ data });
    }
    const path = url.slice(BASE.length);
    if (path === "/page.png") return new Response("<html>app</html>", { headers: { "content-type": "text/html" } });
    const body = files[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("exportWikiJs", () => {
  it("writes the git-sync layout, downloads referenced files and reports the missing ones", async () => {
    const out = mkdtempSync(join(tmpdir(), "wikijs-live-"));
    // a page deleted in Wiki.js since the last export must disappear; assets are kept
    mkdirSync(join(out, "Old"), { recursive: true });
    writeFileSync(join(out, "Old/removed.md"), "---\ntitle: Removed\n---\n");
    writeFileSync(join(out, "kept.png"), "KEPT");
    const { fetchImpl, requests } = fakeWikiJs();
    const warnings: TWarning[] = [];

    const result = await exportWikiJs({ baseUrl: `${BASE}/`, token: TOKEN, outDir: out, warnings, fetchImpl });

    expect(readFileSync(join(out, "home.md"), "utf8")).toBe(
      "---\ntitle: Home\ndescription: Start here\npublished: true\ndate: 2026-02-01T00:00:00.000Z\n" +
        "tags: public, intro\neditor: markdown\ndateCreated: 2026-01-01T00:00:00.000Z\n---\n\n" +
        "# Hi\n\n![a](/Courses/a%20b.png) ![logo](/logo.png) ![gone](/gone.png)\n"
    );
    expect(readFileSync(join(out, "Courses/legacy.html"), "utf8")).toMatch(
      /^<!--\ntitle: Legacy\ndescription: \npublished: false\n.*\neditor: ckeditor\n.*\n-->\n\n<p><img/s
    );
    expect(existsSync(join(out, "Old/removed.md"))).toBe(false);
    // asset database walk (nested folders) and second pass by reference (decoded path)
    expect(readFileSync(join(out, "logo.png"), "utf8")).toBe("LOGO");
    expect(readFileSync(join(out, "courses/diagrams/flow.svg"), "utf8")).toBe("<svg/>");
    expect(readFileSync(join(out, "Courses/a b.png"), "utf8")).toBe("AB");
    expect(readFileSync(join(out, "html.png"), "utf8")).toBe("HTML-IMG");
    expect(readFileSync(join(out, "kept.png"), "utf8")).toBe("KEPT");
    // an HTML answer is not an asset; 404s are warnings
    expect(existsSync(join(out, "page.png"))).toBe(false);
    expect(result.missing).toEqual(["/gone.png: HTTP 404", "/page.png: not an asset"]);
    expect(warnings.map((w) => w.path)).toEqual(["/gone.png", "/page.png"]);
    expect(result).toMatchObject({ pages: 2, assets: 5 });
    // logo.png came from the asset walk: not fetched a second time; every request authenticated
    expect(requests.filter((r) => r.url === `${BASE}/logo.png`)).toHaveLength(1);
    expect(requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);

    // the importer reads the export like a git-sync checkout
    const pages = readSourcePages(out, []);
    expect(pages.map((p) => [p.path, p.format, p.meta.published]).toSorted()).toEqual([
      ["Courses/legacy", "html", false],
      ["home", "markdown", true],
    ]);
    expect(pages.find((p) => p.path === "home")?.meta.tags).toEqual(["public", "intro"]);
  });

  it("stops on GraphQL errors", async () => {
    const fetchImpl = (async () => Response.json({ errors: [{ message: "Forbidden" }] })) as unknown as typeof fetch;
    await expect(
      exportWikiJs({
        baseUrl: BASE,
        token: TOKEN,
        outDir: mkdtempSync(join(tmpdir(), "wikijs-live-")),
        warnings: [],
        fetchImpl,
      })
    ).rejects.toThrow("Wiki.js GraphQL error: Forbidden");
  });

  it("quotes paths like Python's urllib", () => {
    expect(quotePath("/a b/ohm's (1)—x.png")).toBe("/a%20b/ohm%27s%20%281%29%E2%80%94x.png");
  });
});

describe("CLI source options", () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const err: string[] = [];
    const code = await main(argv, { env, stdout: () => undefined, stderr: (l) => err.push(l) });
    return { code, err: err.join("\n") };
  };
  it("needs exactly one of --source and --wikijs-url", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["--source", "/tmp", "--wikijs-url", BASE])).err).toContain("either --source or --wikijs-url");
  });
  it("takes the Wiki.js token from WIKIJS_TOKEN only", async () => {
    const { code, err } = await run(["--wikijs-url", BASE, "--dry-run"]);
    expect(code).toBe(2);
    expect(err).toContain("WIKIJS_TOKEN");
  });
});
