/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import * as Y from "yjs";

export type TDescriptionPayload = {
  /** Yjs update (document editor schema, `default` + `title` fragments), base64. */
  description_binary: string;
  description_html: string;
  description_json: object;
};

type TEditorLib = {
  getBinaryDataFromDocumentEditorHTMLString: (html: string, title?: string) => Uint8Array;
  getAllDocumentFormatsFromDocumentEditorBinaryData: (
    description: Uint8Array,
    updateTitle: boolean
  ) => { contentBinaryEncoded: string; contentJSON: object; contentHTML: string };
};

let editorLib: Promise<TEditorLib> | undefined;
// Loaded lazily: the editor bundle is large and only needed when writing content
const loadEditorLib = () => (editorLib ??= import("@plane/editor/lib") as Promise<TEditorLib>);

/** Sets `language` on the code blocks of a Yjs document, in document order. Returns the block count. */
export function setCodeBlockLanguages(doc: Y.Doc, languages: (string | null)[]): number {
  let index = 0;
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "codeBlock") {
        const language = languages[index];
        if (language && index < languages.length) child.setAttribute("language", language);
        index++;
      }
      visit(child);
    }
  };
  visit(doc.getXmlFragment("default"));
  return index;
}

/**
 * Builds the description payload Plane stores for a page, exactly like the web app's
 * fallback save: the editor's Yjs binary is the source of truth; HTML and JSON are derived
 * from it, so what is stored is what the editor will show.
 */
export async function buildDescription(
  html: string,
  title: string,
  codeLanguages: (string | null)[] = []
): Promise<TDescriptionPayload & { codeBlockMismatch: boolean }> {
  const lib = await loadEditorLib();
  let binary = lib.getBinaryDataFromDocumentEditorHTMLString(html, title);
  let codeBlockMismatch = false;
  if (codeLanguages.some(Boolean)) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, binary);
    const count = setCodeBlockLanguages(doc, codeLanguages);
    codeBlockMismatch = count !== codeLanguages.length;
    binary = Y.encodeStateAsUpdate(doc);
  }
  const formats = lib.getAllDocumentFormatsFromDocumentEditorBinaryData(binary, false);
  return {
    description_binary: formats.contentBinaryEncoded,
    description_html: formats.contentHTML,
    description_json: formats.contentJSON,
    codeBlockMismatch,
  };
}
