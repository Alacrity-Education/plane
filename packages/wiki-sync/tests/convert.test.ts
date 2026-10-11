import { compile } from "@mdx-js/mdx";
import { readFileSync } from "node:fs";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { convertWikiHtmlToMarkdown } from "../src/markdown";
import { preprocessHtml, rewriteHref, sanitizeStyle, type TPreprocessContext } from "../src/preprocess";
import { FixtureSource } from "../src/fixture";

const PAGE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const ctx: TPreprocessContext = {
  workspaceSlug: "acme",
  planeUrl: "https://plane.example.com",
  linkMap: new Map([[PAGE, "/wiki/engineering/onboarding"]]),
  assets: new Map([[ASSET, { url: `/wiki-assets/${ASSET}.png`, name: "diagram.png" }]]),
  members: new Map([[USER, "jane"]]),
  callouts: "admonition",
};

const md = (html: string, overrides: Partial<TPreprocessContext> = {}) =>
  convertWikiHtmlToMarkdown(html, { ...ctx, ...overrides });

/** Same pipeline Docusaurus uses for `format: md` files (it unshifts rehype-raw). */
const compileLikeDocusaurus = (markdown: string) =>
  compile(markdown, {
    format: "md",
    remarkPlugins: [remarkGfm],
    rehypePlugins: [
      [
        rehypeRaw,
        {
          passThrough: ["mdxFlowExpression", "mdxJsxFlowElement", "mdxJsxTextElement", "mdxTextExpression", "mdxjsEsm"],
        },
      ],
    ],
  });

