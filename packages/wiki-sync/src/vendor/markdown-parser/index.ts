/**
 * Vendored copy of packages/utils/src/editor/markdown-parser (Plane, AGPL-3.0-only).
 *
 * @plane/utils is a barrel with React/propel dependencies and no subpath export, so it cannot be
 * bundled into a standalone Node CLI. The files in this folder are copied verbatim except for:
 * - custom-components-handler.ts: `img` no longer drops images whose alt is empty;
 * - root.ts: `addSpacesToCheckboxes` is exported so the wiki pipeline can reuse it, and it also
 *   matches `dataType` (rehype-parse camel-cases data-* attributes, so upstream never flattened
 *   TipTap task items and GFM checkboxes were emitted on their own line), and it recurses into
 *   flattened items so nested task lists are flattened too.
 * tests/vendor-parity.test.ts runs upstream and this copy over the same fixtures; re-copy the
 * files when that test fails after an upstream change.
 */

export * from "./types";
export * from "./root";
export { parseCustomComponents } from "./custom-components-handler";
export { parseMarks } from "./marks-handler";
