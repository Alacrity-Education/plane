// The vendored converter must stay identical to packages/utils (apart from the documented fixes).
import { describe, expect, it } from "vitest";
import { convertHTMLToMarkdown as upstream } from "../../utils/src/editor/markdown-parser/root";
import { convertHTMLToMarkdown as vendored } from "../src/vendor/markdown-parser";

const metaData = {
  file_assets: [{ id: "asset-1", name: "diagram.png", url: "/assets/asset-1" }],
  user_mentions: [{ id: "user-1", display_name: "jane", url: "/profile/user-1" }],
};

const SAME = [
  '<p class="editor-paragraph-block">Hello <strong>bold</strong> <em>it</em> <u>u</u> <s>s</s> <code>c</code></p>',
  "<h1>One</h1><h2>Two</h2><blockquote><p>q</p></blockquote>",
  '<p><a href="https://example.org" target="_blank">link</a></p>',
  "<ul><li><p>a</p></li><li><p>b</p></li></ul><ol><li><p>c</p></li></ol>",
  '<pre><code class="language-ts">const a = 1;</code></pre>',
  '<image-component src="asset-1"></image-component><image-component src="unknown"></image-component>',
  '<p><mention-component entity_identifier="user-1" entity_name="user_mention"></mention-component></p>',
  '<img src="https://x/y.png" alt="Alt">',
  "<table><tbody><tr><th><p>h</p></th></tr><tr><td><p>c</p></td></tr></tbody></table>",
  '<div data-block-type="callout-component" data-background="peach"><p>callout</p></div>',
  '<div data-type="horizontalRule"><div></div></div>',
];

describe("vendored markdown-parser parity with packages/utils", () => {
  it.each(SAME)("%s", (html) => {
    expect(vendored({ description_html: html, metaData })).toBe(upstream({ description_html: html, metaData }));
  });

  it("documented fix: legacy <img> without a usable alt is kept", () => {
    const emptyAlt = '<img src="https://x/legacy.png" alt="">';
    const noAlt = '<img src="https://x/legacy.png">';
    expect(upstream({ description_html: emptyAlt, metaData })).toBe("");
    expect(upstream({ description_html: noAlt, metaData })).toBe("![undefined](https://x/legacy.png)\n");
    expect(vendored({ description_html: emptyAlt, metaData })).toBe("![](https://x/legacy.png)\n");
    expect(vendored({ description_html: noAlt, metaData })).toBe("![](https://x/legacy.png)\n");
  });

  it("documented fix: TipTap task items (incl. nested) are flattened into GFM checkboxes", () => {
    const html =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p><ul data-type="taskList"><li data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>sub</p></div></li></ul></div></li></ul>';
    expect(upstream({ description_html: html, metaData })).toContain("* [x]\n\n  Done");
    expect(vendored({ description_html: html, metaData })).toBe("* [x] Done\n  * [ ] sub\n");
  });
});