describe("convertWikiHtmlToMarkdown: TipTap nodes", () => {
  it("paragraphs and marks", () => {
    expect(
      md(
        '<p class="editor-paragraph-block" data-id="x">Hello <strong>bold</strong> <em>it <strong>bi</strong></em> <s>gone</s> <u>under</u> <code class="rounded-sm bg-layer-3" spellcheck="false">x &lt; y</code></p><p></p><p style="text-align: center">centered</p>'
      )
    ).toBe("Hello **bold** _it **bi**_ ~~gone~~ under `x < y`\n\ncentered\n");
  });

  it("headings", () => {
    expect(md('<h1 class="editor-heading-block" data-id="a">Title</h1><h2>Sub</h2><h6>Six</h6>')).toBe(
      "# Title\n\n## Sub\n\n###### Six\n"
    );
  });

  it("escapes text instead of emitting live Markdown/HTML", () => {
    expect(md("<p>a &lt;div&gt; {x} * y _z_</p><p># hash</p><p>1. not a list</p><p>:::note fake</p>")).toBe(
      "a \\<div> {x} \\* y \\_z\\_\n\n\\# hash\n\n1\\. not a list\n\n\\:::note fake\n"
    );
  });

  it("bullet, ordered and nested lists stay tight", () => {
    expect(
      md(
        '<ul class="list-disc pl-7" data-id="1"><li class="not-prose" data-id="2"><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul><ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>'
      )
    ).toBe("- one\n  - nested\n- two\n\n3. three\n4. four\n");
  });

  it("nested task lists", () => {
    expect(
      md(
        '<ul data-type="taskList" class="not-prose pl-2" data-id="a"><li data-type="taskItem" data-checked="true" class="relative" data-id="b"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Open</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>nested</p></div></li></ul></div></li></ul>'
      )
    ).toBe("- [x] Done\n- [ ] Open\n  - [ ] nested\n");
  });

  it("blockquote", () => {
    expect(md('<blockquote data-id="q"><p>quoted</p></blockquote>')).toBe("> quoted\n");
  });

  it("code blocks keep the language; plaintext becomes text", () => {
    expect(
      md(
        '<pre data-id="c"><code class="language-ts">const a = {b: 1};\n\nif (a &lt; 2) {}</code></pre><pre><code class="language-plaintext">plain</code></pre>'
      )
    ).toBe("```ts\nconst a = {b: 1};\n\nif (a < 2) {}\n```\n\n```text\nplain\n```\n");
  });

  it("horizontalRule div -> thematic break", () => {
    expect(
      md(
        '<p>above</p><div class="py-4 border-strong-1" data-type="horizontalRule" data-id="h"><div></div></div><p>below</p>'
      )
    ).toBe("above\n\n---\n\nbelow\n");
  });

  it("hard break", () => {
    expect(md("<p>line1<br>line2</p>")).toBe("line1\\\nline2\n");
  });

  it("simple table with literal null styles -> GFM", () => {
    expect(
      md(
        '<table><tbody><tr><th colspan="1" rowspan="1" colwidth="150" style="background-color: none;"><p>H1</p></th><th colspan="1" rowspan="1" colwidth="150"><p>H2</p></th></tr><tr><td colspan="1" rowspan="1" colwidth="150" style="background-color: null; color: null;"><p>a | b</p></td><td colspan="1" rowspan="1" style="background-color: #fde; color: null;"><p>c</p></td></tr></tbody></table>'
      )
    ).toBe("| H1     | H2 |\n| ------ | -- |\n| a \\| b | c  |\n");
  });

  it("merged cells -> raw HTML table with sanitised attributes", () => {
    expect(
      md(
        '<table><tbody><tr><th colspan="2" rowspan="1" colwidth="150,150" style="background-color: null;"><p>Wide</p></th></tr><tr><td colspan="1" rowspan="1" style="background-color: #fde68a; color: null;"><p>x</p></td><td><p>y</p><p>z</p></td></tr></tbody></table>'
      )
    ).toBe(
      '<table><tbody><tr><th colspan="2"><p>Wide</p></th></tr><tr><td style="background-color: #fde68a"><p>x</p></td><td><p>y</p><p>z</p></td></tr></tbody></table>\n'
    );
  });

  it("image-component -> local asset; legacy img without alt is kept; unknown asset dropped", () => {
    expect(
      md(
        `<image-component src="${ASSET}" id="blk" width="420px" height="236px" aspectratio="1.77" alignment="left" status="uploaded"></image-component><p>after</p><img src="https://cdn.example.com/legacy.png" width="300" alignment="left"><image-component src="99999999-9999-4999-8999-999999999999"></image-component>`
      )
    ).toBe(`![diagram.png](/wiki-assets/${ASSET}.png)\n\nafter\n\n![](https://cdn.example.com/legacy.png)\n`);
  });

  it("mentions -> @display_name, unknown users -> @member", () => {
    expect(
      md(
        `<p>Ping <mention-component id="m1" entity_identifier="${USER}" entity_name="user_mention"></mention-component> and <mention-component id="m2" entity_identifier="66666666-6666-4666-8666-666666666666" entity_name="user_mention"></mention-component>.</p>`
      )
    ).toBe("Ping @jane and @member.\n");
  });

  it("issue embeds are removed", () => {
    expect(
      md(
        '<p>before</p><issue-embed-component entity_identifier="e" project_identifier="P" workspace_identifier="w" id="i" entity_name="issue"></issue-embed-component><p>after</p>'
      )
    ).toBe("before\n\nafter\n");
  });

  it("emoji and colour spans are unwrapped", () => {
    expect(
      md(
        '<p>Smile <span data-type="emoji" data-name="smile">😄</span> <span data-text-color="peach" style="color: #ff0000">red</span></p>'
      )
    ).toBe("Smile 😄 red\n");
  });
});

const callout = (background: string | null, extra = 'data-logo-in-use="emoji" data-emoji-unicode="128161"') =>
  `<div data-block-type="callout-component" ${extra} ${background ? `data-background="${background}"` : ""} data-id="c"><p>Body</p></div>`;

describe("callouts", () => {
  it.each([
    ["gray", "note"],
    [null, "note"],
    ["purple", "note"],
    ["green", "tip"],
    ["peach", "warning"],
    ["orange", "warning"],
    ["pink", "danger"],
    ["light-blue", "info"],
    ["dark-blue", "info"],
  ])("background %s -> :::%s with the emoji as title", (background, type) => {
    expect(md(callout(background))).toBe(`:::${type}[💡]\n\nBody\n\n:::\n`);
  });

  it("icon callouts have no title", () => {
    expect(md(callout("green", 'data-logo-in-use="icon" data-icon-name="Info" data-icon-color="#fff"'))).toBe(
      ":::tip\n\nBody\n\n:::\n"
    );
  });

  it("keeps rich content inside the admonition", () => {
    expect(
      md(
        '<div data-block-type="callout-component" data-logo-in-use="emoji" data-emoji-unicode="9989" data-background="peach"><p>Careful <strong>now</strong></p><ul><li><p>item</p></li></ul></div>'
      )
    ).toBe(":::warning[✅]\n\nCareful **now**\n\n- item\n\n:::\n");
  });

  it("--callouts html wraps the Markdown in a styled div", () => {
    expect(md(callout("peach"), { callouts: "html" })).toBe(
      '<div class="plane-callout plane-callout--peach"><span class="plane-callout__emoji">💡</span>\n\nBody\n\n</div>\n'
    );
  });
});

