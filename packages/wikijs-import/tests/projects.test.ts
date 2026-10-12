/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import {
  decideMergeTarget,
  deriveIdentifier,
  isEmptyDescription,
  matchProject,
  normalizeName,
  parseProjectMap,
  projectPageNodes,
  sanitizeProjectName,
} from "../src/projects";
import type { TPlaneProject } from "../src/projects";
import { buildTree } from "../src/tree";
import { md } from "./helpers";

const projects: TPlaneProject[] = [
  { id: "p1", name: "SPINSPINSPIN", identifier: "SPIN" },
  { id: "p2", name: "AirBoxV1.9", identifier: "AIRBOXV19" },
  { id: "p3", name: "WikiJS", identifier: "WIKI" },
  { id: "p4", name: "Meet Master", identifier: "MEET" },
  { id: "p5", name: "Lab", identifier: "LAB" },
];
const page = (path: string, title: string) => ({ key: path.toLowerCase(), path, title });

describe("normalizeName", () => {
  it("ignores case, spaces, hyphens, underscores and dots", () => {
    expect(normalizeName("AirBox V1.9")).toBe("airboxv19");
    expect(normalizeName("Wiki_JS-fork")).toBe("wikijsfork");
  });
});

describe("matchProject", () => {
  it("matches the title or the file slug against name or identifier", () => {
    expect(matchProject(page("Projects/spinspinspin", "SPINSPINSPIN"), projects).match).toMatchObject({
      project: { id: "p1" },
      via: "exact",
    });
    expect(matchProject(page("Projects/airbox-v19", "AirBox V1.9"), projects).match?.project.id).toBe("p2");
    expect(matchProject(page("Projects/meetmaster", "MeetMaster"), projects).match?.project.id).toBe("p4");
    // identifier
    expect(matchProject(page("Projects/x", "Lab"), projects).match?.project.id).toBe("p5");
  });

  it("falls back to a prefix match on longer titles", () => {
    expect(matchProject(page("Projects/wikijs-fork", "WikiJS Fork"), projects).match).toMatchObject({
      project: { id: "p3" },
      via: "prefix",
    });
  });

  it("does not prefix-match very short names", () => {
    expect(matchProject(page("Projects/lab-automation", "Lab Automation"), projects).match).toBeNull();
  });

  it("leaves unknown pages unmatched", () => {
    expect(matchProject(page("Projects/ongoing_projects", "Ongoing Projects"), projects).match).toBeNull();
  });

  it("reports ambiguous matches", () => {
    const twins = [...projects, { id: "p9", name: "spin spin spin", identifier: "SPIN2" }];
    const result = matchProject(page("Projects/spinspinspin", "SPINSPINSPIN"), twins);
    expect(result.match).toBeNull();
    expect(result.reason).toContain("several projects");
  });

  it("prefers the explicit map (identifier or name)", () => {
    const map = parseProjectMap({ "/Projects/ongoing_projects.md": "lab", "Projects/spinspinspin": "Meet Master" });
    expect(matchProject(page("Projects/ongoing_projects", "Ongoing"), projects, map).match).toMatchObject({
      project: { id: "p5" },
      via: "map",
    });
    expect(matchProject(page("Projects/spinspinspin", "SPINSPINSPIN"), projects, map).match?.project.id).toBe("p4");
    const bad = parseProjectMap({ "Projects/x": "NOPE" });
    expect(matchProject(page("Projects/x", "X"), projects, bad).reason).toContain("matches no project");
    expect(() => parseProjectMap(["x"])).toThrow();
  });
});

describe("projectPageNodes", () => {
  it("returns the direct children of the Projects folder", () => {
    const tree = buildTree(
      [
        md("Projects/a.md", { title: "A" }),
        md("Projects/Sub/b.md", { title: "B" }),
        md("Courses/c.md", { title: "C" }),
      ],
      []
    );
    expect(projectPageNodes(tree.roots).map((n) => n.key)).toEqual(["projects/a", "projects/sub"]);
  });
});

describe("sanitizeProjectName", () => {
  it("drops characters Plane forbids in project names", () => {
    expect(sanitizeProjectName("AirBox V1.9")).toBe("AirBox V1 9");
    expect(sanitizeProjectName("Security Cameras - Legal & GDPR")).toBe("Security Cameras Legal GDPR");
  });
});

describe("deriveIdentifier", () => {
  it("uses uppercase letters and digits, at most 12, unique", () => {
    expect(deriveIdentifier("Lab Automation", new Set())).toBe("LABAUTOMATIO");
    expect(deriveIdentifier("AirBox V1.9", new Set())).toBe("AIRBOXV19");
    expect(deriveIdentifier("Lab Automation", new Set(["labautomatio"]))).toBe("LABAUTOMATI2");
    expect(deriveIdentifier("Ăîș!", new Set())).toBe("AIS");
    expect(deriveIdentifier("!!!", new Set())).toBe("PROJECT");
  });
});

describe("merge decision", () => {
  it("detects empty root descriptions", () => {
    expect(isEmptyDescription(null)).toBe(true);
    expect(isEmptyDescription("<p></p>")).toBe(true);
    expect(isEmptyDescription('<p class="editor-paragraph-block"> &nbsp;</p><p></p>')).toBe(true);
    expect(isEmptyDescription("<p>Project notes</p>")).toBe(false);
    expect(isEmptyDescription('<image-component src="x"></image-component>')).toBe(false);
  });

  it("writes into an empty root, else creates a child", () => {
    expect(decideMergeTarget({ rootId: "r", rootDescriptionHtml: "<p></p>", rootClaimed: false })).toBe("root");
    expect(decideMergeTarget({ rootId: "r", rootDescriptionHtml: "<p>Mine</p>", rootClaimed: false })).toBe("child");
    // another Wiki.js page already took the root
    expect(decideMergeTarget({ rootId: "r", rootDescriptionHtml: "<p></p>", rootClaimed: true })).toBe("child");
  });

  it("stays where the previous run put the page", () => {
    // root we filled earlier is no longer empty but is still ours
    expect(
      decideMergeTarget({ statePageId: "r", rootId: "r", rootDescriptionHtml: "<p>x</p>", rootClaimed: false })
    ).toBe("root");
    expect(decideMergeTarget({ statePageId: "c", statePageParent: "r", rootId: "r", rootClaimed: false })).toBe(
      "child"
    );
    // page from before the merge (top-level "Projects" child): re-decided
    expect(
      decideMergeTarget({
        statePageId: "old",
        statePageParent: "projects",
        rootId: "r",
        rootDescriptionHtml: "",
        rootClaimed: false,
      })
    ).toBe("root");
  });
});
