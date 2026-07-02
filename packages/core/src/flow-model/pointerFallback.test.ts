import { describe, expect, test } from 'bun:test';
import type {
  Layout,
  MeasuredLine,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMetrics,
  TableBlock,
  TableFragment,
  TableMeasure,
} from '../pagination-model/types';
import { resolveFragmentHit, resolveTableCellHit } from './pointerHitResolve';
import { pointerToDocPos, pointerToDocPosInParagraph } from './pointerToDocPos';

function line(runIndex: number, textLength: number): MeasuredLine {
  return {
    fromRun: runIndex,
    fromChar: 0,
    toRun: runIndex,
    toChar: textLength,
    width: textLength * 8,
    ascent: 12,
    descent: 4,
    lineHeight: 20,
  };
}

function paragraph(
  id: string,
  runs: Array<{ text: string; docFrom: number }>
): { block: ParagraphBlock; measure: ParagraphMetrics } {
  const block: ParagraphBlock = {
    kind: 'paragraph',
    id,
    runs: runs.map(({ text, docFrom }) => ({
      kind: 'text',
      text,
      docFrom,
      docTo: docFrom + text.length,
    })),
  };
  return {
    block,
    measure: {
      kind: 'paragraph',
      lines: runs.map((run, index) => line(index, run.text.length)),
      totalHeight: runs.length * 20,
    },
  };
}

function paragraphFragment(block: ParagraphBlock, measure: ParagraphMetrics): ParagraphFragment {
  return {
    kind: 'paragraph',
    blockId: block.id,
    x: 0,
    y: 0,
    width: 500,
    height: measure.totalHeight,
    fromLine: 0,
    toLine: measure.lines.length,
  };
}

describe('layout pointer fallbacks', () => {
  test('click beyond a short line resolves to its trailing position', () => {
    const { block, measure } = paragraph('short', [{ text: 'Short', docFrom: 1 }]);

    const result = pointerToDocPosInParagraph(block, measure, paragraphFragment(block, measure), {
      x: 450,
      y: 10,
    });

    expect(result?.pos).toBe(6);
  });

  test('click below the final line clamps to that line', () => {
    const { block, measure } = paragraph('two-lines', [
      { text: 'First', docFrom: 1 },
      { text: 'Final', docFrom: 6 },
    ]);

    const result = pointerToDocPosInParagraph(block, measure, paragraphFragment(block, measure), {
      x: 450,
      y: 500,
    });

    expect(result?.lineIndex).toBe(1);
    expect(result?.pos).toBe(11);
  });

  test('click in a continuation-table cell accounts for clipped row content', () => {
    const first = paragraph('cell-1', [{ text: 'First', docFrom: 3 }]);
    const second = paragraph('cell-2', [{ text: 'Second', docFrom: 8 }]);
    const visible = paragraph('cell-3', [{ text: 'Visible', docFrom: 14 }]);
    const table: TableBlock = {
      kind: 'table',
      id: 'table',
      docFrom: 1,
      docTo: 23,
      columnWidths: [200],
      rows: [
        {
          id: 'row',
          cells: [
            {
              id: 'cell',
              blocks: [first.block, second.block, visible.block],
            },
          ],
        },
      ],
    };
    const tableMeasure: TableMeasure = {
      kind: 'table',
      columnWidths: [200],
      totalWidth: 200,
      totalHeight: 60,
      rows: [
        {
          height: 60,
          cells: [
            {
              blocks: [first.measure, second.measure, visible.measure],
              width: 200,
              height: 60,
            },
          ],
        },
      ],
    };
    const fragment: TableFragment = {
      kind: 'table',
      blockId: table.id,
      x: 0,
      y: 0,
      width: 200,
      height: 20,
      fromRow: 0,
      toRow: 1,
      topClip: 40,
      continuesFromPrev: true,
    };
    const layout: Layout = {
      pageSize: { w: 300, h: 400 },
      pages: [
        {
          number: 2,
          size: { w: 300, h: 400 },
          margins: { top: 40, right: 20, bottom: 40, left: 20 },
          fragments: [fragment],
        },
      ],
    };
    const pageHit = { pageIndex: 0, page: layout.pages[0], pageY: 5 };
    const point = { x: 0, y: 5 };
    const fragmentHit = resolveFragmentHit(pageHit, [table], [tableMeasure], point);
    const cellHit = resolveTableCellHit(pageHit, [table], [tableMeasure], point);

    expect(fragmentHit).not.toBeNull();
    expect(cellHit?.localY).toBe(45);
    expect(fragmentHit && pointerToDocPos(fragmentHit, cellHit)).toBe(14);
  });
});
