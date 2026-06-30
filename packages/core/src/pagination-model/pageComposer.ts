/**
 * The flow — blocks and their measures in, positioned pages out.
 *
 * This is a fold. The layout cursor (which page, which column, where the pen
 * sits) is a **value** threaded through the placement functions, not an object
 * they mutate: every `place*` takes a cursor and returns the cursor that
 * results. Break rules are pure predicates over that value. The point isn't
 * purity for its own sake — it's that "why did this paragraph land on page 4"
 * is answerable by reading one call chain, instead of by reconstructing the
 * history of a mutable pen.
 *
 * The one thing that *is* accumulated is the page list itself, because a page
 * is genuinely append-only: fragments go on, nothing comes off.
 *
 * @packageDocumentation
 */

import type {
  FlowBlock,
  ImageBlock,
  ImageMeasure,
  Layout,
  LayoutOptions,
  Measure,
  Page,
  ParagraphBlock,
  ParagraphMetrics,
  SectionLayoutConfig,
  TableMeasure,
  TextBoxBlock,
  TextBoxMeasure,
} from './types';
import { assertExhaustiveFlowBlock } from './types';
import { collectSectionConfigs } from './sectionPlan';
import {
  FIT_TOLERANCE_PX,
  applyKeepNext,
  nextColumn,
  overflow,
  pageIsEmpty,
  currentRegion,
  regionIsEmpty,
  startPage,
  type LayoutCursor,
  type FlowContext,
  type PageDraft,
  type ColumnRegion,
} from './layoutCursor';
import { collapsedGap } from './blockSpacingRules';
import { isFloatingTextBoxBlock } from './textBoxFlow';
import { layoutTable } from './tableLayout';
import { balancedColumnBottom } from './columnBalancing';

/** Word's default gap painted between pages, px. */
const DEFAULT_PAGE_GAP_PX = 24;

/**
 * Flow measured blocks onto pages.
 *
 * `blocks` and `measures` are index-aligned: `measures[i]` is how tall
 * `blocks[i]` is at the width it will be laid out in. Measurement has already
 * happened — this function never measures anything, which is what lets the
 * whole flow be tested with synthetic measures and no canvas.
 *
 * @public
 */
export function layOutPages(
  blocks: FlowBlock[],
  measures: Measure[],
  options: LayoutOptions
): Layout {
  const initial: SectionLayoutConfig = {
    pageSize: options.pageSize,
    margins: options.margins,
    columns: options.columns,
  };
  const final: SectionLayoutConfig = {
    pageSize: options.finalPageSize ?? options.pageSize,
    margins: options.finalMargins ?? options.margins,
    columns: options.columns,
    startType: options.bodyBreakType,
  };

  const schedule = collectSectionConfigs(blocks, initial, final);

  const ctx: FlowContext = {
    blocks,
    measures,
    options,
    pages: [],
    // The first section's geometry is the *first* schedule entry, which is the
    // one closed by the first break — not `initial`, which is only the
    // inheritance seed. They agree unless the document overrides geometry on
    // its opening section.
    section: schedule.configs[0] ?? initial,
  };

  // An empty document is still one page. Word shows a blank sheet, not nothing.
  let cursor = startPage(ctx);
  let sectionIndex = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const measure = measures[i];

    switch (block.kind) {
      case 'sectionBreak': {
        sectionIndex++;
        const next = schedule.configs[sectionIndex] ?? ctx.section;
        const sectionEnd = schedule.breakIndices[sectionIndex] ?? blocks.length;
        cursor = crossSectionBoundary(ctx, cursor, next, i + 1, sectionEnd);
        break;
      }

      case 'pageBreak':
        cursor = startPage(ctx, cursor.prev);
        break;

      case 'columnBreak':
        cursor = nextColumn(ctx, cursor);
        break;

      case 'paragraph':
        cursor = placeParagraph(ctx, cursor, block, measure as ParagraphMetrics, i);
        break;

      case 'table':
        cursor = layoutTable(ctx, cursor, block, measure as TableMeasure, i);
        break;

      case 'image':
        cursor = placeImage(ctx, cursor, block, measure as ImageMeasure, i);
        break;

      case 'textBox':
        cursor = placeTextBox(ctx, cursor, block, measure as TextBoxMeasure, i);
        break;

      default:
        assertExhaustiveFlowBlock(block, 'layOutPages');
    }
  }

  return finish(ctx, options);
}

