/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- retries and cursor pages are sequential by design */
import type {
  IWikiSource,
  TAssetUrlResponse,
  TDownloadedFile,
  TPaginatedResponse,
  TWikiMember,
  TWikiPageDetail,
  TWikiPageSummary,
} from "./types";

export class PlaneApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, body: string) {
    super(`Plane API ${status} for ${url}${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.name = "PlaneApiError";
    this.status = status;
    this.url = url;
  }
}

export type TPlaneApiClientOptions = {
  baseUrl: string;
  workspaceSlug: string;
  apiKey: string;
  perPage?: number;
  /** Retries for 429 and transient 502/503/504 responses. */
  maxRetries?: number;
  /** Upper bound for a single wait, in ms. */
  maxWaitMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying a throttled request. Plane's ApiKeyRateThrottle sets
 * X-RateLimit-Reset to a unix timestamp in seconds; DRF may also send Retry-After (seconds).
 */
export function getRetryDelayMs(headers: Headers, attempt: number, nowMs: number): number {
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+(\.\d+)?$/.test(reset.trim())) {
    const resetSeconds = Number(reset);
    // A small value is a relative number of seconds, a large one a unix timestamp.
    const delay = resetSeconds > 1e9 ? resetSeconds * 1000 - nowMs : resetSeconds * 1000;
    if (delay > 0) return Math.ceil(delay) + 250;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim())) return Math.ceil(Number(retryAfter) * 1000);
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export class PlaneApiClient implements IWikiSource {
  private readonly baseUrl: string;
  private readonly workspaceSlug: string;
  private readonly apiKey: string;
  private readonly perPage: number;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: TPlaneApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.workspaceSlug = options.workspaceSlug;
    this.apiKey = options.apiKey;
    this.perPage = options.perPage ?? 100;
    this.maxRetries = options.maxRetries ?? 6;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private workspaceUrl(path: string): string {
    return `${this.baseUrl}/api/v1/workspaces/${encodeURIComponent(this.workspaceSlug)}/${path}`;
  }

  /** GET with X-Api-Key and retry on throttling / transient gateway errors. */
  async request<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
      });
      if (response.ok) return (await response.json()) as T;
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const delay = Math.min(getRetryDelayMs(response.headers, attempt, this.now()), this.maxWaitMs);
        await response.body?.cancel().catch(() => undefined);
        await this.sleep(delay);
        continue;
      }
      const body = await response.text().catch(() => "");
      throw new PlaneApiError(response.status, url, body);
    }
  }

  /** Walks a v1 cursor-paginated endpoint until next_page_results is false. */
  async listAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const results: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ per_page: String(this.perPage), ...params });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<TPaginatedResponse<T>>(`${this.workspaceUrl(path)}?${query.toString()}`);
      results.push(...(page.results ?? []));
      const next = page.next_cursor;
      if (!page.next_page_results || !next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return results;
  }

  listPages(options: { updatedSince?: string } = {}): Promise<TWikiPageSummary[]> {
    const params: Record<string, string> = { order_by: "sort_order" };
    if (options.updatedSince) params.updated_since = options.updatedSince;
    return this.listAll<TWikiPageSummary>("wiki/pages/", params);
  }

  getPage(pageId: string): Promise<TWikiPageDetail> {
    return this.request<TWikiPageDetail>(this.workspaceUrl(`wiki/pages/${encodeURIComponent(pageId)}/`));
  }

  getAssetUrl(assetId: string): Promise<TAssetUrlResponse> {
    return this.request<TAssetUrlResponse>(this.workspaceUrl(`assets/${encodeURIComponent(assetId)}/`));
  }

  async listMembers(): Promise<TWikiMember[]> {
    try {
      const members = await this.listAll<TWikiMember>("members-lite/");
      return members.filter((m) => m && m.id && m.display_name);
    } catch (error) {
      if (error instanceof PlaneApiError && [401, 403, 404].includes(error.status)) return [];
      throw error;
    }
  }

  /**
   * Downloads a presigned asset URL. The API key is deliberately NOT sent: the URL points at the
   * object store, not at Plane.
   */
  async download(url: string): Promise<TDownloadedFile> {
    const absolute = new URL(url, `${this.baseUrl}/`).toString();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(absolute);
      if (response.ok) {
        return {
          data: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("content-type"),
        };
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        await response.body?.cancel().catch(() => undefined);
        await this.sleep(Math.min(getRetryDelayMs(response.headers, attempt, this.now()), this.maxWaitMs));
        continue;
      }
      throw new PlaneApiError(response.status, absolute.split("?")[0] ?? absolute, "");
    }
  }
}
