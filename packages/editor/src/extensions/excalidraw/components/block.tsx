/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EditOutline } from "@makeplane/propel/icons";
import { NodeSelection } from "@tiptap/pm/state";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
// plane imports
import { cn } from "@plane/utils";
// extensions
import { IMAGE_ALIGNMENT_OPTIONS } from "@/extensions/custom-image/utils";
// local imports
import type { TExcalidrawPixel } from "../types";
import { getExcalidrawBlockId } from "../utils";
import type { ExcalidrawNodeViewProps } from "./node-view";

const MIN_WIDTH = 100;

type Props = ExcalidrawNodeViewProps & {
  canEdit: boolean;
  onEdit: () => void;
  onImageError: () => void;
  resolvedSrc: string | undefined;
};

export function ExcalidrawBlock(props: Props) {
  const { canEdit, editor, getPos, node, onEdit, onImageError, resolvedSrc, selected, updateAttributes } = props;
  const { id, width: nodeWidth, aspectRatio: nodeAspectRatio, alignment: nodeAlignment } = node.attrs;
  // states
  const [width, setWidth] = useState<string | null>(nodeWidth?.endsWith("px") ? nodeWidth : null);
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  const [aspectRatio, setAspectRatio] = useState<number | null>(nodeAspectRatio);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  // refs
  const containerRef = useRef<HTMLDivElement>(null);
  const containerRect = useRef<DOMRect | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  // derived values
  const isEditable = editor.isEditable;
  const isTouchDevice = !!(editor.storage.utility as { isTouchDevice?: boolean } | undefined)?.isTouchDevice;
  const alignment = nodeAlignment ?? "left";
  // a "100%" drawing is shown at its natural (1x) size, capped by the editor width
  const displayWidth = width ?? (naturalWidth ? `${Math.round(naturalWidth / 2)}px` : "100%");

  useLayoutEffect(() => {
    setWidth(nodeWidth?.endsWith("px") ? nodeWidth : null);
  }, [nodeWidth]);

  useLayoutEffect(() => {
    setAspectRatio(nodeAspectRatio);
  }, [nodeAspectRatio]);

  useEffect(() => {
    setIsLoaded(false);
  }, [resolvedSrc]);

  const handleImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      setIsLoaded(true);
      if (!img.naturalWidth || !img.naturalHeight) return;
      setNaturalWidth(img.naturalWidth);
      const calculatedAspectRatio = img.naturalWidth / img.naturalHeight;
      setAspectRatio(calculatedAspectRatio);
      if (isEditable && !nodeAspectRatio) {
        try {
          updateAttributes({ aspectRatio: calculatedAspectRatio });
        } catch (error) {
          console.error("Failed to update the drawing aspect ratio:", error);
        }
      }
    },
    [isEditable, nodeAspectRatio, updateAttributes]
  );

  const handleResize = useCallback(
    (e: MouseEvent | TouchEvent) => {
      if (!containerRect.current) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const newWidth =
        alignment === "right"
          ? Math.max(containerRect.current.right - clientX, MIN_WIDTH)
          : Math.max(clientX - containerRect.current.left, MIN_WIDTH);
      setWidth(`${Math.round(newWidth)}px`);
    },
    [alignment]
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    const finalWidth = widthRef.current;
    if (!finalWidth) return;
    const numericWidth = Number.parseFloat(finalWidth);
    try {
      updateAttributes({
        width: finalWidth as TExcalidrawPixel,
        height: aspectRatio ? (`${Math.round(numericWidth / aspectRatio)}px` as TExcalidrawPixel) : "auto",
      });
    } catch (error) {
      console.error("Failed to update the drawing size:", error);
    }
  }, [aspectRatio, updateAttributes]);

  const handleResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (containerRef.current) {
      containerRect.current = containerRef.current.getBoundingClientRect();
    }
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    window.addEventListener("mousemove", handleResize);
    window.addEventListener("mouseup", handleResizeEnd);
    window.addEventListener("mouseleave", handleResizeEnd);
    window.addEventListener("touchmove", handleResize);
    window.addEventListener("touchend", handleResizeEnd);
    return () => {
      window.removeEventListener("mousemove", handleResize);
      window.removeEventListener("mouseup", handleResizeEnd);
      window.removeEventListener("mouseleave", handleResizeEnd);
      window.removeEventListener("touchmove", handleResize);
      window.removeEventListener("touchend", handleResizeEnd);
    };
  }, [isResizing, handleResize, handleResizeEnd]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isTouchDevice) {
        e.preventDefault();
        editor.commands.blur();
      }
      if (!isEditable) return;
      const pos = getPos();
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    },
    [editor, getPos, isEditable, isTouchDevice]
  );

  const showControls = canEdit && isLoaded;

  return (
    <div
      id={id ? getExcalidrawBlockId(id) : undefined}
      className={cn("max-w-full transition-all", {
        "w-fit": isLoaded,
        "w-full": !isLoaded,
        "ml-[50%] -translate-x-1/2": alignment === "center" && isLoaded,
        "ml-[100%] -translate-x-full": alignment === "right" && isLoaded,
      })}
    >
      <div
        ref={containerRef}
        className="group/excalidraw-component relative inline-block max-w-full"
        onMouseDown={handleMouseDown}
        onDoubleClick={
          canEdit
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onEdit();
              }
            : undefined
        }
        style={{ width: isLoaded ? displayWidth : "100%" }}
      >
        {!isLoaded && (
          <div
            className="w-full animate-pulse rounded-md bg-layer-1"
            style={{ aspectRatio: aspectRatio ?? 2, maxHeight: "400px" }}
          />
        )}
        {resolvedSrc && (
          <img
            data-testid="excalidraw-image"
            src={resolvedSrc}
            alt="Drawing"
            draggable={false}
            onLoad={handleImageLoad}
            onError={onImageError}
            // "read-only-image" opts out of the generic image hover filter, which would override the dark-mode filter
            className={cn("editor-excalidraw-image read-only-image block w-full rounded-md", {
              hidden: !isLoaded,
            })}
            style={aspectRatio ? { aspectRatio } : undefined}
          />
        )}
        {showControls && (
          <div className="pointer-events-none absolute top-1 right-1 z-20 flex h-7 items-center gap-2 rounded-sm bg-black/80 px-2 opacity-0 transition-opacity group-hover/excalidraw-component:pointer-events-auto group-hover/excalidraw-component:opacity-100">
            {IMAGE_ALIGNMENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={`Align ${option.label.toLowerCase()}`}
                title={`Align ${option.label.toLowerCase()}`}
                className={cn("grid h-full place-items-center text-white/60 transition-colors hover:text-white", {
                  "text-white": alignment === option.value,
                })}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  updateAttributes({ alignment: option.value });
                }}
              >
                <option.icon className="size-3" />
              </button>
            ))}
            <button
              type="button"
              data-testid="excalidraw-edit"
              aria-label="Edit drawing"
              title="Edit drawing"
              className="flex h-full items-center gap-1 text-11 text-white/60 transition-colors hover:text-white"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <EditOutline className="size-3" />
              <span>Edit</span>
            </button>
          </div>
        )}
        {selected && isLoaded && (
          <div className="pointer-events-none absolute inset-0 size-full rounded-md bg-accent-primary/30" />
        )}
        {showControls && (
          <>
            <div
              className={cn(
                "pointer-events-none absolute inset-0 rounded-md border-2 border-accent-strong transition-opacity duration-100 ease-in-out",
                {
                  "opacity-100": isResizing,
                  "opacity-0 group-hover/excalidraw-component:opacity-100": !isResizing,
                }
              )}
            />
            <div
              className={cn(
                "absolute bottom-0 size-4 translate-y-1/2 rounded-full border-2 border-white bg-accent-primary transition-opacity duration-100 ease-in-out",
                {
                  "pointer-events-auto opacity-100": isResizing,
                  "pointer-events-none opacity-0 group-hover/excalidraw-component:pointer-events-auto group-hover/excalidraw-component:opacity-100":
                    !isResizing,
                  "left-0 -translate-x-1/2 cursor-nesw-resize": alignment === "right",
                  "right-0 translate-x-1/2 cursor-nwse-resize": alignment !== "right",
                }
              )}
              onMouseDown={handleResizeStart}
              onTouchStart={handleResizeStart}
            />
          </>
        )}
      </div>
    </div>
  );
}
