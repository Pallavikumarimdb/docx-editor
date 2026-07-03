import { describe, expect, test } from 'bun:test';
import {
  buildFootnoteContentMap,
  mapFootnotesToPages,
  stabilizeFootnoteLayout,
  type FootnoteRefLocation,
} from '../footnoteLayout';
import { takeFootnoteSlice } from '../footnoteSlices';
import { layOutPages } from '../../pagination-model';
import type {
  FootnoteContent,
  LayoutOptions,
  MeasuredLine,
  Page,
  ParagraphBlock,
  ParagraphMetrics,
  TableBlock,
  TableMeasure,
} from '../../pagination-model/types';
import type { Footnote } from '../../types/document';

const layoutOpts: LayoutOptions = {
  pageSize: { w: 200, h: 140 },
  margins: { top: 10, right: 10, bottom: 10, left: 10 },
};

function line(lineHeight = 40): MeasuredLine {
  return {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 1,
    width: 10,
    ascent: lineHeight * 0.75,
    descent: lineHeight * 0.25,
    lineHeight,
  };
}

function paragraph(id: string, docFrom: number, footnoteRefId?: number): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    docFrom,
    docTo: docFrom + 2,
    runs: [
      {
        kind: 'text',
        text: 'x',
        docFrom,
        docTo: docFrom + 1,
        ...(footnoteRefId != null ? { footnoteRefId } : {}),
      },
    ],
  };
}

function paragraphMeasure(count: number, lineHeight = 40): ParagraphMetrics {
  return {
    kind: 'paragraph',
    lines: Array.from({ length: count }, () => line(lineHeight)),
    totalHeight: count * lineHeight,
  };
}

function bodyFixture() {
  const block = paragraph('body', 1, 7);
  const measure = paragraphMeasure(1, 20);
  const initialLayout = layOutPages([block], [measure], layoutOpts);
  const refs: FootnoteRefLocation[] = [{ footnoteId: 7, pmPos: 1 }];
  return { block, measure, initialLayout, refs };
}