describe("internal links", () => {
  it.each([
    [`https://plane.example.com/acme/wiki/${PAGE}`, "/wiki/engineering/onboarding"],
    [`/acme/wiki/${PAGE}/`, "/wiki/engineering/onboarding"],
    [`/acme/projects/44444444-4444-4444-8444-444444444444/pages/${PAGE}#intro`, "/wiki/engineering/onboarding#intro"],
    // not exported (private/archived): keep pointing at Plane
    [
      "/acme/wiki/55555555-5555-4555-8555-555555555555",
      "https://plane.example.com/acme/wiki/55555555-5555-4555-8555-555555555555",
    ],
    ["/other-ws/wiki/" + PAGE, `https://plane.example.com/other-ws/wiki/${PAGE}`],
    ["https://example.org/x", "https://example.org/x"],
    ["mailto:a@b.c", "mailto:a@b.c"],
    ["#anchor", "#anchor"],
  ])("%s -> %s", (href, expected) => {
    expect(rewriteHref(href, ctx)).toBe(expected);
  });

  it("rewrites anchors and strips editor attributes", () => {
    expect(
      md(
        `<p><a href="https://plane.example.com/acme/wiki/${PAGE}" target="_blank" rel="noopener noreferrer nofollow" class="text-accent-secondary underline">Onboarding</a></p>`
      )
    ).toBe("[Onboarding](/wiki/engineering/onboarding)\n");
  });
});

describe("preprocess", () => {
  it("sanitises styles (Plane emits literal null/none)", () => {
    expect(sanitizeStyle("background-color: null; color: null;")).toBe("");
    expect(sanitizeStyle("background-color: none; color: #fff")).toBe("color: #fff");
    expect(sanitizeStyle("text-align: center; position: fixed; color: red")).toBe("text-align: center; color: red");
    expect(sanitizeStyle("color: url(javascript:alert(1))")).toBe("");
  });

  it("drops data-id/class/colwidth and resolves custom elements", () => {
    expect(
      preprocessHtml(
        `<p class="editor-paragraph-block" data-id="x"><u>u</u></p><image-component src="${ASSET}" width="420px"></image-component><div data-type="horizontalRule" class="py-4"><div></div></div><table><tbody><tr><td colspan="1" rowspan="1" colwidth="150" style="color: null"><p>c</p></td></tr></tbody></table>`,
        ctx
      )
    ).toBe(
      `<p>u</p><img src="/wiki-assets/${ASSET}.png" alt="diagram.png"><hr><table><tbody><tr><td><p>c</p></td></tr></tbody></table>`
    );
  });
});

describe("Docusaurus md-mode compile smoke test", () => {
  const fixturePath = new URL("./fixtures/wiki-fixture.json", import.meta.url);
  const smokeTemplate = readFileSync(new URL("../templates/smoke-fixture.md", import.meta.url), "utf8");

  it("every fixture page compiles with @mdx-js/mdx format md + rehype-raw", async () => {
    const source = await FixtureSource.fromFile(fixturePath.pathname);
    for (const page of source.fixture.pages) {
      const markdown = md(page.description_html ?? "", {
        assets: new Map([["aaaaaaaa-0000-4000-8000-000000000001", { url: "/wiki-assets/x.png", name: "x.png" }]]),
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential keeps failures attributable
      await expect(compileLikeDocusaurus(markdown), page.name).resolves.toBeTruthy();
    }
  });

  it("the templates/smoke-fixture.md page compiles", async () => {
    const body = smokeTemplate.replace(/^---[\s\S]*?\n---\n/, "");
    await expect(compileLikeDocusaurus(body)).resolves.toBeTruthy();
  });

  it("the same smoke content would NOT compile as MDX (guards the format: md choice)", async () => {
    const body = smokeTemplate.replace(/^---[\s\S]*?\n---\n/, "");
    await expect(compile(body, { format: "mdx" })).rejects.toThrow();
  });
});
