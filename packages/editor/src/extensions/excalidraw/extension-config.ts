/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mergeAttributes, Node } from "@tiptap/core";
// constants
import { CORE_EXTENSIONS } from "@/constants/extension";
// local imports
import { EExcalidrawAttributeNames } from "./types";
import type {
  ExcalidrawExtensionOptions,
  ExcalidrawExtensionStorage,
  ExcalidrawExtensionType,
  InsertExcalidrawComponentProps,
} from "./types";
import { DEFAULT_EXCALIDRAW_ATTRIBUTES, parseExcalidrawAspectRatio } from "./utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    [CORE_EXTENSIONS.EXCALIDRAW]: {
      insertExcalidrawComponent: (props?: InsertExcalidrawComponentProps) => ReturnType;
    };
  }
  interface Storage {
    [CORE_EXTENSIONS.EXCALIDRAW]: ExcalidrawExtensionStorage;
  }
}

export const EXCALIDRAW_HTML_TAG = "excalidraw-component";

/**
 * Props-free Excalidraw node definition. Safe to load in Node (apps/live) as it never
 * references the Excalidraw package; the interactive node view lives in `./extension`.
 */
export const ExcalidrawExtensionConfig: ExcalidrawExtensionType = Node.create<
  ExcalidrawExtensionOptions,
  ExcalidrawExtensionStorage
>({
  name: CORE_EXTENSIONS.EXCALIDRAW,
  group: "block",
  atom: true,

  addAttributes() {
    return {
      [EExcalidrawAttributeNames.ID]: { default: DEFAULT_EXCALIDRAW_ATTRIBUTES.id },
      [EExcalidrawAttributeNames.SOURCE]: { default: DEFAULT_EXCALIDRAW_ATTRIBUTES.src },
      [EExcalidrawAttributeNames.WIDTH]: { default: DEFAULT_EXCALIDRAW_ATTRIBUTES.width },
      [EExcalidrawAttributeNames.HEIGHT]: { default: DEFAULT_EXCALIDRAW_ATTRIBUTES.height },
      [EExcalidrawAttributeNames.ASPECT_RATIO]: {
        default: DEFAULT_EXCALIDRAW_ATTRIBUTES.aspectRatio,
        // HTML parsers (browsers, html5ever) lowercase attribute names
        parseHTML: (element: HTMLElement) =>
          parseExcalidrawAspectRatio(element.getAttribute("aspectratio") ?? element.getAttribute("aspectRatio")),
        renderHTML: (attributes: Record<string, unknown>) => {
          const aspectRatio = parseExcalidrawAspectRatio(attributes[EExcalidrawAttributeNames.ASPECT_RATIO]);
          return aspectRatio === null ? {} : { aspectratio: String(aspectRatio) };
        },
      },
      [EExcalidrawAttributeNames.ALIGNMENT]: { default: DEFAULT_EXCALIDRAW_ATTRIBUTES.alignment },
      [EExcalidrawAttributeNames.STATUS]: { default: DEFAULT_EXCALIDRAW_ATTRIBUTES.status },
    };
  },

  parseHTML() {
    return [{ tag: EXCALIDRAW_HTML_TAG }];
  },

  renderHTML({ HTMLAttributes }) {
    return [EXCALIDRAW_HTML_TAG, mergeAttributes(HTMLAttributes)];
  },
});
