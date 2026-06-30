/**
 * The text-measurement port.
 *
 * Everything the engine knows about glyphs enters through this module, and it
 * has exactly two jobs:
 *
 *  - **Advance widths** come from a canvas 2D context. That is the only way to
 *    get them right, and it is the only thing we ask the canvas for.
 *  - **Vertical metrics** (ascent, descent, line height) come from the font's
 *    own bounding box when the platform reports one, and from a fixed ratio
 *    model when it doesn't.
 *
 * The split matters. `bun:test` has no DOM, so there is no canvas: the width
 * path is stubbed by the test and the vertical path takes the ratio branch,
 * which makes measurement a deterministic pure function of the inputs. That is
 * what lets the whole engine unit suite run headless.
 *
 * @packageDocumentation
 * @public
 */

import {
  twipsToPixels,
  pixelsToTwips,
  pointsToPixels,
  halfPointsToPixels,
  PIXELS_PER_INCH,
} from '../../utils/units';
import {
  getCachedFontMetrics,
  setCachedFontMetrics,
  getCachedTextWidth,
  setCachedTextWidth,
  clearAllCaches,
} from './cache';

/**
 * The font a run is painted in — the key the measurement port is memoised on.
 *
 * @public
 */
export interface FontStyle {
  fontFamily: string;
  /** Points. */
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
}

/**
 * A font's vertical metrics, px, for a given size.
 *
 * @public
 */
export interface FontMetrics {
  ascent: number;
  descent: number;
  /** `ascent + descent` — the natural single-spaced line height. */
  lineHeight: number;
}

/**
 * A measured string.
 *
 * @public
 */
export interface TextMeasurement {
  width: number;
  height: number;
  ascent: number;
  descent: number;
}

/**
 * A measured run: its text metrics plus the per-character advances that
 * hit-testing needs to find the caret column inside it.
 *
 * @public
 */
export interface RunMeasurement extends TextMeasurement {
  /** Cumulative advance after each character; `length === text.length`. */
  charWidths: number[];
}

/**
 * Ratio model used when the platform reports no font bounding box (headless
 * tests, and any browser that declines the metric).
 *
 * The two ratios sum to 1.15, which is deliberately the same figure as the
 * empty-paragraph floor below: under the ratio model a blank line and a line of
 * text are exactly as tall, so a paragraph doesn't visibly jump as you type the
 * first character into it.
 */
const FALLBACK_ASCENT_RATIO = 0.9;
const FALLBACK_DESCENT_RATIO = 0.25;

/**
 * Word's single line spacing for its default fonts sits a little above the
 * font's own box. We floor every line at this multiple of the font size so a
 * paragraph never paints tighter than Word would set it.
 *
 * Pinned by `metrics/__tests__/empty-paragraph-floor.test.ts` — read that test
 * before changing the constant.
 */
export const WORD_SINGLE_LINE_RATIO = 1.15;

const FALLBACK_FONT_FAMILY = 'Calibri';
const FALLBACK_FONT_SIZE_PT = 11;

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** The measuring context, once we've successfully made one. */
let measuringContext: CanvasRenderingContext2D | null = null;

/**
 * The 2D context used for glyph advances, or `null` when there is no DOM.
 *
 * The absence of a canvas is deliberately **not** memoised. A canvas can appear
 * after the first lookup — a test installs a stub, a headless renderer mounts a
 * DOM — and a cached "there is no canvas" would keep every later measurement on
 * the zero-width path for the life of the process. Re-probing costs a `typeof`.
 *
 * When one does appear, every width memoised before it is wrong (they were all
 * taken without glyphs), so the caches are dropped at that moment.
 *
 * @public
 */
