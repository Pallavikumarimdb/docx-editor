/**
 * Pure runtime helpers shared by the table commands.
 *
 * All four helpers below were previously nested inside `TablePluginExtension`'s
 * `onSchemaReady` closure. None of them reference `schema` — they operate
 * on transactions, selections, and PMNode shapes — so extracting them to
 * top-level functions is byte-equivalent.
 *
 * - `chainCommands` runs commands in order until one returns true (keymap helper).
 * - `buildCellAttrsFromTemplate` clones a template cell's structural attrs
 *   so newly inserted rows/columns inherit width, borders, vertical-align,
 *   etc. from the row/column they were created from.
 * - `buildTableGrid` walks the table once to produce two lookup maps used
 *   by every border command: `cellByPos` (PM position → cell info) and
 *   `cellByRC` (row,col → PM position) for adjacent-cell syncing.
 * - `getTargetCellPositions` returns the cell set to operate on: all cells
 *   in the active CellSelection, or just the cell containing the cursor.
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';

export function chainCommands(...commands: Command[]): Command {
  return (state, dispatch, view) => {
    for (const cmd of commands) {
      if (cmd(state, dispatch, view)) {
        return true;
      }
    }
    return false;
  };
}

export function buildCellAttrsFromTemplate(
  templateCell: PMNode | null,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const baseAttrs = templateCell?.attrs ?? {};
  return {
    colspan: baseAttrs.colspan || 1,
    rowspan: 1,
    colwidth: baseAttrs.colwidth,
    width: baseAttrs.width,
    widthType: baseAttrs.widthType,
    verticalAlign: baseAttrs.verticalAlign,
    backgroundColor: baseAttrs.backgroundColor,
    borders: baseAttrs.borders,
    margins: baseAttrs.margins,
    textDirection: baseAttrs.textDirection,
    noWrap: baseAttrs.noWrap,
    ...overrides,
  };
}

/**
 * Get cell positions to operate on: all cells from CellSelection, or
 * all cells in the table if a single cursor is inside a cell.
 */
export function getTargetCellPositions(state: EditorState): { pos: number; node: PMNode }[] {
  const sel = state.selection;
  const cells: { pos: number; node: PMNode }[] = [];

  // If we have a CellSelection, use its cells
  if (sel instanceof CellSelection) {
    sel.forEachCell((node, pos) => {
      cells.push({ pos, node });
    });
    return cells;
  }

  // Otherwise fall back to single cell at cursor
  const { $from } = sel;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      cells.push({ pos: $from.before(d), node });
      break;
    }
  }
  return cells;
}

/**
 * Build a full grid map of all cells in the table: pos → grid info.
 * Also builds a reverse lookup by (rowIdx, colIdx).
 */
export function buildTableGrid(table: PMNode, tableStart: number) {
  const cellByPos = new Map<
    number,
    { rowIdx: number; colIdx: number; colspan: number; pos: number; node: PMNode }
  >();
  const cellByRC = new Map<string, number>(); // "row,col" → pos
  const totalRows = table.childCount;
  let totalCols = 0;

  table.forEach((row, rowOffset, rowIdx) => {
    if (row.type.name !== 'tableRow') return;
    let colIdx = 0;
    row.forEach((cell, cellOffset) => {
      const pos = tableStart + rowOffset + cellOffset + 2;
      const colspan = (cell.attrs.colspan as number) || 1;
      cellByPos.set(pos, { rowIdx, colIdx, colspan, pos, node: cell });
      cellByRC.set(`${rowIdx},${colIdx}`, pos);
      colIdx += colspan;
    });
    totalCols = Math.max(totalCols, colIdx);
  });

  return { cellByPos, cellByRC, totalRows, totalCols };
}
