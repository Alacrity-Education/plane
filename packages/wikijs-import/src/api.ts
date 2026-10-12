/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- retries are sequential by design */
import type { TPreparedImage } from "./images";

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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses a raw `Cookie` header value (`a=1; b=2`). */
export function parseCookieHeader(raw: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return jar;
}

/**
 * Session-authenticated client for the Plane app API (the same endpoints the web app uses).
 * Django session auth needs the session cookie plus the CSRF token echoed in `X-CSRFToken`.
 */
export class PlaneSession {
  private readonly cookies: Map<string, string>;
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    cookieHeader = "",
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cookies = parseCookieHeader(cookieHeader);
  }

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response): void {
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const [pair = "", ...attributes] = cookie.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
      ...extra,
    };
    const cookie = this.cookieHeader;
    if (cookie) headers.Cookie = cookie;
    const csrf = this.cookies.get("csrftoken");
    if (csrf) headers["X-CSRFToken"] = csrf;
    return headers;
  }

  async request(
    method: string,
    path: string,
    options: { json?: unknown; form?: URLSearchParams; redirect?: "follow" | "manual"; allowStatus?: number[] } = {}
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      const extra: Record<string, string> = {};
      let body: string | undefined;
      if (options.json !== undefined) {
        extra["Content-Type"] = "application/json";
        body = JSON.stringify(options.json);
      } else if (options.form) {
        extra["Content-Type"] = "application/x-www-form-urlencoded";
        body = options.form.toString();
      }
      const response = await this.fetchImpl(url, {
        method,
        headers: this.headers(extra),
        ...(body !== undefined ? { body } : {}),
        redirect: options.redirect ?? "follow",
      });
      this.absorb(response);
      if (RETRYABLE_STATUS.has(response.status) && attempt < 5) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (response.status >= 400 && !options.allowStatus?.includes(response.status)) {
        throw new PlaneApiError(response.status, `${method} ${url}`, await response.text());
      }
      return response;
    }
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, { json: body });
    const textBody = await response.text();
    return (textBody ? JSON.parse(textBody) : {}) as T;
  }

  /** Signs in with email + password (the web app's form post) and keeps the session cookie. */
  async login(email: string, password: string): Promise<void> {
    const tokenResponse = await this.request("GET", "/auth/get-csrf-token/");
    const { csrf_token: token } = (await tokenResponse.json()) as { csrf_token: string };
    const form = new URLSearchParams({ csrfmiddlewaretoken: token, email, password });
    const response = await this.request("POST", "/auth/sign-in/", {
      form,
      redirect: "manual",
      allowStatus: [302, 303],
    });
    const location = response.headers.get("location") ?? "";
    const error = /[?&]error_code=([^&]+)/.exec(location)?.[1];
    if (error) {
      const message = /[?&]error_message=([^&]+)/.exec(location)?.[1];
      throw new Error(`sign-in failed: ${decodeURIComponent(message ?? error)}`);
    }
    await this.assertAuthenticated();
  }

  async assertAuthenticated(): Promise<{ email: string }> {
    const response = await this.request("GET", "/api/users/me/", { allowStatus: [401, 403] });
    if (response.status !== 200) {
      throw new Error(`not authenticated (HTTP ${response.status}); check PLANE_SESSION_COOKIE or the login`);
    }
    // Make sure a CSRF cookie exists for the writes that follow
    if (!this.cookies.has("csrftoken")) await this.request("GET", "/auth/get-csrf-token/");
    return (await response.json()) as { email: string };
  }
}

/** Upload limit the instance advertises (`FILE_SIZE_LIMIT`, 5 MiB by default). */
export async function fetchFileSizeLimit(session: PlaneSession): Promise<number | null> {
  try {
    const config = await session.json<{ config?: { file_size_limit?: number } }>("GET", "/api/instances/");
    const limit = Number(config.config?.file_size_limit);
    return limit > 0 ? limit : null;
  } catch {
    return null;
  }
}

export type TPlanePage = {
  id: string;
  name: string;
  parent: string | null;
  sort_order: number;
  access: number;
  is_published?: boolean;
  archived_at: string | null;
  owned_by: string;
};

export type TPublishResult = "published" | "unpublished" | "unavailable";

/** Workspace wiki endpoints. */
export class PlaneWikiApi {
  constructor(
    private readonly session: PlaneSession,
    readonly workspaceSlug: string
  ) {}

  private get base(): string {
    return `/api/workspaces/${encodeURIComponent(this.workspaceSlug)}/wiki/pages`;
  }

  listPages(): Promise<TPlanePage[]> {
    return this.session.json<TPlanePage[]>("GET", `${this.base}/?type=all`);
  }

  createPage(body: { name: string; parent: string | null; sort_order: number; access: number }): Promise<TPlanePage> {
    return this.session.json<TPlanePage>("POST", `${this.base}/`, { ...body, description_html: "<p></p>" });
  }

  updatePage(
    id: string,
    body: Partial<Pick<TPlanePage, "name" | "parent" | "sort_order" | "access">>
  ): Promise<TPlanePage> {
    return this.session.json<TPlanePage>("PATCH", `${this.base}/${id}/`, body);
  }

  async updateDescription(id: string, body: object): Promise<void> {
    await this.session.json("PATCH", `${this.base}/${id}/description/`, body);
  }

  /** Publishes (or with `publish=false` unpublishes) a page on the docs site. */
  async setPublished(id: string, publish: boolean): Promise<TPublishResult> {
    const response = await this.session.request(publish ? "POST" : "DELETE", `${this.base}/${id}/publish/`, {
      allowStatus: [404, 405],
    });
    if (response.status === 404 || response.status === 405) {
      const body = await response.text();
      // A 404 with a JSON error from the view means the page is missing, not the route
      if (response.status === 404 && /"error"/.test(body) && !/<html/i.test(body)) {
        throw new PlaneApiError(404, `publish ${id}`, body);
      }
      return "unavailable";
    }
    return publish ? "published" : "unpublished";
  }

  /** Uploads an image as a PAGE_DESCRIPTION asset of the page; returns the asset id. */
  async uploadPageImage(pageId: string, image: TPreparedImage): Promise<string> {
    const slug = encodeURIComponent(this.workspaceSlug);
    const signed = await this.session.json<{
      asset_id: string;
      upload_data: { url: string; fields: Record<string, string> };
    }>("POST", `/api/assets/v2/workspaces/${slug}/`, {
      name: image.name,
      type: image.mime,
      size: image.data.length,
      entity_type: "PAGE_DESCRIPTION",
      entity_identifier: pageId,
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(signed.upload_data.fields)) form.append(key, value);
    form.append("file", new Blob([new Uint8Array(image.data)], { type: image.mime }), image.name);
    const uploadUrl = new URL(signed.upload_data.url, `${this.session.baseUrl}/`).toString();
    const upload = await fetch(uploadUrl, { method: "POST", body: form });
    if (!upload.ok) {
      const body = await upload.text();
      // Drop the asset row that never received its file
      await this.session
        .request("DELETE", `/api/assets/v2/workspaces/${slug}/${signed.asset_id}/`, { allowStatus: [404] })
        .catch(() => undefined);
      throw new PlaneApiError(upload.status, `upload ${uploadUrl}`, /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? body);
    }
    await this.session.request("PATCH", `/api/assets/v2/workspaces/${slug}/${signed.asset_id}/`, {
      json: { attributes: { name: image.name, type: image.mime, size: image.data.length } },
    });
    return signed.asset_id;
  }
}
