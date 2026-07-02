import { describe, expect, test } from 'bun:test';
import {
  mapFootnotesToPages,
  stabilizeFootnoteLayout,
  type FootnoteRefLocation,
} from '../footnoteLayout';
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
