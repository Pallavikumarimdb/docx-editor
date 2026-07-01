import { describe, expect, test } from 'bun:test';

import { layOutPages } from './pageComposer';
import type { ParagraphBlock, ParagraphFragment, ParagraphMetrics, MeasuredLine } from './types';

function paragraph(id: string, lineCount: number, widowControl?: boolean): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    runs: [{ kind: 'text', text: 'x'.repeat(lineCount) }],
    ...(widowControl === undefined ? {} : { attrs: { widowControl } }),
  };
}

function measure(lineCount: number, lineHeight: number): ParagraphMetrics {
  const lines: MeasuredLine[] = Array.from({ length: lineCount }, (_, index) => ({
    fromRun: 0,
    toRun: 0,
    fromChar: index,
    toChar: index + 1,
    width: 10,
    ascent: lineHeight,
    descent: 0,
    lineHeight,
  }));
  return { kind: 'paragraph', lines, totalHeight: lineCount * lineHeight };
}

function fragmentsFor(widowControl?: boolean): ParagraphFragment[] {
  const blocks = [paragraph('filler', 1), paragraph('target', 4, widowControl)];
  const measures = [measure(1, 50), measure(4, 10)];
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
