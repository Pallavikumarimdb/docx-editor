import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FootnoteContent, FootnoteFragment } from '../../pagination-model/types';
import {
  calculateFootnoteAreaRenderHeight,
  renderFootnoteArea,
  type FootnoteRenderItem,
} from './footnotes';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test('paints only a continuation slice in its planned column', () => {
  const content: FootnoteContent = {
    id: 9,
    displayNumber: 3,
    blocks: [
      {
        kind: 'paragraph',
        id: 'footnote-paragraph',
        runs: [{ kind: 'text', text: 'abc' }],
      },
    ],
    measures: [
      {
        kind: 'paragraph',
        lines: [0, 1, 2].map((fromChar) => ({
          fromRun: 0,
          fromChar,
          toRun: 0,
          toChar: fromChar + 1,
          width: 10,
          ascent: 30,
          descent: 10,
          lineHeight: 40,
        })),
        totalHeight: 120,
      },
    ],
    height: 120,
  };
  const fragment: FootnoteFragment = {
    footnoteId: 9,
    displayNumber: 3,
    height: 40,
    columnIndex: 1,
    continuesFromPrev: true,
    continuesOnNext: true,
    blocks: [
      {
        kind: 'paragraph',
        blockIndex: 0,
        y: 0,
        height: 40,
        fromLine: 1,
        toLine: 2,
      },
    ],
  };
  const items: FootnoteRenderItem[] = [{ displayNumber: '3', text: 'abc', content, fragment }];

  const area = renderFootnoteArea(
    items,
    200,
    { pageNumber: 2, totalPages: 3, section: 'body' },
    document,
    2
  );

  expect(area.dataset.continuesFromPrev).toBe('true');
  expect(area.dataset.continuesOnNext).toBe('true');
  expect(area.querySelector<HTMLElement>('.layout-footnote-separator')?.dataset.separatorKind).toBe(
    'continuation'
  );
  const columns = area.querySelectorAll('.layout-footnote-column');
  expect(columns).toHaveLength(2);
  expect(columns[0].querySelector('.layout-footnote-content')).toBeNull();
  const painted = columns[1].querySelector<HTMLElement>('.layout-footnote-content');
  expect(painted?.dataset.footnoteId).toBe('9');
  expect(painted?.dataset.footnoteColumn).toBe('1');
  expect(painted?.querySelector<HTMLElement>('[data-from-line]')?.dataset.fromLine).toBe('1');
  expect(painted?.querySelector<HTMLElement>('[data-to-line]')?.dataset.toLine).toBe('2');
  expect(calculateFootnoteAreaRenderHeight(items, 2)).toBe(52);
});
