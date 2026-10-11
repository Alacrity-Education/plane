/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * Lazily loaded module: the ONLY place that statically imports the Excalidraw component
 * and its stylesheet. Never import this file statically, use `React.lazy` (see
 * `excalidraw-modal.tsx`) so that the editor package stays loadable in Node (apps/live).
 */
import { Excalidraw } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

export type ExcalidrawEditorProps = {
  initialData: ExcalidrawInitialDataState | null;
  theme: "light" | "dark";
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  onChange: (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => void;
};

export default function ExcalidrawEditor(props: ExcalidrawEditorProps) {
  const { initialData, theme, onApiReady, onChange } = props;

  return (
    <Excalidraw
      autoFocus
      excalidrawAPI={onApiReady}
      handleKeyboardGlobally={false}
      initialData={initialData}
      onChange={onChange}
      theme={theme}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
        },
      }}
    />
  );
}
