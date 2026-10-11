import { describe, expect, it, vi } from "vitest";
import { PlaneApiClient, PlaneApiError, getRetryDelayMs } from "../src/api";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const page = (id: string) => ({ id, name: id, parent: null, sort_order: 1, updated_at: "2026-01-01T00:00:00Z" });

const makeClient = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof PlaneApiClient>[0]> = {}) => {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const client = new PlaneApiClient({
    baseUrl: "https://plane.example.com/",
    workspaceSlug: "acme",
    apiKey: "plane_api_secret",
    fetch: fetchImpl,
    sleep,
    now: () => 1_700_000_000_000,
    ...extra,
  });
  return { client, sleep };
};

describe("PlaneApiClient", () => {
  it("walks the cursor envelope until next_page_results is false", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect(new Headers(init?.headers).get("X-Api-Key")).toBe("plane_api_secret");
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) return json({ results: [page("a"), page("b")], next_cursor: "100:1:0", next_page_results: true });
      if (cursor === "100:1:0") return json({ results: [page("c")], next_cursor: "100:2:0", next_page_results: true });
      return json({ results: [], next_cursor: "100:3:0", next_page_results: false });
    }) as unknown as typeof fetch;

    const { client } = makeClient(fetchImpl);
    const pages = await client.listPages();
    expect(pages.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(urls).toEqual([
      "https://plane.example.com/api/v1/workspaces/acme/wiki/pages/?per_page=100&order_by=sort_order",
      "https://plane.example.com/api/v1/workspaces/acme/wiki/pages/?per_page=100&order_by=sort_order&cursor=100%3A1%3A0",
      "https://plane.example.com/api/v1/workspaces/acme/wiki/pages/?per_page=100&order_by=sort_order&cursor=100%3A2%3A0",
    ]);
  });

  it("stops when the server repeats a cursor", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ results: [page("a")], next_cursor: "100:1:0", next_page_results: true })
    ) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    expect(await client.listPages()).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("passes updated_since", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [], next_page_results: false })) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    await client.listPages({ updatedSince: "2026-10-01T00:00:00Z" });
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toContain("updated_since=2026-10-01T00%3A00%3A00Z");
  });

  it("retries 429 honouring X-RateLimit-Reset (unix seconds)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return json({ detail: "throttled" }, 429, { "X-RateLimit-Reset": String(1_700_000_000 + 7) });
      return json({ ...page("a"), description_html: "<p>x</p>", assets: [] });
    }) as unknown as typeof fetch;
    const { client, sleep } = makeClient(fetchImpl);
    const detail = await client.getPage("a");
    expect(detail.description_html).toBe("<p>x</p>");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7250);
  });

  it("falls back to Retry-After and then exponential backoff", () => {
    const now = 1_700_000_000_000;
    expect(getRetryDelayMs(new Headers({ "Retry-After": "3" }), 0, now)).toBe(3000);
    expect(getRetryDelayMs(new Headers(), 0, now)).toBe(1000);
    expect(getRetryDelayMs(new Headers(), 3, now)).toBe(8000);
    expect(getRetryDelayMs(new Headers({ "X-RateLimit-Reset": "5" }), 0, now)).toBe(5250);
    // reset already in the past -> backoff
    expect(getRetryDelayMs(new Headers({ "X-RateLimit-Reset": String(now / 1000 - 10) }), 1, now)).toBe(2000);
  });

  it("gives up after maxRetries and surfaces the status", async () => {
    const fetchImpl = vi.fn(async () => json({ detail: "slow down" }, 429)) as unknown as typeof fetch;
    const { client, sleep } = makeClient(fetchImpl, { maxRetries: 2 });
    await expect(client.getPage("a")).rejects.toMatchObject({ name: "PlaneApiError", status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx errors", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "Page not found" }, 404)) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    const error = await client.getPage("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlaneApiError);
    expect((error as PlaneApiError).message).toContain("Page not found");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves asset URLs and downloads without leaking the API key", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assets/")) {
        expect(url).toBe("https://plane.example.com/api/v1/workspaces/acme/assets/asset-1/");
        return json({
          asset_id: "asset-1",
          asset_url: "https://s3.example.com/bucket/k?sig=1",
          asset_name: "a.png",
          asset_type: "image/png",
        });
      }
      expect(url).toBe("https://s3.example.com/bucket/k?sig=1");
      expect(new Headers(init?.headers).get("X-Api-Key")).toBeNull();
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    const info = await client.getAssetUrl("asset-1");
    const file = await client.download(info.asset_url);
    expect([...file.data]).toEqual([1, 2, 3]);
    expect(file.contentType).toBe("image/png");
  });

  it("listMembers degrades to [] when the token may not list members", async () => {
    const fetchImpl = vi.fn(async () => json({ detail: "forbidden" }, 403)) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    expect(await client.listMembers()).toEqual([]);
  });
});
