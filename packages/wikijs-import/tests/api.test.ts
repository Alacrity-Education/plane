/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCookieHeader, PlaneSession, PlaneWikiApi } from "../src/api";

describe("PlaneSession", () => {
  it("parses a browser Cookie header", () => {
    expect([...parseCookieHeader("session-id=abc; csrftoken=tok=1;  theme=dark")]).toEqual([
      ["session-id", "abc"],
      ["csrftoken", "tok=1"],
      ["theme", "dark"],
    ]);
  });

  it("sends the session cookie, CSRF header and XHR marker, and keeps new cookies", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "csrftoken=rotated; Path=/");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }) as unknown as typeof fetch;
    const session = new PlaneSession("http://plane.test/", "session-id=s1; csrftoken=c1", fakeFetch);
    await session.json("PATCH", "/api/x/", { a: 1 });
    await session.json("GET", "/api/y/");
    const first = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("http://plane.test/api/x/");
    expect(first.Cookie).toBe("session-id=s1; csrftoken=c1");
    expect(first["X-CSRFToken"]).toBe("c1");
    expect(first["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(first["Content-Type"]).toBe("application/json");
    const second = calls[1]?.init.headers as Record<string, string>;
    expect(second["X-CSRFToken"]).toBe("rotated");
  });

  it("raises PlaneApiError on failures", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const session = new PlaneSession("http://plane.test", "", fakeFetch);
    await expect(session.json("GET", "/api/z/")).rejects.toThrow(/403/);
  });
});

describe("PlaneWikiApi.uploadWorkspaceFile (v1, API key)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs with the API key, uploads (via the Plane origin when the storage host is internal) and marks it uploaded", async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      });
      if (url === "http://plane.test/api/v1/workspaces/ws/assets/" && init.method === "POST") {
        return Response.json({
          asset_id: "asset-1",
          upload_data: {
            url: "http://minio-internal:9000/uploads",
            fields: { key: "k", "Content-Type": "image/svg+xml" },
          },
        });
      }
      if (url.startsWith("http://minio-internal")) throw new TypeError("fetch failed");
      if (url === "http://plane.test/uploads") return new Response(null, { status: 204 });
      if (url === "http://plane.test/api/v1/workspaces/ws/assets/asset-1/") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });
    const api = new PlaneWikiApi(new PlaneSession("http://plane.test"), "ws", "plane_api_key");
    expect(api.canUploadAnyFile).toBe(true);
    const id = await api.uploadWorkspaceFile({ name: "logo.svg", mime: "image/svg+xml", data: Buffer.from("<svg/>") });
    expect(id).toBe("asset-1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST http://plane.test/api/v1/workspaces/ws/assets/",
      "POST http://minio-internal:9000/uploads",
      "POST http://plane.test/uploads",
      "PATCH http://plane.test/api/v1/workspaces/ws/assets/asset-1/",
    ]);
    expect(calls[0]?.headers["X-Api-Key"]).toBe("plane_api_key");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ name: "logo.svg", type: "image/svg+xml", size: 6 });
    expect(JSON.parse(String(calls[3]?.body))).toEqual({ is_uploaded: true });
    const form = calls[2]?.body as FormData;
    expect(form.get("key")).toBe("k");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("refuses without an API key", async () => {
    const api = new PlaneWikiApi(new PlaneSession("http://plane.test"), "ws");
    expect(api.canUploadAnyFile).toBe(false);
    await expect(
      api.uploadWorkspaceFile({ name: "a.pdf", mime: "application/pdf", data: Buffer.from("x") })
    ).rejects.toThrow(/PLANE_API_KEY/);
  });
});