describe('footnote continuation planning', () => {
  test('slices paragraphs at line boundaries and continues beyond the body', () => {
    const { block, measure, initialLayout, refs } = bodyFixture();
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      blocks: [paragraph('footnote-p', 100)],
      measures: [paragraphMeasure(7)],
      height: 280,
    };

    const result = stabilizeFootnoteLayout({
      blocks: [block],
      measures: [measure],
      layoutOpts,
      footnoteRefs: refs,
      footnoteContentMap: new Map([[7, content]]),
      initialLayout,
    });

    expect(result.converged).toBe(true);
    expect(result.layout.pages.length).toBe(4);
    expect(result.layout.pages[0].footnoteFragments?.[0]).toMatchObject({
      footnoteId: 7,
      continuesOnNext: true,
      blocks: [{ kind: 'paragraph', fromLine: 0, toLine: 2 }],
    });
    expect(result.layout.pages[1].footnoteFragments?.[0]).toMatchObject({
      continuesFromPrev: true,
      continuesOnNext: true,
      blocks: [{ kind: 'paragraph', fromLine: 2, toLine: 4 }],
    });
    expect(result.layout.pages[3].footnoteFragments?.[0]).toMatchObject({
      continuesFromPrev: true,
      blocks: [{ kind: 'paragraph', fromLine: 6, toLine: 7 }],
    });
    expect(result.layout.pages[3].footnoteFragments?.[0].continuesOnNext).toBeUndefined();
  });

  test('slices tables only between complete rows', () => {
    const { block, measure, initialLayout, refs } = bodyFixture();
    const table: TableBlock = {
      kind: 'table',
      id: 'footnote-table',
      rows: Array.from({ length: 5 }, (_, row) => ({
        id: `row-${row}`,
        cells: [{ id: `cell-${row}`, blocks: [] }],
      })),
    };
    const tableMeasure: TableMeasure = {
      kind: 'table',
      rows: Array.from({ length: 5 }, () => ({
        height: 45,
        cells: [{ blocks: [], width: 180 }],
      })),
      columnWidths: [180],
      totalWidth: 180,
      totalHeight: 225,
    };
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      blocks: [table],
      measures: [tableMeasure],
      height: 225,
    };

    const result = stabilizeFootnoteLayout({
      blocks: [block],
      measures: [measure],
      layoutOpts,
      footnoteRefs: refs,
      footnoteContentMap: new Map([[7, content]]),
      initialLayout,
    });

    expect(result.layout.pages.map((page) => page.footnoteFragments?.[0]?.blocks[0])).toEqual([
      expect.objectContaining({ kind: 'table', fromRow: 0, toRow: 2 }),
      expect.objectContaining({ kind: 'table', fromRow: 2, toRow: 4 }),
      expect.objectContaining({ kind: 'table', fromRow: 4, toRow: 5 }),
    ]);
  });

  test('continues an oversized table row at safe line boundaries', () => {
    const cellParagraph = paragraph('long-cell', 100);
    const cellMeasure = paragraphMeasure(5);
    const table: TableBlock = {
      kind: 'table',
      id: 'long-row-table',
      rows: [{ id: 'row', cells: [{ id: 'cell', blocks: [cellParagraph] }] }],
    };
    const tableMeasure: TableMeasure = {
      kind: 'table',
      rows: [
        {
          height: 200,
          cells: [{ blocks: [cellMeasure], width: 180, height: 200 }],
        },
      ],
      columnWidths: [180],
      totalWidth: 180,
      totalHeight: 200,
    };
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      blocks: [table],
      measures: [tableMeasure],
      height: 200,
    };

    const first = takeFootnoteSlice(content, { blockIndex: 0, unitIndex: 0 }, 90, 0, true);
    expect(first.fragment?.blocks[0]).toMatchObject({
      kind: 'table',
      height: 80,
      fromRow: 0,
      toRow: 1,
      bottomClip: 120,
    });
    expect(first.cursor).toEqual({ blockIndex: 0, unitIndex: 0, unitOffset: 80 });

    const second = takeFootnoteSlice(content, first.cursor, 90, 0, true);
    expect(second.fragment?.blocks[0]).toMatchObject({
      kind: 'table',
      height: 80,
      topClip: 80,
      bottomClip: 40,
    });
    expect(second.cursor).toEqual({ blockIndex: 0, unitIndex: 0, unitOffset: 160 });

    const last = takeFootnoteSlice(content, second.cursor, 90, 0, true);
    expect(last.fragment?.blocks[0]).toMatchObject({
      kind: 'table',
      height: 40,
      topClip: 160,
    });
    expect(last.done).toBe(true);
  });

  test('materializes a requested minimum page count', () => {
    const block = paragraph('body', 1);
    const layout = layOutPages([block], [paragraphMeasure(1, 20)], {
      ...layoutOpts,
      minimumPageCount: 4,
    });

    expect(layout.pages).toHaveLength(4);
    expect(layout.pages.slice(1).every((page) => page.fragments.length === 0)).toBe(true);
  });

  test('converges to the same continuation plan on repeated runs', () => {
    const { block, measure, initialLayout, refs } = bodyFixture();
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      blocks: [paragraph('footnote-p', 100)],
      measures: [paragraphMeasure(5)],
      height: 200,
    };
    const args = {
      blocks: [block],
      measures: [measure],
      layoutOpts,
      footnoteRefs: refs,
      footnoteContentMap: new Map([[7, content]]),
      initialLayout,
    };

    const first = stabilizeFootnoteLayout(args);
    const second = stabilizeFootnoteLayout({ ...args, initialLayout: first.layout });

    expect(first.converged).toBe(true);
    expect(second.converged).toBe(true);
    expect(
      second.layout.pages.map((page) => ({
        reserved: page.footnoteReservedHeight,
        fragments: page.footnoteFragments,
      }))
    ).toEqual(
      first.layout.pages.map((page) => ({
        reserved: page.footnoteReservedHeight,
        fragments: page.footnoteFragments,
      }))
    );
  });

  test('resolves footnote columns independently for each physical page', () => {
    const blocks = [paragraph('page-one', 1, 1), paragraph('page-two', 11, 2)];
    const measures = [paragraphMeasure(1, 80), paragraphMeasure(1, 80)];
    const initialLayout = layOutPages(blocks, measures, layoutOpts);
    const contentMap = new Map<number, FootnoteContent>([
      [
        1,
        {
          id: 1,
          displayNumber: 1,
          blocks: [paragraph('footnote-one', 101)],
          measures: [paragraphMeasure(1, 20)],
          height: 20,
        },
      ],
      [
        2,
        {
          id: 2,
          displayNumber: 2,
          blocks: [paragraph('footnote-two', 201)],
          measures: [paragraphMeasure(1, 20)],
          height: 20,
        },
      ],
    ]);
    const result = stabilizeFootnoteLayout({
      blocks,
      measures,
      layoutOpts,
      footnoteRefs: [
        { footnoteId: 1, pmPos: 1 },
        { footnoteId: 2, pmPos: 11 },
      ],
      footnoteContentMap: contentMap,
      initialLayout,
      resolveFootnoteColumns: (pageNumber: number) => (pageNumber === 2 ? 2 : 1),
    });

    expect(result.layout.pages.map((page) => page.footnoteColumns)).toEqual([undefined, 2]);
  });

  test('moves dense reference lines until every footnote starts beside its reference', () => {
    const blocks = Array.from({ length: 5 }, (_, index) =>
      paragraph(`body-${index + 1}`, index * 10 + 1, index + 1)
    );
    const measures = blocks.map(() => paragraphMeasure(1, 5));
    const initialLayout = layOutPages(blocks, measures, layoutOpts);
    const footnoteContentMap = new Map<number, FootnoteContent>(
      blocks.map((_, index) => {
        const id = index + 1;
        return [
          id,
          {
            id,
            displayNumber: id,
            blocks: [paragraph(`footnote-${id}`, 100 + id * 10)],
            measures: [paragraphMeasure(1, 60)],
            height: 60,
          },
        ];
      })
    );
    const result = stabilizeFootnoteLayout({
      blocks,
      measures,
      layoutOpts,
      footnoteRefs: blocks.map((_, index) => ({
        footnoteId: index + 1,
        pmPos: index * 10 + 1,
      })),
      footnoteContentMap,
      initialLayout,
    });

    expect(result.converged).toBe(true);
    for (let id = 1; id <= blocks.length; id++) {
      const referencePage = result.layout.pages.find((page) =>
        page.fragments.some((fragment) => fragment.blockId === `body-${id}`)
      );
      const startPage = result.layout.pages.find((page) =>
        page.footnoteFragments?.some((fragment) => fragment.footnoteId === id)
      );
      const firstFragment = startPage?.footnoteFragments?.find(
        (fragment) => fragment.footnoteId === id
      );
      expect(startPage?.number).toBe(referencePage?.number);
      expect(firstFragment?.continuesFromPrev).toBeUndefined();
    }
  });
});

