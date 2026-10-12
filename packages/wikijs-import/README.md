# @plane/wikijs-import

One-off, re-runnable migration of a [Wiki.js](https://js.wiki) wiki into the Plane **workspace Wiki**.
It reads the Wiki.js git-sync repository (Markdown/HTML files with Wiki.js front matter plus images),
recreates the folder tree as nested wiki pages, converts the content to Plane editor documents,
uploads the images, and publishes the public pages to the docs site.

## Usage

The CLI uses `@plane/editor` (to build the editor's Yjs document), so run it from this monorepo:

```bash
pnpm install
pnpm --filter=@plane/wikijs-import build

# 1. Preview: the full tree with the resolved visibility, plus warnings. No network, no writes.
node packages/wikijs-import/dist/cli.js --source /path/to/wikijs-repo --dry-run

# 2. Import
PLANE_URL=https://plane.example.com \
PLANE_WORKSPACE_SLUG=acme \
PLANE_SESSION_COOKIE='session-id=…; csrftoken=…' \
node packages/wikijs-import/dist/cli.js --source /path/to/wikijs-repo
```

| Option                              | Meaning                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <dir>`                    | Wiki.js git-sync repository (required)                                                                                                       |
| `--dry-run`                         | Print the tree and the visibility of every page; write the report; no API calls                                                              |
| `--only <path prefix>`              | Only import pages under this Wiki.js path (e.g. `Courses/AirboxBootcamp`); missing ancestors are created                                     |
| `--state <file>`                    | State file, default `.wikijs-import/state.json`                                                                                              |
| `--report <file>`                   | Report, default `.wikijs-import/report.json` (a `.md` twin is written next to it)                                                            |
| `--force`                           | Rewrite descriptions even when unchanged since the last run                                                                                  |
| `--adopt`                           | Without a state entry, reuse an existing page with the same name and parent (recovery after losing the state file; that page is overwritten) |
| `--login-email`, `--login-password` | Sign in with email/password instead of a cookie (also `PLANE_LOGIN_EMAIL` / `PLANE_LOGIN_PASSWORD`)                                          |

| Environment            | Meaning                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PLANE_URL`            | Origin serving the Plane API (`/api/…`, `/auth/…`). Production: the Plane URL. Dev stack: `http://localhost:8000` |
| `PLANE_WORKSPACE_SLUG` | Target workspace                                                                                                  |
| `PLANE_SESSION_COOKIE` | The raw `Cookie` request header of a signed-in browser                                                            |

### Running against production (session cookie)

The importer talks to the same session-authenticated endpoints as the web app, so it acts as the
user whose session it borrows (that user owns the created pages and must be a workspace member
that may create wiki pages and publish).

1. Sign in to Plane in the browser, open DevTools → Network, click any request to `/api/…` and
   copy the **`Cookie` request header** value (it contains `session-id=…` and `csrftoken=…`).
   The cookies are HttpOnly, so `document.cookie` does not show them.
2. Run a `--dry-run` first and review the tree, the visibility column and the warnings.
3. Run the import with `PLANE_URL`, `PLANE_WORKSPACE_SLUG` and `PLANE_SESSION_COOKIE`. Keep the
   state file (`--state`) somewhere safe: it is what makes later runs update instead of duplicate.
   A state file is bound to one Plane URL + workspace; use another `--state` for another target.
4. The importer sends the `csrftoken` cookie back as `X-CSRFToken`, plus `Origin`/`Referer` set to
   `PLANE_URL` and `X-Requested-With: XMLHttpRequest`, as Django's CSRF checks require.

Re-running is safe: pages are matched through the state file, unchanged pages are left alone
(`unchanged`), changed ones are updated in place, images already uploaded are reused, and publishing
is skipped for pages that are already published.

## Mapping

| Wiki.js                                                                                                              | Plane                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Folder (`Projects/`)                                                                                                 | Wiki page named after the folder segment                         |
| Folder with an auxiliary page of the same path (`Courses/AirboxOnlineBootcamp.md` + `Courses/AirboxOnlineBootcamp/`) | One page: named by the auxiliary page's title, with its content  |
| Folder spelling variants (`Airbox Online Bootcamp/`, `Airbox%20Online%20Bootcamp/`, `AirboxOnlineBootcamp/`)         | Merged (compared decoded, without spaces, case-insensitively)    |
| Page (`Projects/spinspinspin.md`)                                                                                    | Child page of its folder page, named by the front-matter `title` |
| Root page / `home.md`                                                                                                | Top-level page (home first)                                      |
| Same page twice (folder variants, `.md` and `.html` copies)                                                          | The copy with the newest `date` wins; a warning names the other  |
| Sibling order                                                                                                        | Alphabetical by title, `sort_order` 1000, 2000, …                |
| Plane access                                                                                                         | Always public (= visible to workspace members)                   |

Content:

- Markdown is parsed with remark (GFM: tables, task lists, strikethrough, autolinks) and raw HTML in
  Markdown is kept; HTML pages (ckeditor and the raw "code" editor) are parsed as HTML. Both go
  through one converter that emits the subset the Plane document editor understands: headings,
  paragraphs, bold/italic/underline/strike/inline code, links, bullet/ordered/task lists, tables
  (paragraphs in cells), code blocks (language kept), quotes, horizontal rules, callouts and images.
- The editor's Yjs document is built with `@plane/editor` (`getBinaryDataFromDocumentEditorHTMLString`)
  and the stored HTML/JSON are derived from it, exactly like the web app's fallback save, so what is
  stored is what the editor shows.
- Callouts: a blockquote followed by `{.is-info}` / `{.is-warning}` / `{.is-success}` / `{.is-danger}`
  (or `<!-- {blockquote:.is-…} -->`, or ckeditor `<blockquote class="is-…">`) becomes a Plane callout:
  info → light blue ℹ️, warning → orange ⚠️, success → green ✅, danger → peach 🚨.
- `<mark>` becomes the editor's orange background highlight; ckeditor todo lists become task lists.
- Images are uploaded as workspace assets (`entity_type: PAGE_DESCRIPTION`, bound to the page) and
  inserted as `<image-component>`. The Wiki.js size suffix (`=30%x30%`) maps to a width on a 720 px
  page body; `{.align-center}` maps to the image alignment. References are absolute from the
  repository root; images moved next to their page by `.github/sync.py` are found there, then by
  unique file name. SVG (incl. Wiki.js draw.io `diagram` blocks), AVIF, ICO, BMP and TIFF are
  converted to PNG (rsvg-convert / ImageMagick) because the asset API only accepts PNG, JPEG, GIF and
  WebP. Images larger than the instance's upload limit (`FILE_SIZE_LIMIT`, read from
  `/api/instances/`) are re-encoded as WebP and scaled down. Remote images (`https://…`) are
  downloaded and uploaded too.
- Internal links (`/Folder/page`, `/en/Folder/page`, relative links) are rewritten to
  `/<workspace>/wiki/<page id>`. All pages are created before any content is written, so every link
  to a migrated page resolves; links to pages that do not exist, or to repository files that are not
  pages (downloads), keep their text and are listed as warnings.
- Not representable in Plane, reported as warnings: iframes/videos (replaced by a link), mermaid
  (kept as a code block), Wiki.js tabsets (flattened), missing images (an `[image not available]` note).

## Visibility (private/public separation)

| Location                                                          | Default                           | Override                              |
| ----------------------------------------------------------------- | --------------------------------- | ------------------------------------- |
| Root pages                                                        | public                            |                                       |
| `/Courses/`, `/Infrastructure/`                                   | public                            |                                       |
| `/Projects/`, `/Activities/`, `/Meetings/`, `/Guides/`, `/Board/` | private                           | tag `public` makes the page public    |
| Any other top-level folder                                        | private (warned)                  | tag `public`                          |
| `published: false`                                                | private, regardless of the above  |                                       |
| Folder pages                                                      | default of their top-level folder | flags of their auxiliary page, if any |

Every page is created with Plane access _public_ (workspace members can read it). Pages that resolve
to **public** are additionally published to the docs site (`POST …/wiki/pages/<id>/publish/`);
private pages that are found published are unpublished (`DELETE`). If the publish endpoint is not
available, the run continues, retries once at the end and lists the pages still to publish in the
report (`publishPending`).

## Report

`report.json` / `report.md` list every page with its source file, visibility (and why), what
happened to the page (`created`, `updated`, `unchanged`, `adopted`, `failed`), to its content
(`written`, `unchanged`, `empty`), image count, conversions and publish result, followed by
counts per top-level folder and all warnings.

## Development

```bash
pnpm --filter=@plane/wikijs-import test         # vitest (synthetic fixtures only)
pnpm --filter=@plane/wikijs-import check:types
pnpm --filter=@plane/wikijs-import check:lint
pnpm --filter=@plane/wikijs-import build
```

Never commit Wiki.js content or images into this repository; tests use small synthetic inputs.
