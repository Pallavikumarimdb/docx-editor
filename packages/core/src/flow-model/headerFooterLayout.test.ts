import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EditorView } from 'prosemirror-view';
import { computeHfCaretRectFromView, invalidateHfDomCache } from './headerFooterLayout';

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
