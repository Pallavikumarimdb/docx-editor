/**
 * The vertical gap between two content nodes.
 *
 * OOXML gives a paragraph a `spacing.before` and a `spacing.after`, and says
 * nothing about what happens where one paragraph's `after` meets the next one's
 * `before`. Word **collapses** them — the gap is the larger of the two, not
 * their sum — and that is what the editor's spacing suite pins
 * (`integration/contextual-spacing.test.ts` asserts `max(13, 5) === 13`).
 *
 * This is the single place that rule lives. Pagination reads it, and so does
 * column balancing, so a balanced column and a flowed one measure the same
 * paragraph to the same height.
 *
 * @packageDocumentation
 */

import type { ContentNode, ParagraphBlock } from './types';

/**
 * Space a content node asks for above itself, px.
 */
export function spaceBefore(node: ContentNode): number {
  return node.kind === 'paragraph' ? (node.attrs?.spacing?.before ?? 0) : 0;
}

/**
 * Space a content node asks for below itself, px.
 */
export function spaceAfter(node: ContentNode): number {
  return node.kind === 'paragraph' ? (node.attrs?.spacing?.after ?? 0) : 0;
}

/**
 * The gap Word actually leaves between `prev` and `next`.
 *
 * Two rules, in order:
 *
 *  1. **`w:contextualSpacing` (§17.3.1.9)** — "don't add space between
 *     paragraphs of the same style". It suppresses the gap only when *both*
 *     paragraphs opt in and they share a style: a bullet list closes up
 *     internally, but the space above the first bullet and below the last one
 *     survives, because their neighbours are a different style. A paragraph
 *     with no `styleId` has no style to match, so it never suppresses.
 *  2. **Collapse** — otherwise the gap is `max(prev.after, next.before)`.
 *
 * @param prev - the content node above, or null at the top of the flow
 * @param next - the content node below
 */
export function collapsedGap(prev: ContentNode | null, next: ContentNode): number {
  if (!prev) return spaceBefore(next);

  if (isContextuallySuppressed(prev, next)) return 0;

  return Math.max(spaceAfter(prev), spaceBefore(next));
}

/**
 * True when `w:contextualSpacing` cancels the gap between these two.
 */
function isContextuallySuppressed(prev: ContentNode, next: ContentNode): boolean {
  if (prev.kind !== 'paragraph' || next.kind !== 'paragraph') return false;

  const a = prev as ParagraphBlock;
  const b = next as ParagraphBlock;

  if (!a.attrs?.contextualSpacing || !b.attrs?.contextualSpacing) return false;

  const styleA = a.attrs.styleId;
  const styleB = b.attrs.styleId;
  return styleA != null && styleA === styleB;
}
