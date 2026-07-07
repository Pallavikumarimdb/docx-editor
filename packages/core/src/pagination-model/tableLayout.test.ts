import { describe, expect, test } from 'bun:test';
import { layOutPages } from './pageComposer';
import type {
  ParagraphBlock,
  ParagraphMetrics,
  TableBlock,
  TableFragment,
  TableMetrics,
} from './types';

const LINE = 20;

function paragraph(id: string): ParagraphBlock {
  return { kind: 'paragraph', id, runs: [{ kind: 'text', text: id }] };
}

function paragraphMetrics(lines: number): ParagraphMetrics {
  return {
    kind: 'paragraph',
    totalHeight: lines * LINE,
    lines: Array.from({ length: lines }, (_, index) => ({
      fromRun: 0,
      fromChar: index,
      toRun: 0,
      toChar: index + 1,
      width: 20,
      ascent: 15,
      descent: 5,
      lineHeight: LINE,
    })),
  };
}

describe('table pagination', () => {
  test('moves a short row whole when it fits on a fresh page', () => {
    const first = paragraph('first');
    const second = paragraph('second');
    const block: TableBlock = {
      kind: 'table',
      id: 'table',
      columnWidths: [100],
      rows: [
        { id: 'row-1', cells: [{ id: 'cell-1', nodes: [first] }] },
        { id: 'row-2', cells: [{ id: 'cell-2', nodes: [second] }] },
      ],
    };
    const firstMetrics = paragraphMetrics(4);
    const secondMetrics = paragraphMetrics(2);
    const metrics: TableMetrics = {
      kind: 'table',
      columnWidths: [100],
      totalWidth: 100,
      totalHeight: 6 * LINE,
      rows: [
        {
          height: 4 * LINE,
          cells: [{ metrics: [firstMetrics], width: 100, height: 4 * LINE }],
        },
        {
          height: 2 * LINE,
          cells: [{ metrics: [secondMetrics], width: 100, height: 2 * LINE }],
        },
      ],
    };

    const layout = layOutPages([block], [metrics], {
      pageSize: { w: 816, h: 200 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    });
    const fragments = layout.pages
      .flatMap((page) => page.fragments)
      .filter((fragment): fragment is TableFragment => fragment.kind === 'table');

    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ fromRow: 0, toRow: 1 });
    expect(fragments[0].bottomClip).toBeUndefined();
    expect(fragments[1]).toMatchObject({ fromRow: 1, toRow: 2 });
    expect(fragments[1].topClip).toBeUndefined();
  });
});
