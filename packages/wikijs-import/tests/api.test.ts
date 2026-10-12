/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { parseCookieHeader, PlaneSession } from "../src/api";

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
