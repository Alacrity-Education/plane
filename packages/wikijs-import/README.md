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
| `--source <dir>`                    | Wiki.js git-sync repository (this or `--wikijs-url`)                                                                                         |
| `--wikijs-url <url>`                | Export the live Wiki.js (token in `WIKIJS_TOKEN`) and import from that export instead of `--source`                                          |
| `--wikijs-cache <dir>`              | Folder for the live export, default `wikijs-source` next to the state file                                                                   |
| `--dry-run`                         | Print the tree and the visibility of every page; write the report; no API calls                                                              |
| `--only <path prefix>`              | Only import pages under this Wiki.js path (e.g. `Courses/AirboxBootcamp`); missing ancestors are created                                     |
| `--state <file>`                    | State file, default `.wikijs-import/state.json`                                                                                              |
| `--report <file>`                   | Report, default `.wikijs-import/report.json` (a `.md` twin is written next to it)                                                            |
| `--project-map <json>`              | JSON object `{ "<Wiki.js path>": "<project identifier or name>" }` placing `Projects/` pages into those projects' wiki sections              |
| `--create-missing-projects`         | Create a Plane project for every `Projects/` page that matches none (see below)                                                              |
| `--no-project-sections`             | Never match `Projects/` pages to Plane projects: all of them stay under the plain "Projects" folder page (to move into projects by hand)     |
| `--force`                           | Rewrite descriptions even when unchanged since the last run                                                                                  |
| `--prune`                           | Archive pages of earlier runs that are no longer in the source (without it: only listed)                                                     |
| `--adopt`                           | Without a state entry, reuse an existing page with the same name and parent (recovery after losing the state file; that page is overwritten) |
| `--login-email`, `--login-password` | Sign in with email/password instead of a cookie (also `PLANE_LOGIN_EMAIL` / `PLANE_LOGIN_PASSWORD`)                                          |

| Environment            | Meaning                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PLANE_URL`            | Origin serving the Plane API (`/api/…`, `/auth/…`). Production: the Plane URL. Dev stack: `http://localhost:8000` |
| `PLANE_WORKSPACE_SLUG` | Target workspace                                                                                                  |
| `PLANE_SESSION_COOKIE` | The raw `Cookie` request header of a signed-in browser                                                            |
| `WIKIJS_TOKEN`         | Wiki.js API key for `--wikijs-url` (Administration → API Access); never a flag, never logged                      |

### Live Wiki.js source (`--wikijs-url`)

Instead of a git-sync checkout (which goes stale when the Wiki.js storage sync stops), the importer
can read the live wiki through its GraphQL API:

```bash
export WIKIJS_TOKEN=…   # Wiki.js → Administration → API Access (read access to pages and assets)
node packages/wikijs-import/dist/cli.js --wikijs-url https://wiki.example.com --state ~/wikijs-import/state.json …
```

It writes the same layout git-sync does into `--wikijs-cache` (default `wikijs-source/` next to the
state file) and imports from there: every page (`pages.list` + `pages.single`) as `<path>.md` with
front matter or `<path>.html` with the `<!-- -->` header, every file of the asset database at its
folder path, and then every `/….png|jpg|svg|gif|webp|mp4|pdf` the pages reference that the asset
database does not know (pasted screenshots), fetched by URL. References the server does not have
are listed as warnings. Page files are rewritten on every run (a page deleted in Wiki.js disappears
from the source); downloaded files are kept and not fetched again: delete the folder to refresh them.

### Pages removed from Wiki.js (`--prune`)

Pages the state file knows that are no longer in the source are listed in the report (`stale`) and
warned about. With `--prune` they are archived in Plane (the web app's Archive, which takes their
sub-pages along) and moved to `pruned` in the state file; folder pages whose pages were all pruned
go too. A page that still has sub-pages in Plane that the importer did not create, and project
section roots, are kept (`kept`, with a warning). With `--only`, only pages under that prefix are
considered.

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
| Plane access                                                                                                         | Public, members only or admins only (see Visibility)             |

### Project pages → project wiki sections

Plane's wiki already groups one section per Plane project (Wiki › Projects › IDENT, each with a
root page). The Wiki.js `/Projects/` folder is merged into those sections instead of becoming a
plain "Projects" page:

1. Every direct child of `Projects/` (a page, or a sub-folder with its pages) is a _project page_.
   It is resolved to a Plane project by, in order:
   - `--project-map`: path (`Projects/indxworks`, `/Projects/indxworks.md` also work) → project
     identifier or name;
   - its title or file slug equal to the project name or identifier, compared case-insensitively
     without spaces, hyphens, underscores and dots (`AirBox V1.9` = `AIRBOXV19`);
   - a prefix of at least 4 characters of one in the other (`WikiJS Fork` → `WikiJS`); ambiguous
     matches are left unmatched.
     With `--create-missing-projects`, a project is created for each unmatched page (name without the
     characters Plane forbids, identifier = uppercase letters/digits of the title, max 12, unique).
