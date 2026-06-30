/**
 * Tab-stop arithmetic (ECMA-376 §17.3.1.37–38, `ST_TabJc` §17.18.84).
 *
 * One question, asked from two places: *the pen is at X — how far does this tab
 * push it?* The painter asks while laying glyphs into a line; the measurer asks
 * while breaking runs into lines. They must agree exactly, or a right-aligned
 * tab lands at a different column than the one the line was broken against, so
 * the answer lives here and nowhere else.
 *
 * Positions are **twips** on the way in (that is how `w:tabs` authors them) and
 * **px** on the way out (that is what the caller paints with).
 *
 * @packageDocumentation
 * @public
 */

import { twipsToPixels, pixelsToTwips } from '../../utils/units';
import { DEFAULT_TAB_STOP_TWIPS } from '../../docx/settingsParser';

/**
 * A tab stop, in the engine's spelling: `val` + `pos`.
 *
 * Note this is *not* the docx-types `TabMark` (`alignment` + `position`) — that
 * one is the parser's shape. Same concept, different vocabulary; the flow-model
 * translates between them.
 *
 * @public
 */
export interface TabMark {
  /** `ST_TabJc`, normalized. `clear` removes an inherited stop; `bar` draws a rule. */
  val: 'start' | 'end' | 'center' | 'decimal' | 'bar' | 'clear';
  /** Twips from the content-box left edge. */
  pos: number;
  leader?: 'none' | 'dot' | 'hyphen' | 'underscore' | 'heavy' | 'middleDot';
}

/**
 * Everything that decides where a paragraph's tabs land.
 *
 * @public
 */
export interface TabRuler {
  /** The paragraph's own `w:tabs`. */
  explicitStops?: TabMark[];
  /**
   * `w:ind w:left`, twips. Two jobs: a hanging-indent paragraph gets an
   * implicit stop here (which is how `"1.<tab>text"` aligns its body), and it
   * is where the default grid is anchored from.
   */
  leftIndent: number;
  /** `w:defaultTabStop` (§17.15.1.25), twips. Word's default is 720 (0.5in). */
  defaultStopTwips?: number;
}

/**
 * How far a tab at `currentX` advances the pen, and how the content after it
 * anchors to the stop it found.
 *
 * @public
 */
export interface TabAdvance {
  /** Px to advance. Always > 0. */
  width: number;
  alignment: TabMark['val'];
  leader?: TabMark['leader'];
}

/**
 * Content measured after the tab, so a non-`start` stop can anchor it.
 *
 * @public
 */
export interface TabAdvanceOptions {
  /** Px width of everything between this tab and the next tab / end of line. */
  followingWidth?: number;
  /** Px width of the following content up to its first `.` — for a `decimal` stop. */
  decimalPrefixWidth?: number;
}

/**
 * A tab must always move the pen. When every stop we can find would put the
 * following content at or behind the pen, we advance by this much rather than
 * returning zero — a zero-width tab collapses the line and the run after it
 * paints on top of the run before it.
 */
const MIN_ADVANCE_PX = 1;

/**
 * The pen is at `currentX` (px, from the content-box left edge). Find the stop
 * this tab lands on and return the advance.
 *
 * A stop is only a candidate if the content following the tab actually *fits*
 * after anchoring to it. A right-aligned stop whose anchored content would
 * start behind the pen is skipped, and the search moves to the next stop —
 * which is what Word does, and why the return is a search rather than a
 * subtraction.
 *
 * @public
 */
export function calculateTabWidth(
  currentX: number,
  ruler: TabRuler,
  options: TabAdvanceOptions = {}
): TabAdvance {
  const penTwips = pixelsToTwips(currentX);
  const gridTwips = ruler.defaultStopTwips ?? DEFAULT_TAB_STOP_TWIPS;
  const followingWidth = options.followingWidth ?? 0;
  const decimalPrefixWidth = options.decimalPrefixWidth ?? 0;

  for (const stop of candidateStops(penTwips, ruler, gridTwips)) {
    const stopX = twipsToPixels(stop.pos);
    const width = advanceTo(stopX, currentX, stop.val, followingWidth, decimalPrefixWidth);
    if (width > 0) {
      return { width, alignment: stop.val, leader: stop.leader };
    }
  }

  return { width: MIN_ADVANCE_PX, alignment: 'start' };
}

/**
 * The stops past the pen, nearest first.
 *
 * Word does not let a distant explicit stop suppress a nearer default-grid one:
 * the grid keeps running *between* custom stops (§17.6.13). So both sets are
 * candidates and we merge them in position order, rather than preferring one
 * source over the other.
 *
 * `clear` stops are removals, not stops. `bar` stops draw a vertical rule
 * without advancing the pen, so they are not landing places either.
 */
function* candidateStops(penTwips: number, ruler: TabRuler, gridTwips: number): Generator<TabMark> {
  const explicit = (ruler.explicitStops ?? [])
    .filter((s) => s.val !== 'clear' && s.val !== 'bar' && s.pos > penTwips)
    .sort((a, b) => a.pos - b.pos);

  // A hanging indent puts an implicit stop at the left indent — the column the
  // paragraph body hangs at. It only applies while the pen is still left of it,
  // i.e. on the first line, between the list marker and the body text.
  const implicit: TabMark[] =
    ruler.leftIndent > penTwips ? [{ val: 'start', pos: ruler.leftIndent }] : [];

  const fixed = [...implicit, ...explicit].sort((a, b) => a.pos - b.pos);

  // Walk the merged sequence lazily: emit every fixed stop in order, and fill
  // the gaps with grid stops. Bounded by the grid, so this always terminates.
  let gridPos = gridTwips > 0 ? (Math.floor(penTwips / gridTwips) + 1) * gridTwips : Infinity;
  let i = 0;

  // Cap the walk: the caller only ever needs a handful of candidates, and a
  // pathological ruler shouldn't spin here.
  for (let emitted = 0; emitted < 64; emitted++) {
    const nextFixed = fixed[i];
    if (!nextFixed && !Number.isFinite(gridPos)) return;

    if (nextFixed && (!Number.isFinite(gridPos) || nextFixed.pos <= gridPos)) {
      // A grid stop coinciding with an explicit one is the same column — skip it.
      if (nextFixed.pos === gridPos) gridPos += gridTwips;
      i++;
      yield nextFixed;
    } else {
      const pos = gridPos;
      gridPos += gridTwips;
      yield { val: 'start', pos };
    }
  }
}

/**
 * Px advance that puts the following content in the right relationship to a
 * stop at `stopX`. Non-positive means the content doesn't fit here.
 */
function advanceTo(
  stopX: number,
  currentX: number,
  alignment: TabMark['val'],
  followingWidth: number,
  decimalPrefixWidth: number
): number {
  switch (alignment) {
    // The content's *right* edge sits on the stop.
    case 'end':
      return stopX - followingWidth - currentX;
    // The content straddles the stop.
    case 'center':
      return stopX - followingWidth / 2 - currentX;
    // The content's decimal separator sits on the stop.
    case 'decimal':
      return stopX - decimalPrefixWidth - currentX;
    // `start` — the content's left edge sits on the stop. `bar` and `clear`
    // never reach here (they aren't candidates), but a left advance is the
    // right thing to do if one ever did.
    default:
      return stopX - currentX;
  }
}
