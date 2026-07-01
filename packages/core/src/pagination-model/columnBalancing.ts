/**
 * Column balancing.
 *
 * When a multi-column region ends — a two-column pull-quote in a one-column
 * article, or the end of the document — Word evens the columns out rather than
 * filling the first to the bottom and leaving the last nearly empty. It does
 * this by shortening the region: give every column a bottom at
 * `total / count` and the ordinary column flow produces balanced columns for
 * free, with no second pass and no fragment shuffling.
 *
 * That is what this computes: not the layout, just the *bottom* the flow should
 * use.
 *
 * BEST-EFFORT. Nothing in ECMA-376 mandates balancing, no test pins it, and it
 * has not been checked against Word — see `tasks.md` §10.1. It is deliberately
 * conservative: it declines (returns null) on anything it isn't sure about, and
 * declining just means the region flows unbalanced, which is never *wrong*, only
 * less pretty.
 *
 * @packageDocumentation
 */

import type { ColumnLayout, ContentNode, LayoutMetrics } from './types';
import { collapsedGap } from './blockSpacingRules';

/**
 * The region a balanced multi-column stretch flows into.
 */
export interface BalancingRegion {
  /** Y where the multi-column region begins on its page. */
  top: number;
  /** Y where the page's content box ends. */
  bottom: number;
  columns: ColumnLayout;
}

/**
 * The bottom the flow should use so `nodes[start..end)` come out balanced
 * across `region.columns`, or `null` to leave the region alone.
 *
 * Declines when:
 *
 *  - there is only one column (nothing to balance);
 *  - the stretch holds anything but paragraphs. A table or an image can't be
 *    cut to an arbitrary height, so a balanced bottom would just push it whole
 *    into the next column and unbalance things worse than doing nothing;
 *  - the content is too tall to fit the region even unbalanced — it's going to
 *    spill onto another page, and the last page's columns are what Word
 *    balances, not this one;
 *  - the balanced height isn't actually shorter than the region. Nothing to do.
 */
export function balancedColumnBottom(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  start: number,
  end: number,
  region: BalancingRegion
): number | null {
  const count = region.columns.count;
  if (count <= 1) return null;

  const height = paragraphOnlyHeight(nodes, metrics, start, end);
  if (height === null || height <= 0) return null;

  const regionHeight = region.bottom - region.top;
  if (regionHeight <= 0) return null;
  if (height > regionHeight * count) return null; // Spills off the page anyway.

  const balanced = Math.ceil(height / count);
  if (balanced <= 0 || balanced >= regionHeight) return null;

  return region.top + balanced;
}

/**
 * Total flowed height of `nodes[start..end)`, or null if the stretch holds
 * something that isn't a paragraph.
 *
 * A trailing section break is not content and doesn't disqualify the stretch —
 * it's the very thing that delimits it.
 */
function paragraphOnlyHeight(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  start: number,
  end: number
): number | null {
  let total = 0;
  let sawText = false;
  let prev: ContentNode | null = null;

  for (let i = start; i < end; i++) {
    const node = nodes[i];
    const nodeMetrics = metrics[i];

    if (node.kind === 'sectionBreak') continue;

    if (node.kind !== 'paragraph' || nodeMetrics?.kind !== 'paragraph') return null;

    // Measure the stretch exactly the way the flow will lay it out: the
    // collapsed gap between neighbours, plus the paragraph's own lines.
    //
    // Not `spaceBefore + totalHeight + spaceAfter`. That double-counts, because
    // `totalHeight` ALREADY includes the paragraph's before/after — and it sums
    // adjacent spacing where the flow collapses it. A balanced height computed
    // from the wrong total puts the column bottom in the wrong place, which is
    // worse than not balancing at all.
    total += collapsedGap(prev, node);
    total += nodeMetrics.lines.reduce(
      (h, line) => h + line.lineHeight + (line.floatSkipBefore ?? 0),
      0
    );

    sawText ||= nodeMetrics.lines.length > 0;
    prev = node;
  }

  return sawText ? total : null;
}
