/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { accessLabel, planeAccessFor, resolveVisibility } from "../src/visibility";

const meta = (over: Partial<{ published: boolean; tags: string[] }> = {}) => ({ tags: [], ...over });

describe("resolveVisibility", () => {
  it("root pages are public", () => {
    expect(resolveVisibility(["account-setup"], false, meta()).visibility).toBe("public");
  });

  it.each(["Courses", "Infrastructure"])("pages under /%s/ are public", (folder) => {
    expect(resolveVisibility([folder, "page"], false, meta()).visibility).toBe("public");
    expect(resolveVisibility([folder, "deep", "page"], false, meta()).visibility).toBe("public");
  });

  it.each(["Projects", "Activities", "Meetings", "Guides"])("pages under /%s/ are private", (folder) => {
    expect(resolveVisibility([folder, "page"], false, meta()).visibility).toBe("private");
  });

  it.each(["Projects", "Activities", "Meetings", "Guides"])("the public tag opens /%s/ pages", (folder) => {
    const result = resolveVisibility([folder, "page"], false, meta({ tags: ["demo", "Public"] }));
    expect(result).toMatchObject({ visibility: "public", reason: "tag public" });
  });

  it("published: false wins over everything", () => {
    expect(resolveVisibility(["root"], false, meta({ published: false })).visibility).toBe("private");
    expect(resolveVisibility(["Courses", "x"], false, meta({ published: false })).visibility).toBe("private");
    expect(resolveVisibility(["Projects", "x"], false, meta({ published: false, tags: ["public"] })).visibility).toBe(
      "private"
    );
  });

  it("folders inherit the default of their top-level folder", () => {
    expect(resolveVisibility(["Courses"], true).visibility).toBe("public");
    expect(resolveVisibility(["Courses", "Bootcamp"], true).visibility).toBe("public");
    expect(resolveVisibility(["Projects"], true).visibility).toBe("private");
    expect(resolveVisibility(["Meetings", "July"], true).visibility).toBe("private");
  });

  it("matches folder names regardless of case and spaces", () => {
    expect(resolveVisibility(["courses", "x"], false, meta()).visibility).toBe("public");
    expect(resolveVisibility(["PROJECTS", "x"], false, meta()).visibility).toBe("private");
  });

  it("the Board folder and its pages are admins-only, whatever the tags or flags", () => {
    expect(resolveVisibility(["Board"], true).visibility).toBe("admins");
    expect(resolveVisibility(["Board"], true, meta({ tags: ["public"] })).visibility).toBe("admins");
    expect(resolveVisibility(["Board", "minutes"], false, meta()).visibility).toBe("admins");
    expect(resolveVisibility(["board", "2024", "q1"], false, meta({ tags: ["public"] })).visibility).toBe("admins");
    expect(resolveVisibility(["Board", "x"], false, meta({ published: false })).visibility).toBe("admins");
    // a root page called "Board" is not the folder
    expect(resolveVisibility(["Board"], false, meta()).visibility).toBe("public");
  });

  it("maps visibilities to Plane access levels", () => {
    expect(planeAccessFor("public")).toBe(0);
    expect(planeAccessFor("private")).toBe(3);
    expect(planeAccessFor("admins")).toBe(2);
    expect(["public", "private", "admins"].map((v) => accessLabel(v as "public"))).toEqual([
      "public",
      "members",
      "admins",
    ]);
  });

  it("unknown folders default to private", () => {
    const result = resolveVisibility(["Misc", "x"], false, meta());
    expect(result.visibility).toBe("private");
    expect(result.unknownFolder).toBe(true);
  });
});
