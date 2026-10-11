---
id: wiki-smoke-fixture
title: "Wiki smoke fixture"
slug: /wiki-smoke-fixture
sidebar_position: 999999
# showLastUpdateTime is on for the wiki instance; a fixed date avoids a git lookup
last_update:
  date: "2026-10-11T00:00:00Z"
format: md
---

This page exercises every construct `plane-wiki-sync` emits that MDX would reject. Keep it in
`wiki/` (it is not listed in the sync manifest, so the sync never deletes it) and the CI build
fails if a Docusaurus upgrade breaks CommonMark mode.

## Characters that break MDX

Braces {like.this} and {"json": true}, a bare a < b, an escaped \<div> tag and Array<string>.

<!-- an HTML comment, invalid in MDX -->

Inline <span style="color: red">styled text</span> and a void line break<br>without a closing slash.

Line one\
line two (CommonMark hard break)

\:::note this line is escaped and must stay a paragraph

## Callouts (admonitions)

:::warning[💡]

Peach callout with **bold** text.

- and a list

:::

:::tip

Green callout without a title.

:::

<div class="plane-callout plane-callout--light-blue"><span class="plane-callout__emoji">ℹ️</span>

Callout rendered with `--callouts html`.

</div>

## Task list

- [x] Done
- [ ] Todo
  - [ ] Nested todo

## Tables

| Key    | Value |
| ------ | ----- |
| a \| b | c     |

<table><tbody><tr><th colspan="2"><p>Merged header</p></th></tr><tr><td style="background-color: #fde68a"><p>left</p></td><td><p>right</p><p>second paragraph</p></td></tr></tbody></table>

## Code

```ts
const value = { a: 1 };
if (value.a < 2) console.log("<ok>");
```

---

Owner: @member