/**
 * The bottom of everything painted in the page's current column region — the Y
 * the flow must resume at when it leaves that region.
 */
function regionBottomOf(page: PageDraft): number {
  let bottom = page.columnRegionTop ?? page.margins.top;
  for (const fragment of page.fragments) {
    if (fragment.columnIndex === undefined) continue;
    bottom = Math.max(bottom, fragment.y + fragment.height);
  }
  return bottom;
}

/**
 * Apply a section's start type (`w:type`, §17.6.22).
 *
 * `continuous` keeps the pen where it is — the new section's *column* layout
 * takes effect on the same page, which is how a two-column pull-quote sits in
 * the middle of a one-column article. Its page size can't take effect mid-page,
 * and Word doesn't try either.
 *
 * `evenPage`/`oddPage` break until the page number has the right parity, which
 * is how a chapter always opens on a recto. These have no test oracle yet — see
 * `tasks.md` §10.1.
 */
function crossSectionBoundary(
  ctx: FlowContext,
  cursor: LayoutCursor,
  next: SectionLayoutConfig,
  sectionStart: number,
  sectionEnd: number
): LayoutCursor {
  ctx.section = next;

  switch (next.startType) {
    case 'continuous': {
      // Re-columnise the current page from the pen down. The page keeps the size
      // it was born with — a page cannot change dimensions halfway.
      const page = ctx.pages[cursor.pageIndex];

      // The pen is wherever the last column left it, which is somewhere up inside
      // that column. Content after the region has to resume BELOW the whole
      // region — below every column of it — or it paints straight over the text
      // it was supposed to follow. This is the flagship case: a two-column
      // pull-quote in a one-column article, and the article resuming underneath it.
      const resumeY = page.columns ? regionBottomOf(page) : cursor.y;

      page.columns = (next.columns?.count ?? 1) > 1 ? next.columns : undefined;

      // Both of these belong to the region we are *leaving*. A section returning
      // to one column must not inherit the previous section's balanced bottom, or
      // its text would break to a new page a third of the way down.
      page.columnBalanceBottom = undefined;
      page.columnRegionTop = undefined;

      cursor = { ...cursor, y: resumeY, columnIndex: 0 };

      if (page.columns) {
        // The new region starts at the pen, not at the top margin — its columns
        // sit side by side BELOW whatever single-column text precedes them.
        page.columnRegionTop = cursor.y;

        const bottom = balancedColumnBottom(ctx.blocks, ctx.measures, sectionStart, sectionEnd, {
          top: cursor.y,
          bottom: page.size.h - page.margins.bottom - (page.footnoteReservedHeight ?? 0),
          columns: page.columns,
        });
        if (bottom !== null) page.columnBalanceBottom = bottom;
      }

      return cursor;
    }

    case 'nextColumn':
      return nextColumn(ctx, cursor);

    case 'evenPage':
    case 'oddPage': {
      // A chapter that must open on a recto. Word inserts blank pages until the
      // parity is right — but only as many as it needs. Starting a page
      // unconditionally would burn one even when the pen is already on an empty
      // page of the correct parity, so the document grows a blank sheet that
      // Word does not have.
      const wantEven = next.startType === 'evenPage';
      const hasParity = (c: LayoutCursor): boolean =>
        (ctx.pages[c.pageIndex].number % 2 === 0) === wantEven;

      let c = pageIsEmpty(ctx, cursor) ? cursor : startPage(ctx, cursor.prev);
      while (!hasParity(c)) {
        c = startPage(ctx, cursor.prev);
      }
      return c;
    }

    case 'nextPage':
    default:
      return startPage(ctx, cursor.prev);
  }
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

/**
 * `w:widowControl` (§17.3.1.44) — never strand a single line of a paragraph on
 * either side of a page break. On by default in Word.
 *
 * BEST-EFFORT: this has no test oracle yet and has not been checked against
 * Word (see `tasks.md` §10.1 / §10a.7). It is deliberately conservative — it
 * only ever moves *one* line — so that when it is wrong it is wrong by a line,
 * not by a page.
 */
const MIN_LINES_EITHER_SIDE = 2;

function widowControlEnabled(block: ParagraphBlock): boolean {
  return block.attrs?.widowControl !== false;
}

function placeParagraph(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  block: ParagraphBlock,
  measure: ParagraphMetrics,
  index: number
): LayoutCursor {
  // `w:pageBreakBefore` (§17.3.1.23) — start a new page even when this one has
  // room. Unless the page has nothing on it yet: the break has already happened,
  // and honouring it again would emit a blank page.
  let cursor = cursorIn;
  if (block.attrs?.pageBreakBefore && !pageIsEmpty(ctx, cursor)) {
    cursor = startPage(ctx, cursor.prev);
  }

  cursor = applyKeepNext(ctx, cursor, index);

  const lines = measure.lines;
  if (lines.length === 0) {
    return { ...cursor, prev: block };
  }

  // `w:keepLines` (§17.3.1.14) — keep the whole paragraph on one page, if it
  // can fit on one at all. Also best-effort; see the note above.
  if (block.attrs?.keepLines) {
    cursor = honourKeepLines(ctx, cursor, measure);
  }

  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const region = currentRegion(ctx, cursor);
    // The gap belongs to the paragraph's FIRST line, wherever that line ends up.
    // Keying it on "have we overflowed yet" instead would silently drop
    // `spacing.before` from every paragraph that widow control moved to the next
    // page — the commonest thing widow control does.
    const isFirstLine = lineIndex === 0;
    const gap = isFirstLine ? collapsedGap(cursor.prev, block) : 0;
    const top = cursor.y + gap;

    let count = countLinesThatFit(lines, lineIndex, region.bottom - top);

    if (count === 0) {
      // Not even one line fits. Move on — unless we are already at the top of an
      // empty region, in which case the line is taller than the page and moving
      // would loop forever. Overflow it instead.
      // Nothing fits. Move on — but ONLY if there is somewhere to move to.
      //
      // On an empty region there is not: `overflow` preserves `prev`, so the gap
      // is recomputed to the same value on the fresh page, nothing fits there
      // either, and the composer emits pages until the tab dies. (A single line
      // taller than the content box does this, and so does a `w:cantSplit` row
      // taller than a page — both are ordinary malformed-document shapes.)
      // An empty region is where we stop asking and place the thing anyway.
      if (!regionIsEmpty(ctx, cursor)) {
        cursor = overflow(ctx, cursor);
        continue;
      }
      count = 1;
    }

    count = applyWidowControl(block, lines, lineIndex, count, isFirstLine, ctx, cursor);
    if (count === 0) {
      cursor = overflow(ctx, cursor);
      continue;
    }

    const height = sliceHeight(lines, lineIndex, lineIndex + count);
    const endLine = lineIndex + count;

    ctx.pages[cursor.pageIndex].fragments.push({
      kind: 'paragraph',
      blockId: block.id,
      x: region.left,
      y: top,
      width: region.width,
      height,
      fromLine: lineIndex,
      toLine: endLine,
      columnIndex: cursor.columnIndex,
      ...(lineIndex > 0 ? { continuesFromPrev: true } : {}),
      ...(endLine < lines.length ? { continuesOnNext: true } : {}),
      ...fragmentRange(block, measure, lineIndex, endLine),
    });

    cursor = { ...cursor, y: top + height, prev: block };
    lineIndex = endLine;

    if (lineIndex < lines.length) {
      cursor = overflow(ctx, cursor);
    }
  }

  return cursor;
}