export function getCanvasContext(): CanvasRenderingContext2D | null {
  if (measuringContext) return measuringContext;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  const created = (canvas.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
  if (!created) return null;

  measuringContext = created;
  // EVERY memo taken before now was built from zero-width glyphs — including
  // whole paragraph layouts, which would otherwise stay one-line-per-paragraph
  // for the life of the process.
  clearAllCaches();
  return measuringContext;
}

/**
 * Drop the measuring context and every measurement taken through it.
 *
 * Tests call this after swapping a canvas stub. The app calls it when a webfont
 * finishes loading: every width taken before the face arrived was measured
 * against a fallback face, and is now wrong.
 *
 * @public
 */
export function resetCanvasContext(): void {
  measuringContext = null;
  clearAllCaches();
}

/**
 * The CSS `font` shorthand for a style — what the canvas wants, and what the
 * width cache is keyed on.
 *
 * @public
 */
export function toCssFont(style: FontStyle): string {
  const parts: string[] = [];
  if (style.italic) parts.push('italic');
  if (style.bold) parts.push('bold');
  parts.push(`${pointsToPixels(style.fontSize)}px`);
  parts.push(quoteFamily(style.fontFamily));
  return parts.join(' ');
}

/**
 * A DOCX font name is attacker-controlled, and it is interpolated into a CSS
 * font shorthand. Quote it, and escape what a quote can't contain, so a crafted
 * family name can't terminate the declaration and inject another.
 */
function quoteFamily(family: string): string {
  const escaped = family.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Vertical metrics
// ---------------------------------------------------------------------------

/**
 * Ascent, descent, and natural line height for a font, px.
 *
 * @public
 */
export function fontMetricsFor(style: FontStyle): FontMetrics {
  const key = toCssFont(style);
  const cached = getCachedFontMetrics(key);
  if (cached) return cached;

  const fontSizePx = pointsToPixels(style.fontSize);
  const metrics = readFontBoundingBox(key, fontSizePx) ?? ratioMetrics(fontSizePx);

  setCachedFontMetrics(key, metrics);
  return metrics;
}

/**
 * Read the font's own bounding box off the canvas. Returns null whenever the
 * platform doesn't report one — no canvas, or a context (including our test
 * stubs) whose `measureText` result omits the font-box fields.
 */
function readFontBoundingBox(fontString: string, fontSizePx: number): FontMetrics | null {
  const ctx = getCanvasContext();
  if (!ctx) return null;

  ctx.font = fontString;
  const m = ctx.measureText('Hg') as TextMetrics | undefined;
  const ascent = m?.fontBoundingBoxAscent;
  const descent = m?.fontBoundingBoxDescent;
  if (typeof ascent !== 'number' || typeof descent !== 'number') return null;
  if (!(ascent > 0) || !(descent >= 0)) return null;

  return withFloor(ascent, descent, fontSizePx);
}

function ratioMetrics(fontSizePx: number): FontMetrics {
  return withFloor(
    fontSizePx * FALLBACK_ASCENT_RATIO,
    fontSizePx * FALLBACK_DESCENT_RATIO,
    fontSizePx
  );
}

/**
 * Apply the Word line-height floor. The extra height is leading — it belongs
 * below the baseline, so the ascent is untouched and the caret keeps sitting
 * where the glyphs actually are.
 */
function withFloor(ascent: number, descent: number, fontSizePx: number): FontMetrics {
  const natural = ascent + descent;
  const lineHeight = Math.max(natural, fontSizePx * WORD_SINGLE_LINE_RATIO);
  return { ascent, descent: lineHeight - ascent, lineHeight };
}

// ---------------------------------------------------------------------------
// Advance widths
// ---------------------------------------------------------------------------

/**
 * Painted width of a string in a font, px.
 *
 * @public
 */
export function measureTextWidth(text: string, style: FontStyle): number {
  if (text === '') return 0;

  const fontString = toCssFont(style);

  // Long strings are measured but not memoised. The cache is keyed by the string
  // itself, so a long string is a long key — and the hit rate on them is near
  // zero: a paragraph is measured word by word, while the caret's binary search
  // walks a *different* prefix at every step. Caching those would store O(n)
  // keys of O(n) length for one click on one run, which for a pathological
  // single-`w:t` document is hundreds of megabytes of keys.
  if (text.length > MAX_MEMOISED_RUN_CHARS) {
    return canvasWidth(text, fontString);
  }

  const key = cacheKey(fontString, text);
  const cached = getCachedTextWidth(key);
  if (cached !== undefined) return cached;

  const width = canvasWidth(text, fontString);
  setCachedTextWidth(key, width);
  return width;
}

/** Longer than any word; short enough that holding the key is cheap. */
const MAX_MEMOISED_RUN_CHARS = 256;

/**
 * The width memo's key: the font, then the text.
 *
 * The separator is a newline because a CSS font shorthand cannot contain one —
 * so no font name, however crafted, can make two different (font, text) pairs
 * collide on the same key and be served each other's width.
 */
function cacheKey(fontString: string, text: string): string {
  return `${fontString}\n${text}`;
}

/**
 * Without a canvas there are no glyphs to measure, so there is nothing
 * defensible to return. Zero is the honest answer: it makes the absence
 * obvious (every line comes out empty) instead of inventing a plausible-looking
 * width that would quietly bake a wrong wrap into the layout. The unit suite
 * always installs a stub; the browser always has a real canvas.
 */
function canvasWidth(text: string, fontString: string): number {
  const ctx = getCanvasContext();
  if (!ctx) return 0;
  ctx.font = fontString;
  return ctx.measureText(text).width;
}

/**
 * Measure a string: width plus the vertical metrics of its font.
 *
 * @public
 */
export function measureText(text: string, style: FontStyle): TextMeasurement {
  const { ascent, descent, lineHeight } = fontMetricsFor(style);
  return {
    width: measureTextWidth(text, style),
    height: lineHeight,
    ascent,
    descent,
  };
}

/**
 * Measure a run, including the per-character advances hit-testing needs.
 *
 * @public
 */
export function measureRun(text: string, style: FontStyle): RunMeasurement {
  return {
    ...measureText(text, style),
    charWidths: prefixAdvances(text, style),
  };
}

/**
 * Cumulative advance after each character of `text`, px.
 *
 * Measured cumulatively (prefix by prefix) rather than glyph by glyph, so the
 * numbers include the kerning between neighbours. Summing per-glyph widths
 * would drift from the painted string on any kerned pair.
 *
 * @public
 */
export function prefixAdvances(text: string, style: FontStyle): number[] {
  const advances: number[] = [];
  for (let i = 1; i <= text.length; i++) {
    // Snap off the low half of a surrogate pair. Slicing through an emoji
    // measures a lone surrogate — which the canvas renders as tofu, not as
    // nothing — so the advance would be wrong AND the boundary would be one no
    // caret may occupy.
    advances.push(measureTextWidth(text.slice(0, snapToCodePoint(text, i)), style));
  }
  return advances;
}

/**
 * Index of the character boundary nearest `x` within a run, px from its start.
 *
 * Returns a boundary in `[0, text.length]` — the caret sits *between* characters,
 * so both ends are valid answers.
 *
 * The search measures **prefixes on demand**, never the whole advance table.
 * That matters because the run this is called on is not line-bounded: a DOCX may
 * hold a single `w:t` of half a million characters with no space in it, which
 * the line breaker cannot split and so places whole. Building the advance table
 * for that would be O(n) canvas measures over O(n)-length strings — a single
 * click would hang the tab. Measuring `log₂(n)` prefixes instead is ~20 measures
 * for a 500k-character run.
 *
 * @public
 */
export function charIndexAtX(text: string, style: FontStyle, x: number): number {
  if (text.length === 0 || x <= 0) return 0;
  if (x >= measureTextWidth(text, style)) return text.length;

  // Smallest boundary whose prefix width is >= x. Monotonic, because advances
  // are non-negative.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixWidth(text, style, mid) < x) lo = mid + 1;
    else hi = mid;
  }

  // `lo` is the boundary at or past x. Snap to whichever side of the straddled
  // character is nearer — that is what puts the caret on the side of the glyph
  // the user actually clicked.
  if (lo === 0) return 0;
  const leftEdge = prefixWidth(text, style, lo - 1);
  const rightEdge = prefixWidth(text, style, lo);
  const nearest = x - leftEdge <= rightEdge - x ? lo - 1 : lo;

  // The prefixes were measured at code-point boundaries, but the INDEX still has
  // to be one: clicking the left half of a lone emoji lands on index 1, between
  // its two surrogate halves. Handing that to ProseMirror as a document position
  // puts the caret inside a character.
  return snapToCodePoint(text, nearest);
}

/**
 * Width of the first `count` characters, snapped to a whole code point.
 *
 * Slicing at a raw index can land between the two halves of a surrogate pair
 * (an emoji, a rare CJK glyph), which measures as a lone replacement character
 * and puts the caret in the middle of something indivisible. Snapping keeps
 * every boundary a real one.
 */
function prefixWidth(text: string, style: FontStyle, count: number): number {
  return measureTextWidth(text.slice(0, snapToCodePoint(text, count)), style);
}

/**
 * Move `index` off the low half of a surrogate pair, if it landed there.
 *
 * @public
 */
export function snapToCodePoint(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;

  const code = text.charCodeAt(index);
  // A trailing surrogate at `index` means `index - 1` is its leading half, and
  // the boundary is really one character earlier.
  const isTrailingSurrogate = code >= 0xdc00 && code <= 0xdfff;
  return isTrailingSurrogate ? index - 1 : index;
}

/**
 * X offset of a character boundary within a run, px from its start. The inverse
 * of {@link charIndexAtX}.
 *
 * @public
 */
export function getXForCharacter(text: string, style: FontStyle, index: number): number {
  const clamped = Math.max(0, Math.min(index, text.length));
  if (clamped === 0) return 0;
  return measureTextWidth(text.slice(0, clamped), style);
}

/**
 * The font a run is painted in, with the document's defaults filled in for
 * whatever the run left unset.
 *
 * @public
 */
export function resolveFontStyle(
  run: { fontSize?: number; fontFamily?: string; bold?: boolean; italic?: boolean } | undefined,
  defaults?: { fontSize?: number; fontFamily?: string }
): FontStyle {
  return {
    fontFamily: run?.fontFamily ?? defaults?.fontFamily ?? FALLBACK_FONT_FAMILY,
    fontSize: run?.fontSize ?? defaults?.fontSize ?? FALLBACK_FONT_SIZE_PT,
    bold: run?.bold,
    italic: run?.italic,
  };
}

// ---------------------------------------------------------------------------
// Unit conversions
//
// Re-exported here under the engine's short names so a measurement site reads
// as one vocabulary. The arithmetic lives in `utils/units.ts` and is not
// duplicated: 1440 twips = 1 inch and 914400 EMU = 1 inch are fixed by the
// format; 96 px/inch is the CSS rendering assumption.
// ---------------------------------------------------------------------------

/** Twips → px. @public */
export function twipsToPx(twips: number): number {
  return twipsToPixels(twips);
}

/** Px → twips. @public */
export function pxToTwips(px: number): number {
  return pixelsToTwips(px);
}

/** Points → px (1 pt = 4/3 px at 96 dpi). @public */
export function ptToPx(points: number): number {
  return pointsToPixels(points);
}

/** Px → points. @public */
export function pxToPt(px: number): number {
  return (px * 72) / PIXELS_PER_INCH;
}

/** Half-points (`w:sz`) → px. @public */
export function halfPtToPx(halfPoints: number): number {
  return halfPointsToPixels(halfPoints);
}

/** Px → half-points. @public */
export function pxToHalfPt(px: number): number {
  return pxToPt(px) * 2;
}
