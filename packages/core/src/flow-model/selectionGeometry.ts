/**
 * Selection rectangles from the layout model.
 *
 * The layout-math half of selection mapping. The painted DOM is the primary
 * source (see `resolveDomPosition.ts`) — it knows about ligatures and bidi and
 * fallback fonts, and this doesn't. But it can only answer for what is actually
 * painted, and two things routinely aren't: a page that virtualization hasn't
 * rendered, and the frame *before* a repaint lands. Falling back to layout math
 * there is the difference between a caret that blinks steadily and one that
 * disappears every time you type.
 *
 * **Coordinates are page-stack space**: origin at the top-left of page 1, pages
 * stacked with `pageGap` between them, layout px. The caller offsets that into
 * its overlay's space.
 *
 * @packageDocumentation
 */

import type { ContentNode, PageLayout, LayoutMetrics, Page } from '../pagination-model/types';
import { pageTopOffset } from './pointerTargetResolve';
import { getPositionRect, positionToX } from './pointerToDocPos';

/**
 * A highlight rectangle in page-stack space.
 *
 * @public
 */
export interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
}

/**
 * A caret in page-stack space. Zero-width; the height is what matters.
 *
 * @public
 */
export interface CaretPosition {
  x: number;
  y: number;
  height: number;
  pageIndex: number;
}

/**
 * The caret for a document position, or `null` when the layout can't place it.
 *
 * **Returns `null` for positions inside a table**, deliberately. A table's
 * fragments keep the *whole table's* position range — they have to, because
 * that's what selection maps through — so a position inside a cell can't be
 * narrowed from the fragment alone. Guessing would put the caret at the table's
 * top-left, which is worse than admitting we don't know: callers that care walk
 * the cells themselves, and callers that don't just fall back to the DOM.
 *
 * `pageHint` starts the page scan at a page instead of at zero. Positions are
 * usually queried in ascending document order (the comment sidebar does exactly
 * that, once per anchor), and a page never moves backwards between them — so
 * feeding the last answer back turns an O(anchors × pages) pass into
 * O(anchors + pages). On a long review document that is the difference between a
 * visible stall and no stall.
 *
 * @public
 */
export function getCaretPosition(
  layout: PageLayout,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  pmPos: number,
  pageHint = 0
): CaretPosition | null {
  const index = nodeIndex(nodes, metrics);

  for (let pi = Math.max(0, pageHint); pi < layout.pages.length; pi++) {
    const page = layout.pages[pi];

    for (const fragment of page.fragments) {
      if (fragment.kind === 'table') continue; // See the note above.
      if (!coversPosition(fragment, pmPos)) continue;

      const entry = index.get(String(fragment.nodeId));
      if (!entry) continue;

      const rect = getPositionRect(entry.block, entry.measure, fragment, pmPos);
      if (!rect) continue;

      return {
        x: rect.x,
        y: rect.y + pageTopOffset(layout, pi),
        height: rect.height,
        pageIndex: pi,
      };
    }
  }

  return null;
}

/**
 * Highlight rectangles for `[from, to)` — one per painted line the range covers.
 *
 * A range that crosses a page boundary partitions naturally: each page's
 * fragments contribute their own rectangles, each tagged with the page it's on.
 * There is no cross-page rectangle, because there is no such thing on screen.
 *
 * @public
 */
export function rectsForSelection(
  layout: PageLayout,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  from: number,
  to: number
): SelectionBox[] {
  if (to <= from) return [];

  const index = nodeIndex(nodes, metrics);
  const boxes: SelectionBox[] = [];

  for (let pi = 0; pi < layout.pages.length; pi++) {
    const page = layout.pages[pi];
    const pageTop = pageTopOffset(layout, pi);

    for (const fragment of page.fragments) {
      const entry = index.get(String(fragment.nodeId));
      if (!entry) continue;

      const fragFrom = fragment.docFrom;
      const fragTo = fragment.docTo;
      if (fragFrom === undefined || fragTo === undefined) continue;
      if (fragTo <= from || fragFrom >= to) continue;

      if (
        fragment.kind !== 'paragraph' ||
        entry.block.kind !== 'paragraph' ||
        entry.measure.kind !== 'paragraph'
      ) {
        // A table, image, or text box inside the range highlights whole — there
        // are no interior line boxes to clip to.
        boxes.push({
          x: fragment.x,
          y: fragment.y + pageTop,
          width: fragment.width,
          height: fragment.height,
          pageIndex: pi,
        });
        continue;
      }

      const block = entry.block;
      const measure = entry.measure;
      const lines = measure.lines;

      let y = fragment.y;

      for (let li = fragment.fromLine; li < fragment.toLine && li < lines.length; li++) {
        const line = lines[li];
        y += line.floatSkipBefore ?? 0;

        const lineFrom = linePosition(block, line.fromRun, line.fromChar);
        const lineTo = linePosition(block, line.toRun, line.toChar);

        if (lineFrom !== null && lineTo !== null && lineTo > from && lineFrom < to) {
          // Clip the highlight to the selected part of the line — a selection
          // that starts mid-line must not paint from the margin.
          const startPos = Math.max(from, lineFrom);
          const endPos = Math.min(to, lineTo);

          const x1 = fragment.x + positionToX(block, measure, line, startPos);
          const x2 = fragment.x + positionToX(block, measure, line, endPos);

          boxes.push({
            x: Math.min(x1, x2),
            y: y + pageTop,
            width: Math.max(Math.abs(x2 - x1), 0),
            height: line.lineHeight,
            pageIndex: pi,
          });
        }

        y += line.lineHeight;
      }
    }
  }

  return boxes;
}

/**
 * True when a selection reaches across a page boundary.
 *
 * @public
 */
export function isMultiPageSelection(boxes: SelectionBox[]): boolean {
  if (boxes.length === 0) return false;
  const first = boxes[0].pageIndex;
  return boxes.some((box) => box.pageIndex !== first);
}

/**
 * Group rectangles by the page they're painted on, so an overlay can render one
 * layer per page.
 *
 * @public
 */
export function groupBoxesByPage(boxes: SelectionBox[]): Map<number, SelectionBox[]> {
  const byPage = new Map<number, SelectionBox[]>();
  for (const box of boxes) {
    const list = byPage.get(box.pageIndex);
    if (list) list.push(box);
    else byPage.set(box.pageIndex, [box]);
  }
  return byPage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coversPosition(fragment: Page['fragments'][number], pmPos: number): boolean {
  const from = fragment.docFrom;
  const to = fragment.docTo;
  if (from === undefined) return false;
  return pmPos >= from && pmPos <= (to ?? from);
}

function linePosition(
  block: Extract<ContentNode, { kind: 'paragraph' }>,
  runIndex: number,
  charOffset: number
): number | null {
  const run = block.runs[runIndex];
  if (!run || run.docFrom === undefined) return null;
  return run.docFrom + charOffset;
}

function nodeIndex(
  nodes: ContentNode[],
  metrics: LayoutMetrics[]
): Map<string, { block: ContentNode; measure: LayoutMetrics }> {
  const map = new Map<string, { block: ContentNode; measure: LayoutMetrics }>();
  for (let i = 0; i < nodes.length; i++) {
    const measure = metrics[i];
    if (measure) map.set(String(nodes[i].id), { block: nodes[i], measure });
  }
  return map;
}
