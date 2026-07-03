import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { collectBodySpans, findBodyPmAnchor, findBodyPmAnchors } from './collectBodySpans';
import { resolveDomPosition } from './resolveDomPosition';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function positionedSpan(from: number, text: string, left: number): HTMLSpanElement {
  const span = document.createElement('span');
  span.dataset.docFrom = String(from);
  span.dataset.docTo = String(from + text.length);
  span.textContent = text;
  span.getBoundingClientRect = () => rect(left, 20, 100, 16);
  return span;
}

describe('body DOM position mapping', () => {
  beforeAll(() => GlobalRegistrator.register());
  afterEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: undefined,
    });
  });
  afterAll(() => GlobalRegistrator.unregister());

  test('excludes footnote-local PM ranges from body spans, anchors, and click hits', () => {
    const root = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'layout-page-content';
    const bodySpan = positionedSpan(20, 'Body', 10);
    body.appendChild(bodySpan);

    const footnoteArea = document.createElement('div');
    footnoteArea.className = 'layout-footnote-area';
    const footnoteSpan = positionedSpan(2, 'Footnote', 200);
    footnoteArea.appendChild(footnoteSpan);
    body.appendChild(footnoteArea);
    root.appendChild(body);
    document.body.appendChild(root);

    expect(collectBodySpans(root)).toEqual([bodySpan]);
    expect(findBodyPmAnchors(root).includes(footnoteSpan)).toBe(false);
    expect(findBodyPmAnchor(root, 2)).toBeNull();

    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: footnoteSpan.firstChild!, offset: 2 }),
    });
    expect(resolveDomPosition(root, 220, 28, 1)).toBeNull();
  });

  test.each([
    { text: 'e\u0301', ratio: 0.4, expectedOffset: 0 },
    { text: '👍🏽', ratio: 0.7, expectedOffset: 4 },
  ])(
    'snaps proportional fallback for $text to a grapheme boundary',
    ({ text, ratio, expectedOffset }) => {
      const root = document.createElement('div');
      const body = document.createElement('div');
      body.className = 'layout-page-content';
      const span = positionedSpan(10, text, 100);
      body.appendChild(span);
      root.appendChild(body);
      document.body.appendChild(root);

      expect(resolveDomPosition(root, 100 + ratio * 100, 28, 1)).toBe(10 + expectedOffset);
    }
  );
});
