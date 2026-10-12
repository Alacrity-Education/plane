/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TSourcePage } from "../src/types";
import { toSourcePage } from "../src/source";

export function md(file: string, meta: Record<string, string>, body = "Body"): TSourcePage {
  const lines = Object.entries({ published: "true", tags: "", editor: "markdown", ...meta }).map(
    ([k, v]) => `${k}: ${v}`
  );
  const page = toSourcePage(file, `---\n${lines.join("\n")}\n---\n\n${body}\n`);
  if (!page) throw new Error(`not a page: ${file}`);
  return page;
}

export function html(file: string, meta: Record<string, string>, body = "<p>Body</p>"): TSourcePage {
  const lines = Object.entries({ published: "true", tags: "", editor: "ckeditor", ...meta }).map(
    ([k, v]) => `${k}: ${v}`
  );
  const page = toSourcePage(file, `<!--\n${lines.join("\n")}\n-->\n\n${body}\n`);
  if (!page) throw new Error(`not a page: ${file}`);
  return page;
}
