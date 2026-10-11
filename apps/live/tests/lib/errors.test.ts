/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, it, expect } from "vitest";
import { AppError } from "@/lib/errors";

const createAxiosError = (status: number, data: unknown) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  code: "ERR_BAD_REQUEST",
  config: { method: "patch", url: "/api/workspaces/acme/wiki/pages/page-1/description/" },
  response: { status, data },
});

describe("AppError", () => {
  it("retains the API error_code and error_message from an AxiosError", () => {
    const error = new AppError(createAxiosError(400, { error_code: 4701, error_message: "PAGE_LOCKED" }));
    expect(error.statusCode).toBe(400);
    expect(error.apiErrorCode).toBe(4701);
    expect(error.message).toBe("PAGE_LOCKED");
    expect(error.method).toBe("PATCH");
  });

  it("falls back to the body message and then the axios message", () => {
    expect(new AppError(createAxiosError(400, { message: "bad" })).message).toBe("bad");
    const error = new AppError(createAxiosError(413, "Request Entity Too Large"));
    expect(error.message).toBe("Request failed with status code 413");
    expect(error.apiErrorCode).toBeUndefined();
  });

  it("does not keep the rest of the response body", () => {
    const error = new AppError(createAxiosError(400, { error_code: 4702, secret: "x" }));
    expect(error.apiErrorCode).toBe(4702);
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
