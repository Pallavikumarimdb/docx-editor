/**
 * Footnote-reference collection with physical table-row geometry.
 *
 * Table fragments retain the whole table's document range, so references in
 * rows that split across pages need measured cell-line geometry to identify
 * the fragment that actually paints the marker.
 */

import type { BlockId, FlowBlock, Measure } from '../pagination-model/types';
import { layoutCellContent } from './cellBlockLayout';

/**
 * Where a footnote reference lives.
 *
 * `pmPos` identifies ordinary paragraph fragments. Table references also carry
 * their outer row and, when measures are available, the marker line's midpoint
 * within that row.
 */
export type FootnoteRefLocation = {
  footnoteId: number;
  pmPos: number;
  tableBlockId?: BlockId;
  rowIndex?: number;
  rowOffset?: number;
  rowHeight?: number;
};

interface TableContext {
  tableBlockId: BlockId;
  rowTops: number[];
  sourceRowIndex: number;
}

interface CellGeometry {
  lineTops: number[][];
  tableOffset: number;
}

function measuredRowLocation(
  tableCtx: TableContext,
  geometry: CellGeometry | undefined,
  blockIndex: number,
  runIndex: number,
  measure: Measure | undefined
): Pick<FootnoteRefLocation, 'rowIndex' | 'rowOffset' | 'rowHeight'> {
  if (!geometry || measure?.kind !== 'paragraph') {
    return { rowIndex: tableCtx.sourceRowIndex };
  }
  const lineIndex = measure.lines.findIndex((line) => {
    const startsBeforeRun =
      line.fromRun < runIndex || (line.fromRun === runIndex && line.fromChar <= 0);
    const endsAfterRun = line.toRun > runIndex || (line.toRun === runIndex && line.toChar > 0);
    return startsBeforeRun && endsAfterRun;
  });
  const lineTop = geometry.lineTops[blockIndex]?.[lineIndex];
  const line = measure.lines[lineIndex];
  if (lineTop == null || !line) return { rowIndex: tableCtx.sourceRowIndex };

  const tableOffset = geometry.tableOffset + lineTop + line.lineHeight / 2;
  let rowIndex = tableCtx.sourceRowIndex;
  while (
    rowIndex + 1 < tableCtx.rowTops.length - 1 &&
    tableOffset >= tableCtx.rowTops[rowIndex + 1]
  ) {
    rowIndex++;
  }
  const rowTop = tableCtx.rowTops[rowIndex];
  const rowBottom = tableCtx.rowTops[rowIndex + 1];
  if (rowTop == null || rowBottom == null || tableOffset < rowTop || tableOffset >= rowBottom) {
    return { rowIndex: tableCtx.sourceRowIndex };
  }
  return {
    rowIndex,
    rowOffset: tableOffset - rowTop,
    rowHeight: rowBottom - rowTop,
  };
}

/**
 * Scan FlowBlocks for runs with `footnoteRefId`, in document order.
 *
 * When measures are supplied, table refs use the shared cell-content stack
 * from row breaking to capture their physical position inside a split row.
 * Callers without measures retain the row-only fallback.
 */
export function collectFootnoteRefs(
  blocks: FlowBlock[],
  measures?: Measure[]
): FootnoteRefLocation[] {
  const refs: FootnoteRefLocation[] = [];

  const walk = (
    input: FlowBlock[],
    inputMeasures?: Measure[],
    tableCtx?: TableContext,
    cellGeometry?: CellGeometry
  ): void => {
    for (let blockIndex = 0; blockIndex < input.length; blockIndex++) {
      const block = input[blockIndex];
      const measure = inputMeasures?.[blockIndex];
      if (block.kind === 'paragraph') {
        for (let runIndex = 0; runIndex < block.runs.length; runIndex++) {
          const run = block.runs[runIndex];
          if (run.kind !== 'text' || run.footnoteRefId == null) continue;
          const tableLocation = tableCtx
            ? {
                tableBlockId: tableCtx.tableBlockId,
                ...measuredRowLocation(tableCtx, cellGeometry, blockIndex, runIndex, measure),
              }
            : {};
          refs.push({
            footnoteId: run.footnoteRefId,
            pmPos: run.docFrom ?? 0,
            ...tableLocation,
          });
        }
      } else if (block.kind === 'table') {
        const tableMeasure = measure?.kind === 'table' ? measure : undefined;
        const rowTops = [0];
        for (const rowMeasure of tableMeasure?.rows ?? []) {
          rowTops.push(rowTops[rowTops.length - 1] + rowMeasure.height);
        }
        block.rows.forEach((row, rowIndex) => {
          row.cells.forEach((cell, cellIndex) => {
            const cellMeasure = tableMeasure?.rows[rowIndex]?.cells[cellIndex];
            // Nested tables retain their outer row context. They are atomic in
            // that outer cell's row-break geometry, so row-only attribution is
            // the safe fallback until nested table slicing is supported.
            if (tableCtx) {
              walk(cell.blocks, cellMeasure?.blocks, tableCtx);
              return;
            }

            const nextTableCtx = { tableBlockId: block.id, rowTops, sourceRowIndex: rowIndex };
            if (!cellMeasure || rowTops.length <= rowIndex + 1) {
              walk(cell.blocks, cellMeasure?.blocks, nextTableCtx);
              return;
            }
            const rowSpan = Math.max(1, cell.rowSpan ?? 1);
            const cellEndRow = Math.min(tableMeasure!.rows.length, rowIndex + rowSpan);
            const cellHeight = rowTops[cellEndRow] - rowTops[rowIndex];
            const slack = Math.max(0, cellHeight - (cellMeasure.height ?? 0));
            const verticalOffset =
              cell.verticalAlign === 'bottom'
                ? slack
                : cell.verticalAlign === 'center'
                  ? slack / 2
                  : 0;
            const content = layoutCellContent(
              cell.blocks,
              cellMeasure.blocks,
              cell.padding?.top ?? 0
            );
            walk(cell.blocks, cellMeasure.blocks, nextTableCtx, {
              lineTops: content.lineTops,
              tableOffset: rowTops[rowIndex] + verticalOffset,
            });
          });
        });
      } else if (block.kind === 'textBox') {
        const innerMeasures = measure?.kind === 'textBox' ? measure.innerMeasures : undefined;
        walk(block.content, innerMeasures, tableCtx);
      }
    }
  };

  walk(blocks, measures);
  return refs;
}
