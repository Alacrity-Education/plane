/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Pure helpers (no Node APIs) so the web store can import them too.

/** Set on a project's root wiki page (always a top-level page); null/missing everywhere else. */
export type TTreeProjectWiki = {
  project_id: string;
  identifier: string;
  name: string;
};

export type TTreePage = {
  id: string;
  name: string;
  parent: string | null;
  sort_order: number;
  project_wiki?: TTreeProjectWiki | null;
};

export type TPageTreeNode<T extends TTreePage = TTreePage> = {
  page: T;
  /** URL/file segment for this page, unique among its siblings. */
  slug: string;
  /** Slash-joined slugs from the root, e.g. "engineering/onboarding". */
  path: string;
  depth: number;
  children: TPageTreeNode<T>[];
  /**
   * Only on the root page of a project wiki section (when `buildPageTree` got `projectsDir`): the
   * page is always written as a folder `<projectsDir>/<identifier slug>/`, even without children.
   */
  project?: TTreeProjectWiki;
};

export type TPageTree<T extends TTreePage = TTreePage> = {
  /** Every top-level node: ordinary roots first, then the project section roots. */
  roots: TPageTreeNode<T>[];
  /** Project section roots (subset of `roots`), in sidebar order; empty without `projectsDir`. */
  projects: TPageTreeNode<T>[];
  byId: Map<string, TPageTreeNode<T>>;
};

export type TBuildPageTreeOptions = {
  /**
   * Folder (one path segment) that groups project wiki sections: a top-level page with a non-null
   * `project_wiki` becomes `<projectsDir>/<identifier slug>`. Unset: project roots are ordinary pages.
   */
  projectsDir?: string;
};

/** File names a generated slug must not take inside a category folder. */
const RESERVED_SLUGS = new Set(["index", "readme", "_category_"]);

const MAX_SLUG_LENGTH = 80;

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

