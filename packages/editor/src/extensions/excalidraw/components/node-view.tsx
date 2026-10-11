/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PenToolOutline } from "@makeplane/propel/icons";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
// plane imports
import { cn } from "@plane/utils";
// constants
import { CORE_EXTENSIONS } from "@/constants/extension";
// local imports
import type { ExcalidrawExtensionType, TExcalidrawAttributes } from "../types";
import { EExcalidrawAttributeNames, EExcalidrawStatus } from "../types";
import { ExcalidrawBlock } from "./block";
import type { TExcalidrawSaveResult } from "./excalidraw-modal";
import { ExcalidrawModal } from "./excalidraw-modal";

export type ExcalidrawNodeViewProps = Omit<NodeViewProps, "extension" | "updateAttributes"> & {
  extension: ExcalidrawExtensionType;
  node: NodeViewProps["node"] & {
    attrs: TExcalidrawAttributes;
  };
  updateAttributes: (attrs: Partial<TExcalidrawAttributes>) => void;
};

export function ExcalidrawNodeView(props: ExcalidrawNodeViewProps) {
  const { editor, extension, getPos, node, selected, updateAttributes } = props;
  const { id, src, status } = node.attrs;
  // states
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(undefined);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // refs
  const openedForNewNodeRef = useRef(false);
  const isDuplicatingRef = useRef(false);
  const hasRetriedOnMountRef = useRef(false);
  const hasTriedRestoringRef = useRef(false);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  // derived values
  const isEditable = editor.isEditable;
  const storage = editor.storage[CORE_EXTENSIONS.EXCALIDRAW] as
    | { pendingOpen?: Set<string>; maxFileSize?: number }
    | undefined;
  const canEdit = isEditable && !!extension.options.uploadAsset;

  // open the editor right away for drawings inserted from this client
  useEffect(() => {
    if (!id) return;
    const pendingOpen = storage?.pendingOpen;
    if (!pendingOpen?.has(id)) return;
    pendingOpen.delete(id);
    if (!canEdit) return;
    openedForNewNodeRef.current = true;
    setIsModalOpen(true);
  }, [canEdit, id, storage]);

  // resolve the asset id into a url
  useEffect(() => {
    setResolvedSrc(undefined);
    setFailedToLoad(false);
    hasTriedRestoringRef.current = false;
    if (!src) return;
    let isCancelled = false;
    const resolve = async () => {
      try {
        const url = await extension.options.getAssetSrc?.(src);
        if (!isCancelled) setResolvedSrc(url);
      } catch (error) {
        console.error("Error fetching drawing source:", error);
        if (!isCancelled) setFailedToLoad(true);
      }
    };
    void resolve();
    return () => {
      isCancelled = true;
    };
  }, [src, extension.options]);

  // duplication flow (copy/paste of an existing drawing), same as the image component
  useEffect(() => {
    const handleDuplication = async () => {
      if (status !== EExcalidrawStatus.DUPLICATING || !extension.options.duplicateAsset || !src) return;
      if (isDuplicatingRef.current) return;
      isDuplicatingRef.current = true;
      try {
        hasRetriedOnMountRef.current = true;
        const newAssetId = await extension.options.duplicateAsset(src);
        if (!newAssetId) throw new Error("Duplication returned invalid asset ID");
        setFailedToLoad(false);
        updateAttributes({ src: newAssetId, status: EExcalidrawStatus.UPLOADED });
      } catch (error) {
        console.error("Failed to duplicate drawing:", error);
        updateAttributes({ status: EExcalidrawStatus.DUPLICATION_FAILED });
      } finally {
        isDuplicatingRef.current = false;
      }
    };
    void handleDuplication();
  }, [status, src, extension.options, updateAttributes]);

  useEffect(() => {
    if (status === EExcalidrawStatus.DUPLICATION_FAILED && !hasRetriedOnMountRef.current && src && isEditable) {
      hasRetriedOnMountRef.current = true;
      updateAttributes({ status: EExcalidrawStatus.DUPLICATING });
    }
  }, [isEditable, status, src, updateAttributes]);

  const handleImageError = useCallback(async () => {
    if (!src || hasTriedRestoringRef.current || !extension.options.restoreAsset) {
      setFailedToLoad(true);
      return;
    }
    hasTriedRestoringRef.current = true;
    try {
      await extension.options.restoreAsset(src);
      const url = await extension.options.getAssetSrc?.(src);
      setResolvedSrc(url ? `${url}${url.includes("?") ? "&" : "?"}restored=${Date.now()}` : undefined);
    } catch (error) {
      console.error("Error while restoring drawing:", error);
      setFailedToLoad(true);
    }
  }, [extension.options, src]);

  const openModal = useCallback(() => {
    if (!canEdit) return;
    openedForNewNodeRef.current = false;
    setIsModalOpen(true);
  }, [canEdit]);

  const removeCurrentNode = useCallback(() => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const currentNode = editor.state.doc.nodeAt(pos);
    if (!currentNode || currentNode.type.name !== CORE_EXTENSIONS.EXCALIDRAW) return;
    editor
      .chain()
      .deleteRange({ from: pos, to: pos + currentNode.nodeSize })
      .run();
  }, [editor, getPos]);

  const handleModalClose = useCallback(() => {
    setIsModalOpen(false);
    // a freshly inserted drawing that was never saved leaves no empty node behind
    if (openedForNewNodeRef.current && !nodeRef.current.attrs.src) {
      removeCurrentNode();
    }
    openedForNewNodeRef.current = false;
  }, [removeCurrentNode]);

  const handleSave = useCallback(
    async ({ file, aspectRatio }: TExcalidrawSaveResult) => {
      const upload = extension.options.uploadAsset;
      if (!upload || !id) throw new Error("Uploads are not available in this editor");
      const previousStatus = nodeRef.current.attrs.status;
      const utilityStorage = editor.storage.utility as { uploadInProgress?: boolean } | undefined;
      updateAttributes({ status: EExcalidrawStatus.UPLOADING });
      if (utilityStorage) utilityStorage.uploadInProgress = true;
      try {
        const assetId = await upload(id, file);
        if (!assetId) throw new Error("Upload returned an invalid asset ID");
        const currentWidth = nodeRef.current.attrs.width;
        const attrs: Partial<TExcalidrawAttributes> = {
          src: assetId,
          status: EExcalidrawStatus.UPLOADED,
          aspectRatio,
        };
        if (currentWidth && currentWidth.endsWith("px") && aspectRatio) {
          attrs.height = `${Math.round(Number.parseFloat(currentWidth) / aspectRatio)}px`;
        }
        updateAttributes(attrs);
      } catch (error) {
        updateAttributes({
          status: previousStatus === EExcalidrawStatus.UPLOADING ? EExcalidrawStatus.PENDING : previousStatus,
        });
        throw error;
      } finally {
        if (utilityStorage) utilityStorage.uploadInProgress = false;
      }
    },
    [editor, extension.options, id, updateAttributes]
  );

  const isDuplicating = status === EExcalidrawStatus.DUPLICATING;
  const hasDuplicationFailed = status === EExcalidrawStatus.DUPLICATION_FAILED;
  const showBlock = !!src && !failedToLoad && !hasDuplicationFailed && !isDuplicating;

  const getPlaceholderLabel = () => {
    if (status === EExcalidrawStatus.UPLOADING) return "Saving drawing...";
    if (isDuplicating) return "Duplicating drawing...";
    if (hasDuplicationFailed || failedToLoad) return "This drawing could not be loaded";
    return canEdit ? "Drawing — click to open" : "Empty drawing";
  };
  const isPlaceholderInteractive =
    canEdit && !isDuplicating && status !== EExcalidrawStatus.UPLOADING && !hasDuplicationFailed;

  return (
    <NodeViewWrapper
      key={node.attrs[EExcalidrawAttributeNames.ID]}
      className="editor-excalidraw-component"
      data-testid="excalidraw-component"
      data-status={status}
    >
      <div className="mx-0 my-2 p-0" data-drag-handle>
        {showBlock ? (
          <ExcalidrawBlock
            {...props}
            resolvedSrc={resolvedSrc}
            canEdit={canEdit}
            onEdit={openModal}
            onImageError={() => void handleImageError()}
          />
        ) : (
          <button
            type="button"
            data-testid="excalidraw-placeholder"
            disabled={!isPlaceholderInteractive}
            onClick={openModal}
            className={cn(
              "flex w-full items-center gap-3 rounded-md border border-subtle-1 bg-layer-1 px-4 py-3 text-left text-13 text-tertiary transition-colors",
              {
                "cursor-pointer hover:bg-layer-1-hover hover:text-secondary": isPlaceholderInteractive,
                "cursor-default": !isPlaceholderInteractive,
                "border-accent-strong": selected,
                "text-danger-primary": hasDuplicationFailed || failedToLoad,
              }
            )}
          >
            <PenToolOutline className="size-4 flex-shrink-0" />
            <span>{getPlaceholderLabel()}</span>
          </button>
        )}
      </div>
      {isModalOpen && (
        <ExcalidrawModal
          src={src}
          getAssetSrc={extension.options.getAssetSrc}
          maxFileSize={storage?.maxFileSize ?? 0}
          onClose={handleModalClose}
          onSave={handleSave}
        />
      )}
    </NodeViewWrapper>
  );
}