test('measures each footnote at its reference section column width', () => {
  const footnotes: Footnote[] = [
    { type: 'footnote', id: 1, content: [] },
    { type: 'footnote', id: 2, content: [] },
  ];
  const measuredWidths: number[] = [];

  buildFootnoteContentMap(
    footnotes,
    [{ footnoteId: 1 }, { footnoteId: 2 }],
    (footnoteId) => (footnoteId === 1 ? 180 : 78),
    {
      measureBlocks: (blocks, contentWidth) => {
        measuredWidths.push(contentWidth);
        return blocks.map(() => paragraphMeasure(1, 10));
      },
    }
  );

  expect(measuredWidths).toEqual([180, 78]);
});

test('footnote page lookup indexes pages once for many references', () => {
  const rawPages: Page[] = Array.from({ length: 200 }, (_, index) => ({
    number: index + 1,
    size: { w: 200, h: 140 },
    margins: layoutOpts.margins,
    fragments: [
      {
        kind: 'paragraph',
        blockId: `p-${index}`,
        x: 0,
        y: 0,
        width: 180,
        height: 20,
        docFrom: index * 10,
        docTo: index * 10 + 10,
        fromLine: 0,
        toLine: 1,
      },
    ],
  }));
  let numericPageReads = 0;
  const pages = new Proxy(rawPages, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) numericPageReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const refs: FootnoteRefLocation[] = Array.from({ length: 5_000 }, (_, index) => ({
    footnoteId: index,
    pmPos: 1995,
  }));

  const mapped = mapFootnotesToPages(pages, refs);

  expect(mapped.get(200)).toHaveLength(5_000);
  expect(numericPageReads).toBeLessThan(250);
});