/**
 * How many lines starting at `from` fit in `available` px.
 *
 * A line's footprint includes the `floatSkipBefore` it was pushed down by: the
 * gap under a float is space the line occupies, even though no glyph paints in it.
 */
function countLinesThatFit(
  lines: ParagraphMetrics['lines'],
  from: number,
  available: number
): number {
  let used = 0;
  let count = 0;
  for (let i = from; i < lines.length; i++) {
    const h = lines[i].lineHeight + (lines[i].floatSkipBefore ?? 0);
    if (used + h > available + FIT_TOLERANCE_PX) break;
    used += h;
    count++;
  }
  return count;
}

function sliceHeight(lines: ParagraphMetrics['lines'], from: number, to: number): number {
  let h = 0;
  for (let i = from; i < to; i++) {
    h += lines[i].lineHeight + (lines[i].floatSkipBefore ?? 0);
  }
  return h;
}

/**
 * Trim the fitted line count so neither side of the break is left with a single
 * stranded line. Returns 0 to mean "move the whole thing to the next region".
 */
function applyWidowControl(
  block: ParagraphBlock,
  lines: ParagraphMetrics['lines'],
  from: number,
  count: number,
  isFirstFragment: boolean,
  ctx: FlowContext,
  cursor: LayoutCursor
): number {
  if (!widowControlEnabled(block)) return count;

  const remaining = lines.length - from;
  if (count >= remaining) return count; // No break here — nothing to strand.
  if (remaining < MIN_LINES_EITHER_SIDE * 2) {
    // Too short to satisfy both sides. Keeping it whole is the lesser evil, and
    // only if that's actually possible.
    if (isFirstFragment && !regionIsEmpty(ctx, cursor) && count < remaining) return 0;
    return count;
  }

  // An orphan: one line of this paragraph alone at the foot of the page.
  if (count < MIN_LINES_EITHER_SIDE) {
    if (isFirstFragment && !regionIsEmpty(ctx, cursor)) return 0;
    return count;
  }

  // A widow: one line alone at the head of the next page. Pull a line down to
  // join it — but not if that would strand this side instead.
  const carried = remaining - count;
  if (carried < MIN_LINES_EITHER_SIDE && count - 1 >= MIN_LINES_EITHER_SIDE) {
    return count - 1;
  }

  return count;
}