2. The project's wiki section is created when missing. If its root page has no content (or holds
   this page from an earlier run) the Wiki.js content is written into the root, which keeps its
   name; otherwise the page becomes a child of the root with its Wiki.js title. Sub-pages follow
   as children. Visibility is unchanged: a public project page publishes the root (or the child).
3. Unmatched pages stay under a fallback "Projects" folder page and are listed in the report with
   the `--project-map` line to copy. When every project page has a project, no folder page is made.
4. Re-runs migrate earlier imports: a page the state maps outside its project section is moved —
   into the root (content written there, the old page archived and deleted) or under the root —
   and the fallback "Projects" page is deleted once it has no children. A `--dry-run` with
   credentials shows the matching (read-only).

Content:

- Markdown is parsed with remark (GFM: tables, task lists, strikethrough, autolinks) and raw HTML in
  Markdown is kept; HTML pages (ckeditor and the raw "code" editor) are parsed as HTML. Both go
  through one converter that emits the subset the Plane document editor understands: headings,
  paragraphs, bold/italic/underline/strike/inline code, links, bullet/ordered/task lists, tables
  (paragraphs in cells), code blocks (language kept), quotes, horizontal rules, callouts and images.
- The editor's Yjs document is built with `@plane/editor` (`getBinaryDataFromDocumentEditorHTMLString`)
  and the stored HTML/JSON are derived from it, exactly like the web app's fallback save, so what is
  stored is what the editor shows.
- Wiki.js tables follow `markdown-it-multimd-table`, not only GFM: every row above the `| -- |`
  delimiter is a header row, the delimiter may come first (no header), `||` merges a cell into the
  one before it (colspan), and rows separated from a table by a blank line without a delimiter of
  their own continue it (warned). One-column tables with an image row and caption rows (Wiki.js
  "figures") become the image plus a centred italic caption; one-cell tables around an image become
  the image. Other tables keep their images inside the cells; tables with images get columns
  sharing the 720 px page width, and their images are sized against the column.
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

| Location                                               | Wiki.js visibility                | Override                              |
| ------------------------------------------------------ | --------------------------------- | ------------------------------------- |
| Root pages                                             | public                            |                                       |
| `/Courses/`, `/Infrastructure/`                        | public                            |                                       |
| `/Projects/`, `/Activities/`, `/Meetings/`, `/Guides/` | private                           | tag `public` makes the page public    |
| `/Board/` (and the Board folder page)                  | admins                            | none: tags and flags are ignored      |
| Any other top-level folder                             | private (warned)                  | tag `public`                          |
| `published: false`                                     | private (Board pages stay admins) |                                       |
| Folder pages                                           | default of their top-level folder | flags of their auxiliary page, if any |

Each visibility maps to a Plane page access level:

| Visibility | Plane access     | Who sees the page                                | Docs site | Dry run     |
| ---------- | ---------------- | ------------------------------------------------ | --------- | ----------- |
| public     | `0` public       | every workspace member, guests included          | published | `[public]`  |
| private    | `3` members only | workspace admins and members, never guests       | never     | `[members]` |
| admins     | `2` admins only  | workspace admins (and the importing user, owner) | never     | `[admins]`  |

Public pages are published to the docs site (`POST …/wiki/pages/<id>/publish/`); other pages that
are found published are unpublished (`DELETE`; the API also unpublishes a page when its access stops
being public). Re-runs compare the access of every existing page (including project section roots)
with the resolved one and update it (`PATCH`); those pages are reported as `updated` with
`accessUpdated: true` and counted in the summary as `access_updated`. If the publish endpoint is
not available, the run continues, retries once at the end and lists the pages still to publish in
the report (`publishPending`).

## Report

`report.json` / `report.md` list every page with its source file, visibility (and why), what
happened to the page (`created`, `updated`, `unchanged`, `adopted`, `failed`; `(access updated)` when
its Plane access changed), to its content (`written`, `unchanged`, `empty`), image count, conversions
and publish result, followed by counts per top-level folder and access level (public / members only /
admins only) and all warnings.

## Development

```bash
pnpm --filter=@plane/wikijs-import test         # vitest (synthetic fixtures only)
pnpm --filter=@plane/wikijs-import check:types
pnpm --filter=@plane/wikijs-import check:lint
pnpm --filter=@plane/wikijs-import build
```

Never commit Wiki.js content or images into this repository; tests use small synthetic inputs.
