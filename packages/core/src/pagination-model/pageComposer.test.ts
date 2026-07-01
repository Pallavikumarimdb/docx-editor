import { describe, expect, test } from 'bun:test';

import { layOutPages } from './pageComposer';
import type { MeasuredLine, ParagraphBlock, ParagraphFragment, ParagraphMetrics } from './types';

function paragraph(id: string, lineCount = 1, attrs: ParagraphBlock['attrs'] = {}): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    attrs,
    runs: [{ kind: 'text', text: 'x'.repeat(lineCount) }],
  };
}

function metrics(...heights: number[]): ParagraphMetrics {
  return {
    kind: 'paragraph',
    totalHeight: heights.reduce((sum, height) => sum + height, 0),
    lines: heights.map(
      (lineHeight, index): MeasuredLine => ({
        fromRun: 0,
        fromChar: index,
        toRun: 0,
        toChar: index + 1,
        width: 10,
        ascent: lineHeight * 0.8,
        descent: lineHeight * 0.2,
        lineHeight,
      })
    ),
  };
}

function fragmentsFor(widowControl?: boolean): ParagraphFragment[] {
  const targetAttrs = widowControl === undefined ? {} : { widowControl };
  const blocks = [paragraph('filler'), paragraph('target', 4, targetAttrs)];
  const measures = [metrics(50), metrics(10, 10, 10, 10)];
  const layout = layOutPages(blocks, measures, {
    pageSize: { w: 100, h: 100 },
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
  });

  return layout.pages
    .flatMap((page) => page.fragments)
    .filter(
      (fragment): fragment is ParagraphFragment =>
        fragment.kind === 'paragraph' && fragment.blockId === 'target'
    );
}

describe('paragraph widow control', () => {
  test('undefined uses Word default and avoids a single next-page line', () => {
    const fragments = fragmentsFor();
    expect(fragments.map(({ fromLine, toLine }) => [fromLine, toLine])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  test('explicit false permits the natural 3+1 split', () => {
    const fragments = fragmentsFor(false);
    expect(fragments.map(({ fromLine, toLine }) => [fromLine, toLine])).toEqual([
      [0, 3],
      [3, 4],
    ]);
  });
});

describe('keepLines leading-gap fit', () => {
  const options = {
    pageSize: { w: 100, h: 100 },
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  };

  test('moves the whole paragraph when lines fit but the collapsed gap does not', () => {
    const blocks = [
      paragraph('previous', 1, { spacing: { after: 10 }, widowControl: false }),
      paragraph('kept', 3, {
        keepLines: true,
        widowControl: false,
        spacing: { before: 20 },
      }),
    ];

    const layout = layOutPages(blocks, [metrics(70), metrics(10, 10, 10)], options);

    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[0].fragments.map((fragment) => fragment.blockId)).toEqual(['previous']);
    expect(layout.pages[1].fragments).toHaveLength(1);
    expect(layout.pages[1].fragments[0]).toMatchObject({
      blockId: 'kept',
      y: 20,
      height: 30,
      fromLine: 0,
      toLine: 3,
    });
  });

  test('keeps the paragraph on the current page at an exact gap-inclusive fit', () => {
    const blocks = [
      paragraph('previous', 1, { spacing: { after: 10 }, widowControl: false }),
      paragraph('kept', 3, {
        keepLines: true,
        widowControl: false,
        spacing: { before: 20 },
      }),
    ];

    const layout = layOutPages(blocks, [metrics(50), metrics(10, 10, 10)], options);

    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0].fragments[1]).toMatchObject({
      blockId: 'kept',
      y: 70,
      height: 30,
      fromLine: 0,
      toLine: 3,
    });
  });
});