/** Move a `w:keepLines` paragraph whole, when a fresh region could hold it. */
function honourKeepLines(
  ctx: FlowContext,
  cursor: LayoutCursor,
  measure: ParagraphMetrics
): LayoutCursor {
  const region = currentRegion(ctx, cursor);
  const total = sliceHeight(measure.lines, 0, measure.lines.length);

  if (total > region.bottom - region.top + FIT_TOLERANCE_PX) return cursor; // Never fits.
  if (total <= region.bottom - cursor.y + FIT_TOLERANCE_PX) return cursor; // Fits here.
  if (regionIsEmpty(ctx, cursor)) return cursor;

  return overflow(ctx, cursor);
}

/**
 * The document-position range of a paragraph slice.
 *
 * The paragraph's own `docFrom`/`docTo` bracket the whole node, including its
 * boundary tokens. A slice that starts at line 0 owns the opening boundary, and
 * one that ends at the last line owns the closing one — so those ends take the
 * block's range. Every interior edge is derived from the line's run/char
 * address instead, which is what makes a continuation fragment's range cover
 * exactly the text it paints and nothing else.
 */
function fragmentRange(
  block: ParagraphBlock,
  measure: ParagraphMetrics,
  fromLine: number,
  toLine: number
): { docFrom?: number; docTo?: number } {
  const lines = measure.lines;

  const docFrom =
    fromLine === 0
      ? block.docFrom
      : runPosition(block, lines[fromLine]?.fromRun, lines[fromLine]?.fromChar);

  const last = lines[toLine - 1];
  const docTo =
    toLine >= lines.length ? block.docTo : runPosition(block, last?.toRun, last?.toChar);

  const range: { docFrom?: number; docTo?: number } = {};
  if (docFrom !== undefined) range.docFrom = docFrom;
  if (docTo !== undefined) range.docTo = docTo;
  return range;
}

/** Document position of a `(run, char)` address inside a paragraph. */
function runPosition(
  block: ParagraphBlock,
  runIndex: number | undefined,
  charOffset: number | undefined
): number | undefined {
  if (runIndex === undefined || charOffset === undefined) return undefined;
  const run = block.runs[runIndex];
  if (!run || run.docFrom === undefined) return undefined;
  return run.docFrom + charOffset;
}

// ---------------------------------------------------------------------------
// Images and text boxes
// ---------------------------------------------------------------------------