export function comparePages(a: TTreePage, b: TTreePage): number {
  const orderA = Number.isFinite(a.sort_order) ? a.sort_order : Number.MAX_VALUE;
  const orderB = Number.isFinite(b.sort_order) ? b.sort_order : Number.MAX_VALUE;
  if (orderA !== orderB) return orderA - orderB;
  const byName = (a.name ?? "").localeCompare(b.name ?? "", "en", { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Assigns sibling-unique slugs in order: "faq", "faq-2", "faq-3", ... (`reserved` are never used). */
export function dedupeSlugs(names: string[], reserved: Iterable<string> = []): string[] {
  const used = new Set<string>([...RESERVED_SLUGS, ...reserved]);
  return names.map((name) => {
    const base = slugify(name);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  });
}

/**
 * Builds the page tree from a flat list. Children are sorted by (sort_order, name); pages whose
 * parent is not in the list (private, archived or deleted parents) become roots, and so do pages
 * caught in a parent cycle. With `projectsDir`, top-level project root pages are placed under
 * `<projectsDir>/<identifier slug>` and an ordinary root may not take the `projectsDir` slug.
 */
export function buildPageTree<T extends TTreePage>(pages: T[], options: TBuildPageTreeOptions = {}): TPageTree<T> {
  const ids = new Set(pages.map((p) => p.id));
  const effectiveParent = new Map<string, string | null>();
  for (const page of pages) {
    effectiveParent.set(page.id, page.parent && ids.has(page.parent) && page.parent !== page.id ? page.parent : null);
  }

  // Break parent cycles: while some page cannot reach a root, promote the first such page.
  const reachesRoot = (id: string): boolean => {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) return false;
      seen.add(current);
      current = effectiveParent.get(current) ?? null;
    }
    return true;
  };
  for (;;) {
    const stuck = pages.filter((p) => !reachesRoot(p.id)).toSorted(comparePages)[0];
    if (!stuck) break;
    effectiveParent.set(stuck.id, null);
  }

  const childrenOf = new Map<string | null, T[]>();
  for (const page of pages) {
    const parent = effectiveParent.get(page.id) ?? null;
    const list = childrenOf.get(parent) ?? [];
    list.push(page);
    childrenOf.set(parent, list);
  }

  const byId = new Map<string, TPageTreeNode<T>>();
  const place = (
    siblings: T[],
    parent: TPageTreeNode<T> | null,
    slugs: string[],
    prefix: string,
    isProject: boolean
  ): TPageTreeNode<T>[] =>
    siblings.map((page, index) => {
      const slug = slugs[index] ?? slugify(page.name);
      const node: TPageTreeNode<T> = {
        page,
        slug,
        path: parent ? `${parent.path}/${slug}` : `${prefix}${slug}`,
        depth: parent ? parent.depth + 1 : 0,
        children: [],
      };
      if (isProject && page.project_wiki) node.project = page.project_wiki;
      byId.set(page.id, node);
      const children = (childrenOf.get(page.id) ?? []).toSorted(comparePages);
      node.children = place(children, node, dedupeSlugs(children.map((p) => p.name)), "", false);
      return node;
    });

  const topLevel = (childrenOf.get(null) ?? []).toSorted(comparePages);
  const projectsDir = options.projectsDir?.replace(/^\/+|\/+$/g, "") ?? "";
  const isProjectRoot = (page: T): boolean => Boolean(projectsDir && page.project_wiki);
  const projectPages = topLevel.filter(isProjectRoot);
  const ordinaryPages = topLevel.filter((page) => !isProjectRoot(page));

  const ordinary = place(
    ordinaryPages,
    null,
    // while project sections exist, the projects folder belongs to them
    dedupeSlugs(
      ordinaryPages.map((p) => p.name),
      projectPages.length ? [projectsDir.toLowerCase()] : []
    ),
    "",
    false
  );
  const projects = place(
    projectPages,
    null,
    dedupeSlugs(projectPages.map((p) => p.project_wiki?.identifier || p.name)),
    `${projectsDir}/`,
    true
  );

  return { roots: [...ordinary, ...projects], projects, byId };
}

/** Depth-first, parents before children, siblings in sidebar order. */
export function flattenTree<T extends TTreePage>(roots: TPageTreeNode<T>[]): TPageTreeNode<T>[] {
  const out: TPageTreeNode<T>[] = [];
  const walk = (nodes: TPageTreeNode<T>[]) => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** page id -> site route, e.g. "/wiki/engineering/onboarding". */
export function buildLinkMap<T extends TTreePage>(tree: TPageTree<T>, routeBasePath = "/wiki"): Map<string, string> {
  const base = `/${routeBasePath.replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
  const map = new Map<string, string>();
  for (const [id, node] of tree.byId) map.set(id, `${base}/${node.path}`);
  return map;
}

/** Ancestor ids from the root down to (excluding) the page itself. */
export function getAncestorIds(pages: TTreePage[], pageId: string): string[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ancestors: string[] = [];
  const seen = new Set<string>([pageId]);
  let current = byId.get(pageId)?.parent ?? null;
  while (current && byId.has(current) && !seen.has(current)) {
    ancestors.unshift(current);
    seen.add(current);
    current = byId.get(current)?.parent ?? null;
  }
  return ancestors;
}

/** Keeps nodes whose name matches the query plus the ancestors needed to reach them. */
export function filterTreeBySearch<T extends TTreePage>(roots: TPageTreeNode<T>[], query: string): TPageTreeNode<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return roots;
  const filter = (nodes: TPageTreeNode<T>[]): TPageTreeNode<T>[] =>
    nodes.flatMap((node) => {
      const children = filter(node.children);
      if (children.length || (node.page.name ?? "").toLowerCase().includes(needle)) return [{ ...node, children }];
      return [];
    });
  return filter(roots);
}

export const DEFAULT_SORT_ORDER = 65535;
const SORT_ORDER_STEP = 10000;
/** Below this gap a midpoint loses meaningful precision; the caller should renormalise siblings. */
export const MIN_SORT_ORDER_GAP = 1e-6;

/**
 * sort_order for a page dropped between two siblings (either may be missing). Returns null when the
 * gap is too small to split, meaning the siblings need renumbering first.
 */
export function midpointSortOrder(before?: number | null, after?: number | null): number | null {
  const hasBefore = typeof before === "number" && Number.isFinite(before);
  const hasAfter = typeof after === "number" && Number.isFinite(after);
  if (!hasBefore && !hasAfter) return DEFAULT_SORT_ORDER;
  if (hasBefore && !hasAfter) return (before as number) + SORT_ORDER_STEP;
  if (!hasBefore && hasAfter) return (after as number) - SORT_ORDER_STEP;
  const low = Math.min(before as number, after as number);
  const high = Math.max(before as number, after as number);
  if (high - low < MIN_SORT_ORDER_GAP) return null;
  const mid = low + (high - low) / 2;
  if (mid <= low || mid >= high) return null;
  return mid;
}
