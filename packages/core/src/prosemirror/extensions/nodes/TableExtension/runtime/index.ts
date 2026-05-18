/**
 * Runtime composer for the table plugin extension.
 *
 * Takes the editor context (which carries the resolved `schema`) and
 * assembles the prosemirror-tables editing plugins, the active-cell
 * decoration plugin, the Backspace/Delete keymap chain, and the full
 * command surface (32 commands) into a single `ExtensionRuntime`.
 *
 * Naming convention across this directory:
 *   - `make*(schema)`   — schema-binding factory, bound once per editor
 *   - bare `const x: Command =` — schema-free command, module-level constant
 *
 * Plugins that hold per-editor state (columnResizing, tableEditing,
 * activeCell) are constructed inside this function so each EditorView
 * gets its own instance.
 */

import {
  columnResizing,
  tableEditing,
  mergeCells as pmMergeCells,
  splitCell as pmSplitCell,
} from 'prosemirror-tables';
import type { ExtensionContext, ExtensionRuntime } from '../../../types';
import { chainCommands } from './helpers';
import {
  makeInsertTable,
  makeAddRowAbove,
  makeAddRowBelow,
  makeAddColumnLeft,
  makeAddColumnRight,
} from './insert';
import {
  deleteRow,
  deleteColumn,
  deleteTable,
  deleteTableIfSelected,
  preventTableMergeAtGap,
} from './delete';
import { selectTable, selectRow, selectColumn } from './selection';
import {
  setTableBorders,
  setCellBorder,
  setTableBorderColor,
  setTableBorderWidth,
  type BorderPreset,
} from './borders';
import {
  setCellFillColor,
  setCellVerticalAlign,
  setCellMargins,
  setCellTextDirection,
  toggleNoWrap,
  setRowHeight,
  distributeColumns,
  autoFitContents,
  applyTableStyle,
  setTableProperties,
  toggleHeaderRow,
} from './formatting';
import { makeActiveCellPlugin } from './activeCellPlugin';

export type { BorderPreset } from './borders';

export function setupTableRuntime(ctx: ExtensionContext): ExtensionRuntime {
  const { schema } = ctx;

  const insertTable = makeInsertTable(schema);
  const addRowAbove = makeAddRowAbove(schema);
  const addRowBelow = makeAddRowBelow(schema);
  const addColumnLeft = makeAddColumnLeft(schema);
  const addColumnRight = makeAddColumnRight(schema);

  return {
    plugins: [
      columnResizing({
        handleWidth: 5,
        cellMinWidth: 25,
        lastColumnResizable: true,
      }),
      tableEditing(),
      makeActiveCellPlugin(),
    ],
    keyboardShortcuts: {
      Backspace: chainCommands(deleteTableIfSelected, preventTableMergeAtGap),
      Delete: chainCommands(deleteTableIfSelected, preventTableMergeAtGap),
    },
    commands: {
      insertTable: (rows: number, cols: number) => insertTable(rows, cols),
      addRowAbove: () => addRowAbove,
      addRowBelow: () => addRowBelow,
      deleteRow: () => deleteRow,
      addColumnLeft: () => addColumnLeft,
      addColumnRight: () => addColumnRight,
      deleteColumn: () => deleteColumn,
      deleteTable: () => deleteTable,
      selectTable: () => selectTable,
      selectRow: () => selectRow,
      selectColumn: () => selectColumn,
      mergeCells: () => pmMergeCells,
      splitCell: () => pmSplitCell,
      setCellBorder: (
        side: 'top' | 'bottom' | 'left' | 'right' | 'all',
        spec: { style: string; size?: number; color?: { rgb: string } } | null,
        clearOthers?: boolean
      ) => setCellBorder(side, spec, clearOthers),
      setTableBorders: (
        preset: BorderPreset,
        borderSpec?: { style: string; size: number; color: { rgb: string } }
      ) => setTableBorders(preset, borderSpec),
      setCellVerticalAlign: (align: 'top' | 'center' | 'bottom') => setCellVerticalAlign(align),
      setCellMargins: (margins: { top?: number; bottom?: number; left?: number; right?: number }) =>
        setCellMargins(margins),
      setCellTextDirection: (direction: string | null) => setCellTextDirection(direction),
      toggleNoWrap: () => toggleNoWrap(),
      setRowHeight: (height: number | null, rule?: 'auto' | 'atLeast' | 'exact') =>
        setRowHeight(height, rule),
      toggleHeaderRow: () => toggleHeaderRow(),
      distributeColumns: () => distributeColumns(),
      autoFitContents: () => autoFitContents(),
      setTableProperties: (props: {
        width?: number | null;
        widthType?: string | null;
        justification?: 'left' | 'center' | 'right' | null;
      }) => setTableProperties(props),
      applyTableStyle: (styleData: Parameters<typeof applyTableStyle>[0]) =>
        applyTableStyle(styleData),
      setCellFillColor: (color: string | null) => setCellFillColor(color),
      setTableBorderColor: (color: string) => setTableBorderColor(color),
      setTableBorderWidth: (size: number) => setTableBorderWidth(size),
      removeTableBorders: () => setTableBorders('none'),
      setAllTableBorders: (borderSpec?: { style: string; size: number; color: { rgb: string } }) =>
        setTableBorders('all', borderSpec),
      setOutsideTableBorders: (borderSpec?: {
        style: string;
        size: number;
        color: { rgb: string };
      }) => setTableBorders('outside', borderSpec),
      setInsideTableBorders: (borderSpec?: {
        style: string;
        size: number;
        color: { rgb: string };
      }) => setTableBorders('inside', borderSpec),
    },
  };
}
