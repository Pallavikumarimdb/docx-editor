/**
 * Cell + row + table formatting commands. None reference the schema —
 * they walk the existing table tree and update node attrs via
 * `tr.setNodeMarkup`. The big one is `applyTableStyle` which applies a
 * resolved table-style's conditional formatting (firstRow/lastRow/banding/
 * corner-cells) by walking the full grid and overriding background +
 * borders per conditional type.
 */

import { type Command } from 'prosemirror-state';
import { getTableContext } from '../context';
import { getTargetCellPositions } from './helpers';

export function setCellFillColor(color: string | null): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const cells = getTargetCellPositions(state);
      const bgColor = color ? color.replace(/^#/, '') : null;

      for (const { pos, node } of cells) {
        tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
          ...node.attrs,
          backgroundColor: bgColor,
        });
      }
      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function setCellVerticalAlign(align: 'top' | 'center' | 'bottom'): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const cells = getTargetCellPositions(state);
      for (const { pos, node } of cells) {
        tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
          ...node.attrs,
          verticalAlign: align,
        });
      }
      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function setCellMargins(margins: {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const cells = getTargetCellPositions(state);
      for (const { pos, node } of cells) {
        const currentMargins = node.attrs.margins || {};
        const newMargins = { ...currentMargins, ...margins };
        tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
          ...node.attrs,
          margins: newMargins,
        });
      }
      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function setCellTextDirection(direction: string | null): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const cells = getTargetCellPositions(state);
      for (const { pos, node } of cells) {
        tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
          ...node.attrs,
          textDirection: direction,
        });
      }
      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function toggleNoWrap(): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const cells = getTargetCellPositions(state);
      for (const { pos, node } of cells) {
        tr.setNodeMarkup(tr.mapping.map(pos), undefined, {
          ...node.attrs,
          noWrap: !node.attrs.noWrap,
        });
      }
      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function setRowHeight(height: number | null, rule?: 'auto' | 'atLeast' | 'exact'): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const { $from } = state.selection;

      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'tableRow') {
          const pos = $from.before(d);
          const newAttrs = {
            ...node.attrs,
            height: height,
            heightRule: height ? rule || 'atLeast' : null,
          };
          tr.setNodeMarkup(pos, undefined, newAttrs);
          dispatch(tr.scrollIntoView());
          return true;
        }
      }
    }

    return true;
  };
}

export function distributeColumns(): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (
      !context.isInTable ||
      context.tablePos === undefined ||
      !context.table ||
      !context.columnCount
    )
      return false;

    if (dispatch) {
      let tr = state.tr;
      const table = context.table;
      const colCount = context.columnCount;

      // Calculate total table width from existing column widths or use default
      const existingWidths = table.attrs.columnWidths as number[] | null;
      const totalWidthTwips = existingWidths
        ? existingWidths.reduce((sum: number, w: number) => sum + w, 0)
        : 9360; // Default content width in twips
      const equalWidth = Math.floor(totalWidthTwips / colCount);

      // Update each cell in every row
      let rowPos = context.tablePos + 1;
      table.forEach((row) => {
        if (row.type.name === 'tableRow') {
          let cellPos = rowPos + 1;
          row.forEach((cell) => {
            if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
              tr = tr.setNodeMarkup(cellPos, undefined, {
                ...cell.attrs,
                width: equalWidth,
                widthType: 'dxa',
                colwidth: null,
              });
            }
            cellPos += cell.nodeSize;
          });
        }
        rowPos += row.nodeSize;
      });

      // Update table-level column widths
      const newColumnWidths = Array(colCount).fill(equalWidth);
      tr = tr.setNodeMarkup(context.tablePos, undefined, {
        ...table.attrs,
        columnWidths: newColumnWidths,
      });

      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function autoFitContents(): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      let tr = state.tr;
      const table = context.table;

      // Remove explicit widths from all cells
      let rowPos = context.tablePos + 1;
      table.forEach((row) => {
        if (row.type.name === 'tableRow') {
          let cellPos = rowPos + 1;
          row.forEach((cell) => {
            if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
              tr = tr.setNodeMarkup(cellPos, undefined, {
                ...cell.attrs,
                width: null,
                widthType: null,
                colwidth: null,
              });
            }
            cellPos += cell.nodeSize;
          });
        }
        rowPos += row.nodeSize;
      });

      // Remove table-level column widths and set auto width
      tr = tr.setNodeMarkup(context.tablePos, undefined, {
        ...table.attrs,
        columnWidths: null,
        width: null,
        widthType: 'auto',
      });

      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

/**
 * Apply a table style to the current table.
 * Accepts pre-resolved style data (borders, shading per conditional type).
 */