function placeImage(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  block: ImageBlock,
  measure: ImageMeasure,
  index: number
): LayoutCursor {
  let cursor = applyKeepNext(ctx, cursorIn, index);

  const anchored = block.anchor?.isAnchored === true;
  let region = currentRegion(ctx, cursor);
  let gap = collapsedGap(cursor.prev, block);

  if (!anchored && !fits(measure.height, cursor.y + gap, region) && !regionIsEmpty(ctx, cursor)) {
    cursor = overflow(ctx, cursor);
    region = currentRegion(ctx, cursor);
    gap = 0;
  }

  const y = anchored ? region.top + (block.anchor?.offsetV ?? 0) : cursor.y + gap;

  ctx.pages[cursor.pageIndex].fragments.push({
    kind: 'image',
    blockId: block.id,
    x: region.left + (anchored ? (block.anchor?.offsetH ?? 0) : 0),
    y,
    width: measure.width,
    height: measure.height,
    columnIndex: cursor.columnIndex,
    ...(anchored ? { isAnchored: true } : {}),
    ...(block.anchor?.behindDoc ? { zIndex: -1 } : {}),
    ...(block.docFrom !== undefined ? { docFrom: block.docFrom } : {}),
    ...(block.docTo !== undefined ? { docTo: block.docTo } : {}),
  });

  // An anchored image is painted out of flow — it never moves the pen.
  return anchored ? { ...cursor, prev: block } : { ...cursor, y: y + measure.height, prev: block };
}

function placeTextBox(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  block: TextBoxBlock,
  measure: TextBoxMeasure,
  index: number
): LayoutCursor {
  const floating = isFloatingTextBoxBlock(block);
  let cursor = floating ? cursorIn : applyKeepNext(ctx, cursorIn, index);

  let region = currentRegion(ctx, cursor);
  let gap = floating ? 0 : collapsedGap(cursor.prev, block);

  if (!floating && !fits(measure.height, cursor.y + gap, region) && !regionIsEmpty(ctx, cursor)) {
    cursor = overflow(ctx, cursor);
    region = currentRegion(ctx, cursor);
    gap = 0;
  }

  const y = cursor.y + gap;

  ctx.pages[cursor.pageIndex].fragments.push({
    kind: 'textBox',
    blockId: block.id,
    x: region.left,
    y,
    width: measure.width,
    height: measure.height,
    columnIndex: cursor.columnIndex,
    ...(floating ? { isFloating: true, zIndex: textBoxZIndex(block) } : {}),
    ...(block.docFrom !== undefined ? { docFrom: block.docFrom } : {}),
    ...(block.docTo !== undefined ? { docTo: block.docTo } : {}),
  });

  // A floating box is placed by its own anchor (the painter resolves that) and
  // never advances the body pen — that is what makes text flow past it.
  return floating ? { ...cursor, prev: block } : { ...cursor, y: y + measure.height, prev: block };
}

/**
 * Stacking order for an anchored text box.
 *
 * `wp:wrapNone` splits into two: `behind` paints *under* the text (a watermark,
 * a letterhead panel) and `inFront` paints over it. Everything else sits just
 * above the body — high enough that the box isn't buried by the text it displaces,
 * low enough to stay under the editor's own overlays.
 */
function textBoxZIndex(block: TextBoxBlock): number {
  if (block.wrapType === 'behind') return -1;
  if (block.wrapType === 'inFront') return 2;
  return 1;
}

function fits(height: number, top: number, region: ColumnRegion): boolean {
  return top + height <= region.bottom + FIT_TOLERANCE_PX;
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

function finish(ctx: FlowContext, options: LayoutOptions): Layout {
  const pageGap = options.pageGap ?? DEFAULT_PAGE_GAP_PX;

  const pages: Page[] = ctx.pages.map((draft) => ({
    number: draft.number,
    size: draft.size,
    margins: draft.margins,
    fragments: draft.fragments,
    ...(draft.columns ? { columns: draft.columns } : {}),
    ...(draft.footnoteReservedHeight
      ? { footnoteReservedHeight: draft.footnoteReservedHeight }
      : {}),
  }));

  const totalHeight =
    pages.reduce((h, page) => h + page.size.h, 0) + Math.max(0, pages.length - 1) * pageGap;

  return {
    pages,
    pageSize: options.pageSize,
    pageGap,
    totalHeight,
  };
}

export type { ColumnRegion };
