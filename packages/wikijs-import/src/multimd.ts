/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * Wiki.js renders tables with `markdown-it-multimd-table`, which accepts more than GFM:
 *
 * - every row above the `| -- |` delimiter is a header row (GFM: exactly one);
 * - the delimiter may come first (no header at all);
 * - empty cells written as `||` (no space) merge into the cell before them (colspan);
 * - the delimiter may have fewer cells than the rows.
 *
 * Authors used this for figures (image row, caption row, delimiter) and step-by-step
 * screenshot tables. remark-gfm cannot parse those, so the blocks are found here, taken out
 * of the Markdown and rebuilt as HTML tables by the Markdown stage.
 */

export type TMultimdCell = { text: string; colspan: number };
export type TMultimdRow = TMultimdCell[];
export type TMultimdTable = {
  header: TMultimdRow[];
  body: TMultimdRow[];
  /** Number of columns (widest row, spans included). */
  columns: number;
  /** Rows without a delimiter that were appended to the table right above them. */
  continuation: boolean;
};

/** For every line: is it inside a fenced code block (the fence lines included)? */
export function fencedLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1] ?? "";
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return true;
    }
    return fence !== null;
  });
}

/** Splits a row on unescaped pipes. `||` yields an empty segment (a colspan marker). */
function splitRow(line: string): string[] {
  const row = line.trim().replace(/^\|/, "");
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && i + 1 < row.length) {
      current += ch + row[i + 1];
      i++;
    } else if (ch === "|") {
      segments.push(current);
      current = "";
    } else current += ch;
  }
  // `| a | b |` ends with a pipe: nothing after it; `| a | b` keeps its last cell
  if (current.trim() !== "") segments.push(current);
  return segments;
}

const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

function isDelimiter(line: string): boolean {
  const segments = splitRow(line).filter((s) => s !== "");
  return segments.length > 0 && segments.every((s) => DELIMITER_CELL.test(s));
}

function parseRow(line: string): TMultimdRow {
  const cells: TMultimdRow = [];
  for (const segment of splitRow(line)) {
    const last = cells[cells.length - 1];
    if (segment === "" && last) last.colspan++;
    else cells.push({ text: segment.trim(), colspan: 1 });
  }
  return cells;
}

const hasColspan = (line: string) => splitRow(line).some((s, i) => s === "" && i > 0);
const width = (row: TMultimdRow) => row.reduce((sum, cell) => sum + cell.colspan, 0);

function buildTable(lines: string[], continuation: boolean): TMultimdTable {
  const delimiter = lines.findIndex(isDelimiter);
  const rows = lines.filter((line) => !isDelimiter(line)).map(parseRow);
  const headerCount = Math.max(delimiter, 0);
  const header = rows.slice(0, headerCount);
  const body = rows.slice(headerCount);
  const columns = Math.max(1, ...rows.map(width));
  return { header, body, columns, continuation };
}

type TBlock = { start: number; end: number; delimiter: number; lines: string[] };

/** Contiguous `|` rows outside code fences. */
function findBlocks(lines: string[]): TBlock[] {
  const fenced = fencedLines(lines);
  const blocks: TBlock[] = [];
  let current: TBlock | null = null;
  lines.forEach((line, index) => {
    const row = !fenced[index] && line.startsWith("|");
    if (row) {
      if (!current) {
        current = { start: index, end: index, delimiter: -1, lines: [] };
        blocks.push(current);
      }
      current.end = index;
      if (current.delimiter < 0 && isDelimiter(line)) current.delimiter = current.lines.length;
      current.lines.push(line);
    } else current = null;
  });
  return blocks;
}

/**
 * Plain GFM table remark already parses the way Wiki.js shows it: one header row, a delimiter
 * with as many cells as the header (GFM rejects the table otherwise), no row wider than the
 * header (GFM drops the extra cells) and no colspans.
 */
function isGfm(block: TBlock): boolean {
  const [head, delimiter] = block.lines;
  if (block.delimiter !== 1 || head === undefined || delimiter === undefined) return false;
  const cells = (line: string) => splitRow(line).length;
  const columns = cells(head);
  return (
    cells(delimiter) === columns && block.lines.every((line) => cells(line) <= columns) && !block.lines.some(hasColspan)
  );
}

export type TExtractResult = {
  /** The Markdown with every multimd table replaced by `<div data-wikijs-table="N"></div>`. */
  markdown: string;
  tables: TMultimdTable[];
};

export const TABLE_PLACEHOLDER_ATTRIBUTE = "data-wikijs-table";

/**
 * Finds the tables remark-gfm would get wrong and replaces each with a placeholder HTML block.
 * Rows without a delimiter directly below a table (blank lines between) are its continuation:
 * the author split one table with an empty line, which markdown-it renders as stray text.
 */
export function extractMultimdTables(markdown: string): TExtractResult {
  const lines = markdown.split("\n");
  const blocks = findBlocks(lines);
  const tables: TMultimdTable[] = [];
  const replaced: { start: number; end: number; index: number }[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || block.delimiter < 0) continue;
    // Gather headerless blocks that only follow this one after blank lines
    const group = [block];
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j];
      const previous = group[group.length - 1];
      if (!next || !previous || next.delimiter >= 0) break;
      const between = lines.slice(previous.end + 1, next.start);
      if (between.some((line) => line.trim() !== "")) break;
      group.push(next);
    }
    const continuation = group.length > 1;
    if (!continuation && isGfm(block)) continue;
    const last = group[group.length - 1] ?? block;
    tables.push(
      buildTable(
        group.flatMap((b) => b.lines),
        continuation
      )
    );
    replaced.push({ start: block.start, end: last.end, index: tables.length - 1 });
    i += group.length - 1;
  }

  if (!replaced.length) return { markdown, tables };
  const out: string[] = [];
  let cursor = 0;
  for (const { start, end, index } of replaced) {
    out.push(...lines.slice(cursor, start), "", `<div ${TABLE_PLACEHOLDER_ATTRIBUTE}="${index}"></div>`, "");
    cursor = end + 1;
  }
  out.push(...lines.slice(cursor));
  return { markdown: out.join("\n"), tables };
}
