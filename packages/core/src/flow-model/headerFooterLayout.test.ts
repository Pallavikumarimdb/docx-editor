import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EditorView } from 'prosemirror-view';
import type { ParagraphBlock, TextBoxBlock } from '../pagination-model/types';
import {
  calculateHeaderFooterVisualBounds,
  computeHfCaretRectFromView,
  contributesToHeaderFooterFlowHeight,
  invalidateHfDomCache,
} from './headerFooterLayout';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('header/footer overlay story scoping', () => {
  test('resolves the caret only against hosts for the active relationship', () => {
    document.body.replaceChildren();
    for (const [rId, left] of [
      ['rId-first', 10],
      ['rId-second', 200],
    ] as const) {
      const host = document.createElement('div');
      host.className = 'layout-page-header';
      host.dataset.hfRId = rId;
      const ranged = document.createElement('div');
      ranged.dataset.docFrom = '0';
      ranged.dataset.docTo = '5';
      ranged.getBoundingClientRect = () =>
        ({ top: 20, left, right: left + 50, bottom: 40, width: 50, height: 20 }) as DOMRect;
      host.appendChild(ranged);
      document.body.appendChild(host);
    }

    const view = {
      state: { selection: { empty: true, head: 1 } },
    } as unknown as EditorView;
    invalidateHfDomCache();

    expect(computeHfCaretRectFromView(view, 'header', document, 'rId-second')).toEqual({
      top: 20,
      left: 201,
      height: 20,
    });
  });
});

describe('header/footer positioned text-box layout', () => {
  test('keeps a page-positioned topAndBottom box out of following header flow', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'header-top-and-bottom',
      width: 80,
      height: 20,
      content: [],
      displayMode: 'block',
      wrapType: 'topAndBottom',
      position: {
        vertical: { relativeTo: 'page', posOffset: 80 * 9_525 },
      },
    };
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-header-content',
      runs: [],
    };

    expect(contributesToHeaderFooterFlowHeight(textBox)).toBe(false);
    expect(contributesToHeaderFooterFlowHeight(followingParagraph)).toBe(true);
    expect(
      calculateHeaderFooterVisualBounds(
        [textBox, followingParagraph],
        [
          { kind: 'textBox', width: 80, height: 20, innerMeasures: [] },
          { kind: 'paragraph', lines: [], totalHeight: 70 },
        ],
        90,
        {
          section: 'header',
          pageSize: { w: 400, h: 200 },
          margins: { top: 40, right: 50, bottom: 40, left: 50, header: 20 },
        }
      )
    ).toEqual({ visualTop: 0, visualBottom: 80 });
  });
});
