/**
 * Vertical layout of a table cell's stacked nodes.
 *
 * Single source of truth for *where the lines of a cell's content sit*, used by
 * the row-break pageComposer (`tableRowBreak`), the selection-rect mapper
 * (`selectionGeometry`), and — by construction — matching what the painter
 * (`renderCellContent`) renders. Adjacent paragraphs' before/after spacing
 * collapses to the larger of the two (CSS margin-collapse / the body
 * pageComposer's rule); a paragraph's lines stack from its content top with no
 * before/after between them. Keeping these consumers on one model is what
 * prevents page breaks and selection highlights from drifting off the rendered
 * lines.
 */

import type { ContentNode, LayoutMetrics } from '../pagination-model/types';

export interface CellContentLayout {
  /** Per block, the top y of each line (relative to `startY`). Atomic/non-paragraph nodes → []. */
  lineTops: number[][];
  /**
   * All line bottoms in document order, plus one entry per atomic block (its
   * bottom) — the clean break points for the pageComposer.
   */
  flatBottoms: number[];
  /** Line/atomic-block ranges a horizontal page cut must never cross. */
  unbreakableRanges: Array<{ top: number; bottom: number }>;
  /** Total stacked height incl. the last block's trailing space-after. */
  contentHeight: number;
}

/**
 * Compute the collapsed vertical layout of a cell's nodes starting at `startY`.
 */
export function layoutCellContent(
  nodes: readonly ContentNode[] | undefined,
  nodeMetrics: readonly LayoutMetrics[] | undefined,
  startY: number
): CellContentLayout {
  const lineTops: number[][] = [];
  const flatBottoms: number[] = [];
  const unbreakableRanges: Array<{ top: number; bottom: number }> = [];
  let y = startY;
  let prevAfter = 0;
  const n = nodeMetrics?.length ?? 0;

  for (let i = 0; i < n; i++) {
    const measure = nodeMetrics![i];
    const block = nodes?.[i];
    if (block?.kind === 'paragraph' && measure?.kind === 'paragraph') {
      const spacing = block.attrs?.spacing;
      y += Math.max(prevAfter, spacing?.before ?? 0);
      const tops: number[] = [];
      for (const line of measure.lines) {
        y += line.floatSkipBefore ?? 0;
        const top = y;
        tops.push(y);
        y += line.lineHeight;
        flatBottoms.push(y);
        unbreakableRanges.push({ top, bottom: y });
      }
      lineTops.push(tops);
      prevAfter = spacing?.after ?? 0;
    } else if (measure && 'totalHeight' in measure && typeof measure.totalHeight === 'number') {
      // Nested table / non-paragraph: one atomic block (break only at its bottom).
      const top = y + prevAfter;
      y += prevAfter + measure.totalHeight;
      lineTops.push([]);
      flatBottoms.push(y);
      unbreakableRanges.push({ top, bottom: y });
      prevAfter = 0;
    } else {
      lineTops.push([]);
    }
  }

  // The painter renders the final block's trailing space-after as paddingBottom.
  return {
    lineTops,
    flatBottoms,
    unbreakableRanges,
    contentHeight: y - startY + prevAfter,
  };
}