export function applyTableStyle(styleData: {
  styleId: string;
  tableBorders?: {
    top?: { style: string; size?: number; color?: { rgb: string } };
    bottom?: { style: string; size?: number; color?: { rgb: string } };
    left?: { style: string; size?: number; color?: { rgb: string } };
    right?: { style: string; size?: number; color?: { rgb: string } };
    insideH?: { style: string; size?: number; color?: { rgb: string } };
    insideV?: { style: string; size?: number; color?: { rgb: string } };
  };
  conditionals?: Record<
    string,
    {
      backgroundColor?: string;
      borders?: {
        top?: { style: string; size?: number; color?: { rgb: string } } | null;
        bottom?: { style: string; size?: number; color?: { rgb: string } } | null;
        left?: { style: string; size?: number; color?: { rgb: string } } | null;
        right?: { style: string; size?: number; color?: { rgb: string } } | null;
      };
      bold?: boolean;
      color?: string;
    }
  >;
  look?: {
    firstRow?: boolean;
    lastRow?: boolean;
    firstCol?: boolean;
    lastCol?: boolean;
    noHBand?: boolean;
    noVBand?: boolean;
  };
}): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      let tr = state.tr;
      const table = context.table;
      const tablePos = context.tablePos;
      const totalRows = table.childCount;
      const look = styleData.look ?? {
        firstRow: true,
        lastRow: false,
        noHBand: false,
        noVBand: true,
      };
      const conditionals = styleData.conditionals ?? {};
      const tableBorders = styleData.tableBorders;

      // Update table node attrs with styleId
      tr = tr.setNodeMarkup(tablePos, undefined, {
        ...table.attrs,
        styleId: styleData.styleId,
      });

      // Walk through all rows and cells to apply conditional formatting
      let dataRowIndex = 0;
      let rowOffset = tablePos + 1; // Skip table open tag

      for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
        const row = table.child(rowIdx);
        const isFirstRow = rowIdx === 0 && !!look.firstRow;
        const isLastRow = rowIdx === totalRows - 1 && !!look.lastRow;
        const bandingEnabled = look.noHBand !== true;
        const totalCols = row.childCount;

        // Determine row-level conditional type
        let condType: string | undefined;
        if (isFirstRow) {
          condType = 'firstRow';
        } else if (isLastRow) {
          condType = 'lastRow';
        } else if (bandingEnabled) {
          condType = dataRowIndex % 2 === 0 ? 'band1Horz' : 'band2Horz';
          dataRowIndex++;
        } else {
          dataRowIndex++;
        }

        let cellOffset = rowOffset + 1; // Skip row open tag

        for (let colIdx = 0; colIdx < totalCols; colIdx++) {
          const cell = row.child(colIdx);
          const cellPos = tr.mapping.map(cellOffset);

          // Determine cell-level conditional (column overrides can apply)
          let cellCondType = condType;
          const isFirstCol = colIdx === 0 && !!look.firstCol;
          const isLastCol = colIdx === totalCols - 1 && !!look.lastCol;

          // Corner cells take highest priority
          if (isFirstRow && isFirstCol && conditionals['nwCell']) {
            cellCondType = 'nwCell';
          } else if (isFirstRow && isLastCol && conditionals['neCell']) {
            cellCondType = 'neCell';
          } else if (isLastRow && isFirstCol && conditionals['swCell']) {
            cellCondType = 'swCell';
          } else if (isLastRow && isLastCol && conditionals['seCell']) {
            cellCondType = 'seCell';
          } else if (isFirstCol) {
            cellCondType = 'firstCol';
          } else if (isLastCol) {
            cellCondType = 'lastCol';
          }

          // Resolve conditional style for this cell
          const cond = cellCondType ? conditionals[cellCondType] : undefined;

          // Build new cell attrs
          const newAttrs = { ...cell.attrs };

          // Apply background color
          if (cond?.backgroundColor) {
            newAttrs.backgroundColor = cond.backgroundColor;
          } else {
            newAttrs.backgroundColor = null;
          }

          // Apply borders: conditional borders override table borders
          const cellEdgeSet: Record<string, unknown> = {};
          const sides = ['top', 'bottom', 'left', 'right'] as const;
          for (const side of sides) {
            if (cond?.borders && cond.borders[side] !== undefined) {
              cellEdgeSet[side] = cond.borders[side];
            } else if (tableBorders) {
              // Map table-level border to cell: insideH for top/bottom between rows, insideV for left/right between cols
              if ((side === 'top' && rowIdx > 0) || (side === 'bottom' && rowIdx < totalRows - 1)) {
                cellEdgeSet[side] = tableBorders.insideH ?? tableBorders[side];
              } else if (
                (side === 'left' && colIdx > 0) ||
                (side === 'right' && colIdx < totalCols - 1)
              ) {
                cellEdgeSet[side] = tableBorders.insideV ?? tableBorders[side];
              } else {
                cellEdgeSet[side] = tableBorders[side];
              }
            }
          }
          if (Object.keys(cellEdgeSet).length > 0) {
            newAttrs.borders = cellEdgeSet;
          } else {
            newAttrs.borders = null;
          }

          tr = tr.setNodeMarkup(cellPos, undefined, newAttrs);
          cellOffset += cell.nodeSize;
        }

        rowOffset += row.nodeSize;
      }

      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function setTableProperties(props: {
  width?: number | null;
  widthType?: string | null;
  justification?: 'left' | 'center' | 'right' | null;
}): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const newAttrs = { ...context.table.attrs };
      if ('width' in props) newAttrs.width = props.width;
      if ('widthType' in props) newAttrs.widthType = props.widthType;
      if ('justification' in props) newAttrs.justification = props.justification;
      tr.setNodeMarkup(context.tablePos, undefined, newAttrs);
      dispatch(tr.scrollIntoView());
    }

    return true;
  };
}

export function toggleHeaderRow(): Command {
  return (state, dispatch) => {
    const context = getTableContext(state);
    if (!context.isInTable || context.tablePos === undefined || !context.table) return false;

    if (dispatch) {
      const tr = state.tr;
      const { $from } = state.selection;

      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'tableRow') {
          const pos = $from.before(d);
          const newAttrs = { ...node.attrs, isHeader: !node.attrs.isHeader };
          tr.setNodeMarkup(pos, undefined, newAttrs);
          dispatch(tr.scrollIntoView());
          return true;
        }
      }
    }

    return true;
  };
}
