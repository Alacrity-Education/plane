/**
 * Plane Wiki wiring for a Docusaurus 3.10.x site (copy next to docusaurus.config.ts).
 *
 *   import { wikiDocsPlugin, wikiMarkdown, wikiNavbarItem } from "./docusaurus.config.wiki";
 *
 *   const config: Config = {
 *     ...
 *     markdown: { ...wikiMarkdown },          // or merge into your existing `markdown` block
 *     plugins: [wikiDocsPlugin],
 *     themeConfig: { navbar: { items: [wikiNavbarItem, ...] } },
 *   };
 *
 * Also add "./src/css/wiki.css" to the classic preset's `theme.customCss`.
 *
 * Pin @docusaurus/core to 3.10.x: CommonMark (`format: 'md'`) support is documented as
 * experimental, and plane-wiki-sync relies on it (Docusaurus adds rehype-raw for .md files).
 */
import type { Config, PluginConfig } from "@docusaurus/types";

export const wikiMarkdown: NonNullable<Config["markdown"]> = {
  // .md -> CommonMark (raw HTML allowed, no JSX), .mdx -> MDX. Generated pages also carry
  // `format: md` front matter, so they stay CommonMark even if this is changed later.
  format: "detect",
  hooks: {
    // every wiki image is downloaded into static/wiki-assets; a missing file is a sync bug
    onBrokenMarkdownImages: "throw",
  },
};

export const wikiDocsPlugin: PluginConfig = [
  "@docusaurus/plugin-content-docs",
  {
    id: "wiki",
    path: "wiki",
    routeBasePath: "wiki",
    sidebarPath: "./sidebars-wiki.ts",
    // slugs such as "2026-roadmap" must not be read as ordering prefixes
    numberPrefixParser: false,
    // pages carry `last_update.date` = Plane's updated_at
    showLastUpdateTime: true,
    // pages carry `custom_edit_url` pointing at the page in Plane
  },
];

export const wikiNavbarItem = {
  type: "docSidebar",
  sidebarId: "wiki",
  docsPluginId: "wiki",
  position: "left",
  label: "Wiki",
} as const;
