/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
// plane imports
import { cn } from "@plane/utils";
// local imports
import { isDarkThemeActive } from "../utils";

// The Excalidraw component (and its CSS) is only ever loaded through this lazy import.
const LazyExcalidrawEditor = lazy(() => import("./excalidraw-editor"));

const loadExcalidrawUtils = () => import("@excalidraw/excalidraw");

export type TExcalidrawSaveResult = {
  file: File;
  aspectRatio: number | null;
};

type Props = {
  /** asset id of the current drawing, null for a new drawing */
  src: string | null;
  getAssetSrc?: (path: string) => Promise<string>;
  maxFileSize: number;
  onClose: () => void;
  /** uploads the exported PNG and updates the node; must throw on failure */
  onSave: (result: TExcalidrawSaveResult) => Promise<void>;
};

type TLoadState = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes in this drawing. Discard them?";

const getSceneFingerprint = (elements: readonly OrderedExcalidrawElement[]) => {
  let versionSum = 0;
  let liveCount = 0;
  for (const element of elements) {
    versionSum += element.version;
    if (!element.isDeleted) liveCount += 1;
  }
  return `${elements.length}:${liveCount}:${versionSum}`;
};

// Anything Escape should dismiss inside Excalidraw before it is allowed to close the modal:
// an active drawing tool (e.g. arrow), an element being created or edited, open UI, or a selection.
const hasOpenExcalidrawUi = (appState: AppState) =>
  (appState.activeTool?.type && appState.activeTool.type !== "selection") ||
  !!appState.editingTextElement ||
  !!appState.newElement ||
  !!appState.multiElement ||
  !!appState.editingLinearElement ||
  !!appState.selectedLinearElement ||
  !!appState.editingGroupId ||
  !!appState.croppingElementId ||
  !!appState.openDialog ||
  !!appState.openMenu ||
  !!appState.openPopup ||
  !!appState.contextMenu ||
  !!appState.openSidebar ||
  Object.keys(appState.selectedElementIds ?? {}).length > 0;

const getImageAspectRatio = async (blob: Blob): Promise<number | null> => {
  try {
    const bitmap = await createImageBitmap(blob);
    const ratio = bitmap.height > 0 ? bitmap.width / bitmap.height : null;
    bitmap.close();
    return ratio;
  } catch {
    return null;
  }
};

const formatFileSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

