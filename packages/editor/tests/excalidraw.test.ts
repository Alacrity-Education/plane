/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Runs against the built package (`pnpm --filter=@plane/editor build`) with Node's test runner,
// exactly like apps/live consumes it: in Node, without ever evaluating Excalidraw.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CORE_EXTENSIONS,
  getAllDocumentFormatsFromDocumentEditorBinaryData,
  getAllDocumentFormatsFromRichTextEditorBinaryData,
  getBinaryDataFromDocumentEditorHTMLString,
  getBinaryDataFromRichTextEditorHTMLString,
} from "@plane/editor";
import { convertHTMLToMarkdown } from "@plane/utils";

const DRAWING_ID = "6f1d7c58-3a4e-4b8a-9d55-0f6a1c2b3d4e";
const ASSET_ID = "0c6a3b1e-7a2f-4f0c-8b8e-2d1f5c9e7a10";

const DRAWING_HTML = `<excalidraw-component id="${DRAWING_ID}" src="${ASSET_ID}" width="100%" height="auto" alignment="left" status="uploaded"></excalidraw-component>`;

const parseDrawing = (html: string) => {
  const match = /<excalidraw-component([^>]*)><\/excalidraw-component>/.exec(html);
  assert.ok(match, `expected an <excalidraw-component> in: ${html}`);
  const attributes: Record<string, string> = {};
  for (const [, name, value] of match[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attributes[name] = value;
  return attributes;
};

describe("excalidraw-component", () => {
  it("uses the shared node name", () => {
    assert.equal(CORE_EXTENSIONS.EXCALIDRAW, "excalidrawComponent");
  });

  it("survives HTML -> binary -> HTML for the document editor", () => {
    const html = `<p>before</p>${DRAWING_HTML}<p>after</p>`;
    const binary = getBinaryDataFromDocumentEditorHTMLString(html);
    const { contentHTML, contentJSON } = getAllDocumentFormatsFromDocumentEditorBinaryData(binary, false);

    const attributes = parseDrawing(contentHTML);
    assert.equal(attributes.id, DRAWING_ID);
    assert.equal(attributes.src, ASSET_ID);
    assert.equal(attributes.width, "100%");
    assert.equal(attributes.height, "auto");
    assert.equal(attributes.alignment, "left");
    assert.equal(attributes.status, "uploaded");
    assert.ok(contentHTML.indexOf("before") < contentHTML.indexOf("<excalidraw-component"));
    assert.ok(contentHTML.indexOf("<excalidraw-component") < contentHTML.indexOf("after"));

    const node = contentJSON.content?.find((child) => child.type === "excalidrawComponent");
    assert.ok(node, "expected an excalidrawComponent node in the JSON");
    assert.equal(node.attrs?.src, ASSET_ID);
    assert.equal(node.attrs?.aspectRatio, null);
  });

  it("survives HTML -> binary -> HTML for the rich text editor variant", () => {
    const binary = getBinaryDataFromRichTextEditorHTMLString(DRAWING_HTML);
    const { contentHTML } = getAllDocumentFormatsFromRichTextEditorBinaryData(binary);
    assert.equal(parseDrawing(contentHTML).src, ASSET_ID);
  });

  it("keeps px sizes, alignment and a numeric aspect ratio (lowercased attribute)", () => {
    const html = `<excalidraw-component id="${DRAWING_ID}" src="${ASSET_ID}" width="420px" height="210px" aspectratio="2" alignment="center" status="uploaded"></excalidraw-component>`;
    const binary = getBinaryDataFromDocumentEditorHTMLString(html);
    const { contentHTML, contentJSON } = getAllDocumentFormatsFromDocumentEditorBinaryData(binary, false);

    const attributes = parseDrawing(contentHTML);
    assert.equal(attributes.width, "420px");
    assert.equal(attributes.height, "210px");
    assert.equal(attributes.aspectratio, "2");
    assert.equal(attributes.alignment, "center");
    const node = contentJSON.content?.find((child) => child.type === "excalidrawComponent");
    assert.equal(node?.attrs?.aspectRatio, 2);
  });

  it("is exported to markdown as an image", () => {
    const markdown = convertHTMLToMarkdown({
      description_html: `<p>diagram</p>${DRAWING_HTML}`,
      metaData: {
        file_assets: [{ id: ASSET_ID, name: "drawing.png", url: `https://plane.example/assets/${ASSET_ID}/` }],
        user_mentions: [],
      },
    });
    assert.match(markdown, new RegExp(`!\\[drawing\\.png\\]\\(https://plane\\.example/assets/${ASSET_ID}/\\)`));
  });
});
