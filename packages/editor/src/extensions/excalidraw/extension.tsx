/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ReactNodeViewRenderer } from "@tiptap/react";
import { v4 as uuidv4 } from "uuid";
// helpers
import { insertEmptyParagraphAtNodeBoundaries } from "@/helpers/insert-empty-paragraph-at-node-boundary";
// types
import type { TFileHandler } from "@/types";
// local imports
import type { ExcalidrawNodeViewProps } from "./components/node-view";
import { ExcalidrawNodeView } from "./components/node-view";
import { ExcalidrawExtensionConfig } from "./extension-config";
import type { ExcalidrawExtensionOptions, ExcalidrawExtensionStorage } from "./types";
import { EExcalidrawAttributeNames, EExcalidrawStatus } from "./types";

type Props = {
  fileHandler: TFileHandler;
  isEditable: boolean;
};

export function ExcalidrawExtension(props: Props) {
  const { fileHandler, isEditable } = props;

  return ExcalidrawExtensionConfig.extend<ExcalidrawExtensionOptions, ExcalidrawExtensionStorage>({
    selectable: isEditable,
    draggable: isEditable,

    addOptions() {
      return {
        ...this.parent?.(),
        getAssetSrc: fileHandler.getAssetSrc,
        restoreAsset: fileHandler.restore,
        uploadAsset: "upload" in fileHandler ? fileHandler.upload : undefined,
        duplicateAsset: "duplicate" in fileHandler ? fileHandler.duplicate : undefined,
      };
    },

    addStorage() {
      return {
        deletedImageSet: new Map<string, boolean>(),
        pendingOpen: new Set<string>(),
        maxFileSize: "validation" in fileHandler ? (fileHandler.validation?.maxFileSize ?? 0) : 0,
        // drawings are exported through the custom markdown parser, not tiptap-markdown
        markdown: {
          serialize() {},
        },
      };
    },

    addCommands() {
      return {
        insertExcalidrawComponent:
          (insertProps) =>
          ({ commands }) => {
            const id = uuidv4();
            const attributes = {
              [EExcalidrawAttributeNames.ID]: id,
              [EExcalidrawAttributeNames.STATUS]: EExcalidrawStatus.PENDING,
            };
            const content = { type: this.name, attrs: attributes };
            const inserted =
              insertProps?.pos !== undefined
                ? commands.insertContentAt(insertProps.pos, content)
                : commands.insertContent(content);
            if (inserted) this.storage.pendingOpen.add(id);
            return inserted;
          },
      };
    },

    addKeyboardShortcuts() {
      return {
        ArrowDown: insertEmptyParagraphAtNodeBoundaries("down", this.name),
        ArrowUp: insertEmptyParagraphAtNodeBoundaries("up", this.name),
      };
    },

    addNodeView() {
      return ReactNodeViewRenderer((nodeViewProps) => (
        <ExcalidrawNodeView {...nodeViewProps} node={nodeViewProps.node as ExcalidrawNodeViewProps["node"]} />
      ));
    },
  });
}