function ExcalidrawModalWithoutPortal(props: Props) {
  const { src: srcProp, getAssetSrc, maxFileSize, onClose, onSave } = props;
  // the scene is loaded once, from the asset the modal was opened with
  const [src] = useState(srcProp);
  // states
  const [loadState, setLoadState] = useState<TLoadState>(() => (src ? { status: "loading" } : { status: "ready" }));
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [theme] = useState<"light" | "dark">(() => (isDarkThemeActive() ? "dark" : "light"));
  // refs
  const modalRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const baselineFingerprintRef = useRef<string | null>(null);
  const currentFingerprintRef = useRef<string | null>(null);
  const hasUserInteractedRef = useRef(false);
  const isSavingRef = useRef(false);

  // load the existing scene from the PNG (scene is embedded in the image)
  useEffect(() => {
    if (!src) return;
    let isCancelled = false;
    const loadScene = async () => {
      try {
        if (!getAssetSrc) throw new Error("Asset source resolver is not available");
        const url = await getAssetSrc(src);
        // The asset endpoint redirects to presigned storage; a credentialed fetch
        // cannot follow that redirect across origins (CORS), so ask the API for
        // the signed URL and fetch the bytes anonymously.
        const metaResponse = await fetch(`${url}${url.includes("?") ? "&" : "?"}response=json`, {
          credentials: "include",
        });
        if (!metaResponse.ok) throw new Error(`Failed to resolve the drawing (${metaResponse.status})`);
        const { asset_url: assetUrl } = (await metaResponse.json()) as { asset_url?: string };
        if (!assetUrl) throw new Error("The drawing asset has no download URL");
        const response = await fetch(assetUrl, { credentials: "omit" });
        if (!response.ok) throw new Error(`Failed to fetch the drawing (${response.status})`);
        const fetchedBlob = await response.blob();
        // Excalidraw detects embedded scenes by mime type; storage may serve a generic content type
        const blob =
          fetchedBlob.type === "image/png"
            ? fetchedBlob
            : new Blob([await fetchedBlob.arrayBuffer()], { type: "image/png" });
        const { loadFromBlob } = await loadExcalidrawUtils();
        const scene = await loadFromBlob(blob, null, null);
        if (isCancelled) return;
        setInitialData({
          elements: scene.elements,
          files: scene.files,
          appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
          scrollToContent: true,
        });
        setLoadState({ status: "ready" });
      } catch (loadError) {
        console.error("Failed to load the Excalidraw scene:", loadError);
        if (!isCancelled) {
          setLoadState({
            status: "error",
            message: "This drawing could not be loaded. Close the editor and try again.",
          });
        }
      }
    };
    void loadScene();
    return () => {
      isCancelled = true;
    };
  }, [getAssetSrc, src]);

  const hasUnsavedChanges = useCallback(
    () =>
      hasUserInteractedRef.current &&
      currentFingerprintRef.current !== null &&
      currentFingerprintRef.current !== baselineFingerprintRef.current,
    []
  );

  const requestClose = useCallback(() => {
    if (isSavingRef.current) return;
    if (hasUnsavedChanges() && !window.confirm(UNSAVED_CHANGES_MESSAGE)) return;
    onClose();
  }, [hasUnsavedChanges, onClose]);

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    if ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV && modalRef.current) {
      (modalRef.current as HTMLDivElement & { __excalidrawAPI?: ExcalidrawImperativeAPI }).__excalidrawAPI = api;
    }
  }, []);

  const handleChange = useCallback((elements: readonly OrderedExcalidrawElement[]) => {
    const fingerprint = getSceneFingerprint(elements);
    currentFingerprintRef.current = fingerprint;
    // until the user touches the canvas, every change (initial render, font loading) is the baseline
    if (!hasUserInteractedRef.current || baselineFingerprintRef.current === null) {
      baselineFingerprintRef.current = fingerprint;
    }
  }, []);

  const handleSave = useCallback(async () => {
    const api = apiRef.current;
    if (!api || isSavingRef.current) return;
    setError(null);
    const elements = api.getSceneElements();
    if (elements.length === 0) {
      setError("Draw something before saving.");
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const { exportToBlob } = await loadExcalidrawUtils();
      const appState = api.getAppState();
      const files = api.getFiles();
      const blob = await exportToBlob({
        mimeType: "image/png",
        appState: {
          ...appState,
          exportEmbedScene: true,
          exportWithDarkMode: false,
          exportBackground: false,
          exportScale: 2,
        },
        elements,
        files,
        exportPadding: 16,
      });
      if (maxFileSize > 0 && blob.size > maxFileSize) {
        setError(
          `The drawing is too large (${formatFileSize(blob.size)}). The maximum allowed size is ${formatFileSize(maxFileSize)}.`
        );
        return;
      }
      const aspectRatio = await getImageAspectRatio(blob);
      const file = new File([blob], `drawing-${Date.now()}.png`, { type: "image/png" });
      await onSave({ file, aspectRatio });
      baselineFingerprintRef.current = currentFingerprintRef.current;
      onClose();
    } catch (saveError) {
      console.error("Failed to save the Excalidraw drawing:", saveError);
      setError("The drawing could not be saved. Please try again.");
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [maxFileSize, onClose, onSave]);

  // Escape closes the modal, unless Excalidraw itself has something to dismiss first
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // only react to Escape pressed inside this modal
      if (event.target instanceof Node && modalRef.current && !modalRef.current.contains(event.target)) return;
      // Excalidraw's own text editor and its Escape handling come first
      if (event.target instanceof HTMLTextAreaElement) return;
      const appState = apiRef.current?.getAppState();
      if (appState && hasOpenExcalidrawUi(appState)) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [requestClose]);

  // warn before leaving the page with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const markInteraction = useCallback(() => {
    hasUserInteractedRef.current = true;
  }, []);

  const spinner = (
    <div className="grid size-full place-items-center">
      <div
        className="size-8 animate-spin rounded-full border-2 border-subtle-1 border-t-transparent"
        role="status"
        aria-label="Loading drawing editor"
      />
    </div>
  );

  return (
    <div
      ref={modalRef}
      data-testid="excalidraw-modal"
      className="fixed inset-0 z-50 flex flex-col bg-surface-1"
      role="dialog"
      aria-modal="true"
      aria-label="Drawing editor"
      // The modal is portaled, so React events still bubble into the editor's React tree.
      // EditorContent re-focuses ProseMirror on any React onFocus, which steals focus from
      // Excalidraw's text editor, so focus events are stopped here. Nothing else is stopped:
      // React's stopPropagation runs at the app root and would also silence the window- and
      // document-level listeners Excalidraw relies on (pointerup to finish shapes, paste, ...).
      onFocus={(e) => e.stopPropagation()}
      onBlur={(e) => e.stopPropagation()}
    >
      <div className="flex h-12 flex-shrink-0 items-center justify-between gap-4 border-b border-subtle-1 px-4">
        <h2 className="truncate text-14 font-medium text-primary">Drawing</h2>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-12 text-danger-primary" role="alert">
              {error}
            </span>
          )}
          <button
            type="button"
            data-testid="excalidraw-cancel"
            onClick={requestClose}
            disabled={isSaving}
            className="rounded-md border border-subtle-1 px-3 py-1.5 text-13 text-secondary transition-colors hover:bg-layer-1-hover disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="excalidraw-save"
            onClick={() => void handleSave()}
            disabled={isSaving || loadState.status !== "ready"}
            className={cn(
              "rounded-md bg-accent-primary px-3 py-1.5 text-13 font-medium text-on-color transition-opacity disabled:opacity-60",
              { "cursor-wait": isSaving }
            )}
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1"
        onPointerDownCapture={markInteraction}
        onKeyDownCapture={markInteraction}
      >
        {loadState.status === "loading" && spinner}
        {loadState.status === "error" && (
          <div className="grid size-full place-items-center p-6 text-center text-13 text-danger-primary">
            {loadState.message}
          </div>
        )}
        {loadState.status === "ready" && (
          <Suspense fallback={spinner}>
            <LazyExcalidrawEditor
              initialData={initialData}
              theme={theme}
              onApiReady={handleApiReady}
              onChange={handleChange}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export function ExcalidrawModal(props: Props) {
  const portal = document.querySelector("#editor-portal") ?? document.body;
  return ReactDOM.createPortal(<ExcalidrawModalWithoutPortal {...props} />, portal);
}
