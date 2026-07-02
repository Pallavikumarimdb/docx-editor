import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { paragraphLayout } from '../flow-model/metrics/paragraphLayout';
import type { Page, ParagraphBlock, ParagraphFragment } from '../pagination-model/types';
import { paintPage } from './paintPage';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('anchored object paint parity', () => {
  test('paints a page-anchored topAndBottom image at its resolved band', () => {
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'image-anchor',
      runs: [
        {
          kind: 'image',
          src: '',
          width: 80,
          height: 20,
          displayMode: 'float',
          wrapType: 'topAndBottom',
          distTop: 3,
          distBottom: 5,
          position: {
            horizontal: { relativeTo: 'margin', align: 'center' },
            vertical: { relativeTo: 'page', align: 'center' },
          },
        },
        { kind: 'text', text: 'body text' },
      ],
    };
    const measure = paragraphLayout(block, 300);
    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      blockId: block.id,
      x: 50,
      y: 50,
      width: 300,
      height: measure.totalHeight,
      fromLine: 0,
      toLine: measure.lines.length,
    };
    const page: Page = {
      number: 1,
      size: { w: 400, h: 120 },
      margins: { top: 10, right: 50, bottom: 10, left: 50 },
      fragments: [fragment],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        blockLookup: new Map([[String(block.id), { block, measure }]]),
      }
    );

    const image = painted.querySelector<HTMLElement>('.layout-page-floating-image');
    const line = painted.querySelector<HTMLElement>('.layout-line');
    expect(image?.style.top).toBe('40px');
    expect(line?.style.marginTop).toBe('25px');
  });
});
