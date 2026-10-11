import { describe, expect, it } from "vitest";
import {
  buildLinkMap,
  buildPageTree,
  dedupeSlugs,
  filterTreeBySearch,
  flattenTree,
  getAncestorIds,
  midpointSortOrder,
  slugify,
  type TTreePage,
} from "../src/tree";

const p = (id: string, name: string, parent: string | null = null, sort_order = 65535): TTreePage => ({
  id,
  name,
  parent,
  sort_order,
});

describe("slugify", () => {
  it.each([
    ["Getting Started", "getting-started"],
    ["  Héllo, Wörld!  ", "hello-world"],
    ["What's new?", "whats-new"],
    ["C++ / C#", "c-c"],
    ["🚀", "untitled"],
    ["", "untitled"],
    ["a".repeat(120), "a".repeat(80)],
  ])("%s -> %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe("dedupeSlugs", () => {
  it("suffixes sibling duplicates -2, -3 and reserves index", () => {
    expect(dedupeSlugs(["FAQ", "faq", "F.A.Q", "Index", "README"])).toEqual([
      "faq",
      "faq-2",
      "f-a-q",
      "index-2",
      "readme-2",
    ]);
  });
});

describe("buildPageTree", () => {
  const pages = [
    p("b", "Beta", null, 2),
    p("a", "Alpha", null, 1),
    p("c2", "Child two", "a", 20),
    p("c1", "Child one", "a", 10),
    p("g", "Grandchild", "c1", 1),
    p("same2", "Same", null, 5),
    p("same1", "same", null, 5),
    p("orphan", "Orphan", "missing-parent", 3),
  ];
  const tree = buildPageTree(pages);

  it("groups by parent and sorts by (sort_order, name)", () => {
    expect(tree.roots.map((n) => n.page.id)).toEqual(["a", "b", "orphan", "same1", "same2"]);
    expect(tree.roots[0]?.children.map((n) => n.page.id)).toEqual(["c1", "c2"]);
  });

  it("dedupes slugs among siblings only and builds paths", () => {
    expect(tree.roots.map((n) => n.slug)).toEqual(["alpha", "beta", "orphan", "same", "same-2"]);
    expect(tree.byId.get("g")?.path).toBe("alpha/child-one/grandchild");
    expect(tree.byId.get("g")?.depth).toBe(2);
  });

  it("promotes orphans to the root", () => {
    expect(tree.byId.get("orphan")?.depth).toBe(0);
  });

  it("breaks parent cycles instead of losing pages", () => {
    const cyclic = buildPageTree([p("x", "X", "y", 1), p("y", "Y", "x", 2), p("z", "Z", "z", 3)]);
    expect(
      flattenTree(cyclic.roots)
        .map((n) => n.page.id)
        .toSorted()
    ).toEqual(["x", "y", "z"]);
    expect(cyclic.byId.get("y")?.path).toBe("x/y");
    expect(cyclic.byId.get("z")?.depth).toBe(0);
  });

  it("flattens depth-first in sidebar order", () => {
    expect(flattenTree(tree.roots).map((n) => n.page.id)).toEqual([
      "a",
      "c1",
      "g",
      "c2",
      "b",
      "orphan",
      "same1",
      "same2",
    ]);
  });

  it("builds the link map", () => {
    const map = buildLinkMap(tree, "/wiki/");
    expect(map.get("g")).toBe("/wiki/alpha/child-one/grandchild");
    expect(buildLinkMap(tree, "/").get("a")).toBe("/alpha");
  });

  it("returns ancestors root-first", () => {
    expect(getAncestorIds(pages, "g")).toEqual(["a", "c1"]);
    expect(getAncestorIds(pages, "orphan")).toEqual([]);
  });

  it("filters by search keeping ancestors", () => {
    const filtered = filterTreeBySearch(tree.roots, "grand");
    expect(filtered.map((n) => n.page.id)).toEqual(["a"]);
    expect(filtered[0]?.children.map((n) => n.page.id)).toEqual(["c1"]);
    expect(filtered[0]?.children[0]?.children.map((n) => n.page.id)).toEqual(["g"]);
    expect(filterTreeBySearch(tree.roots, "  ")).toBe(tree.roots);
  });
});

const pw = (identifier: string, name = identifier) => ({ project_id: `pid-${identifier}`, identifier, name });

describe("buildPageTree with project sections", () => {
  const pages: TTreePage[] = [
    p("o1", "Projects", null, 1),
    p("o2", "Handbook", null, 2),
    { ...p("w", "Web App", null, 3), project_wiki: pw("WEB", "Web App") },
    p("w1", "Architecture", "w", 1),
    p("w11", "Frontend", "w1", 1),
    { ...p("m", "Mobile", null, 4), project_wiki: pw("MOB") },
    { ...p("x", "Other web", null, 5), project_wiki: pw("web") },
    { ...p("i", "Weird", null, 6), project_wiki: pw("Index") },
    { ...p("n", "Explicit null", null, 7), project_wiki: null },
    // project_wiki on a nested page is ignored (only top-level pages are project roots)
    { ...p("nested", "Nested", "o2", 1), project_wiki: pw("NEST") },
  ];
  const tree = buildPageTree(pages, { projectsDir: "projects" });

  it("places project roots under <projectsDir>/<identifier slug> with their subtree", () => {
    expect(tree.projects.map((n) => n.page.id)).toEqual(["w", "m", "x", "i"]);
    expect(tree.byId.get("w")?.path).toBe("projects/web");
    expect(tree.byId.get("w")?.project).toEqual(pw("WEB", "Web App"));
    expect(tree.byId.get("w11")?.path).toBe("projects/web/architecture/frontend");
    expect(tree.byId.get("w11")?.project).toBeUndefined();
    expect(tree.byId.get("m")?.path).toBe("projects/mob");
    expect(tree.byId.get("nested")?.path).toBe("handbook/nested");
    expect(tree.byId.get("nested")?.project).toBeUndefined();
  });

  it("dedupes identifier slugs like sibling slugs", () => {
    expect(tree.projects.map((n) => n.slug)).toEqual(["web", "mob", "web-2", "index-2"]);
  });

  it("keeps ordinary roots at the top level and reserves the projects folder for the sections", () => {
    expect(tree.roots.map((n) => n.path)).toEqual([
      "projects-2",
      "handbook",
      "explicit-null",
      "projects/web",
      "projects/mob",
      "projects/web-2",
      "projects/index-2",
    ]);
    const onlyOrdinary = buildPageTree(
      pages.filter((page) => !page.project_wiki || page.id === "nested"),
      {
        projectsDir: "projects",
      }
    );
    expect(onlyOrdinary.byId.get("o1")?.path).toBe("projects");
    expect(onlyOrdinary.projects).toEqual([]);
  });

  it("treats a missing project_wiki as null and ignores sections without projectsDir", () => {
    expect(tree.byId.get("o2")?.project).toBeUndefined();
    const plain = buildPageTree(pages);
    expect(plain.projects).toEqual([]);
    expect(plain.byId.get("w")?.path).toBe("web-app");
    expect(plain.byId.get("w")?.project).toBeUndefined();
  });

  it("links into the projects path", () => {
    const map = buildLinkMap(tree, "/wiki");
    expect(map.get("w11")).toBe("/wiki/projects/web/architecture/frontend");
    expect(map.get("m")).toBe("/wiki/projects/mob");
  });
});

describe("midpointSortOrder", () => {
  it("handles open ends", () => {
    expect(midpointSortOrder()).toBe(65535);
    expect(midpointSortOrder(100)).toBe(10100);
    expect(midpointSortOrder(undefined, 100)).toBe(-9900);
  });

  it("splits the gap", () => {
    expect(midpointSortOrder(1, 2)).toBe(1.5);
    expect(midpointSortOrder(2, 1)).toBe(1.5);
  });

  it("returns null when the gap is exhausted (precision guard)", () => {
    expect(midpointSortOrder(1, 1 + 1e-7)).toBeNull();
    expect(midpointSortOrder(5, 5)).toBeNull();
    let low = 0;
    let high = 1;
    let steps = 0;
    for (;;) {
      const mid = midpointSortOrder(low, high);
      if (mid === null) break;
      high = mid;
      steps++;
    }
    expect(steps).toBeGreaterThan(10);
    expect(steps).toBeLessThan(40);
  });
});
