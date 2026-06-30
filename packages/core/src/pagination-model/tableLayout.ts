/**
 * Flowing a table onto pages.
 *
 * Split out of the page composer because a table is the one block whose
 * pagination is a problem in its own right. A paragraph breaks between lines and
 * that is the end of it. A table breaks between *rows* — except when a row is
 * taller than a page, when it breaks inside one; except when the row says
 * `w:cantSplit`, when it does not break at all; and on every page after the
 * first it has to redraw its header rows, which costs height that the fitting
 * arithmetic has to know about before it can decide what fits.
 *
 * The composer calls {@link layoutTable} and gets a cursor back. Everything above
 * is in here.
 *
 * @packageDocumentation
 */

import type { TableBlock, TableMeasure } from './types';
import { buildTableRowBreakInfo, snapRowBreak, type TableRowBreakInfo } from './tableRowBreak';
import { collapsedGap } from './blockSpacingRules';
import type { LayoutCursor, FlowContext, ColumnRegion } from './layoutCursor';
import {
  FIT_TOLERANCE_PX,
  applyKeepNext,
  overflow,
  currentRegion,
  regionIsEmpty,
} from './layoutCursor';

export function layoutTable(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  block: TableBlock,
  measure: TableMeasure,
  index: number
): LayoutCursor {
  // A positioned table hangs off its own anchor and does not advance the body
  // pen — the text flows past it, which the measure pass has already accounted
  // for by narrowing the lines beside it.
  if (block.floating) {
    return placeFloatingTable(ctx, cursorIn, block, measure);
  }

  let cursor = applyKeepNext(ctx, cursorIn, index);

  const rowCount = measure.rows.length;
  if (rowCount === 0) return { ...cursor, prev: block };

  const info = buildTableRowBreakInfo(block, measure);
  const headerRows = countRepeatingHeaderRows(block, measure);
  const headerHeight = sliceRowHeight(measure, 0, headerRows);

  let row = 0;
  /** Px of `row` already painted on a previous page (a mid-row break). */
  let rowOffset = 0;

  while (row < rowCount) {
    const region = currentRegion(ctx, cursor);
    // "Has any of this table been painted yet" — NOT "is this the first time
    // round the loop". A table bumped to the next page before placing anything
    // is still on its first fragment, and marking it `continuesFromPrev` would
    // make the painter draw it as a continuation slice: no top border, a cut
    // rule above it, and nothing above for it to continue from.
    const isFirstFragment = row === 0 && rowOffset === 0;
    const gap = isFirstFragment ? collapsedGap(cursor.prev, block) : 0;
    const top = cursor.y + gap;

    // A continuation re-shows the header rows, which costs height before any
    // body row can go on. The first fragment does not: its header rows ARE its
    // first rows.
    const repeatsHeader = !isFirstFragment && headerRows > 0 && row >= headerRows;
    const headerOverhead = repeatsHeader ? headerHeight : 0;
    const available = region.bottom - top - headerOverhead;

    const slice = fitRows(block, measure, info, row, rowOffset, available);

    if (slice.consumed <= 0) {
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
      // A single row taller than an empty page and unsplittable. Overflow it
      // rather than spin.
      slice.consumed = measure.rows[row].height - rowOffset;
      slice.nextRow = row + 1;
      slice.nextOffset = 0;
      slice.toRow = row + 1;
    }

    const done = slice.nextRow >= rowCount;

    ctx.pages[cursor.pageIndex].fragments.push({
      kind: 'table',
      blockId: block.id,
      x: region.left + tableOffsetX(block, measure, region),
      y: top,
      width: measure.totalWidth,
      height: slice.consumed + headerOverhead,
      fromRow: row,
      toRow: slice.toRow,
      columnIndex: cursor.columnIndex,
      ...(repeatsHeader ? { headerRowCount: headerRows } : {}),
      ...(rowOffset > 0 ? { topClip: rowOffset } : {}),
      ...(slice.bottomClip > 0 ? { bottomClip: slice.bottomClip } : {}),
      ...(isFirstFragment ? {} : { continuesFromPrev: true }),
      ...(done ? {} : { continuesOnNext: true }),
      ...(block.docFrom !== undefined ? { docFrom: block.docFrom } : {}),
      ...(block.docTo !== undefined ? { docTo: block.docTo } : {}),
    });

    cursor = { ...cursor, y: top + slice.consumed + headerOverhead, prev: block };
    row = slice.nextRow;
    rowOffset = slice.nextOffset;

    if (row < rowCount) {
      cursor = overflow(ctx, cursor);
    }
  }

  return cursor;
}

interface RowSlice {
  /** Px of table body placed. */
  consumed: number;
  /** Exclusive row bound of this fragment. */
  toRow: number;
  /** Where the next fragment resumes. */
  nextRow: number;
  nextOffset: number;
  /** Px cut off the bottom of the last row in this fragment. */
  bottomClip: number;
}

/**
 * How much of the table, starting at `(row, rowOffset)`, fits in `available`.
 *
 * Rows go whole where they can. A row that doesn't fit either moves entire
 * (`w:cantSplit`, §17.4.6) or breaks mid-content — and a mid-content break is
 * snapped to a whole text line, never through a glyph, which is what
 * `snapRowBreak` is for.
 */
function fitRows(
  block: TableBlock,
  measure: TableMeasure,
  info: TableRowBreakInfo,
  row: number,
  rowOffset: number,
  available: number
): RowSlice {
  const rowCount = measure.rows.length;
  let consumed = 0;
  let r = row;
  let offset = rowOffset;

  while (r < rowCount) {
    const rowHeight = measure.rows[r].height;
    const rest = rowHeight - offset;

    if (consumed + rest <= available + FIT_TOLERANCE_PX) {
      consumed += rest;
      r++;
      offset = 0;
      continue;
    }

    // This row doesn't fit in what's left.
    const room = available - consumed;
    const splittable = !block.rows[r]?.cantSplit;

    if (splittable) {
      const slice = snapRowBreak(info, r, offset, room);
      if (slice > 0) {
        consumed += slice;
        const nextOffset = offset + slice;
        const finished = nextOffset >= rowHeight - FIT_TOLERANCE_PX;
        return {
          consumed,
          toRow: r + 1,
          nextRow: finished ? r + 1 : r,
          nextOffset: finished ? 0 : nextOffset,
          bottomClip: finished ? 0 : rowHeight - nextOffset,
        };
      }
    }

    // Nothing more fits: the fragment ends before this row.
    return { consumed, toRow: r, nextRow: r, nextOffset: offset, bottomClip: 0 };
  }

  return { consumed, toRow: r, nextRow: r, nextOffset: 0, bottomClip: 0 };
}

/**
 * Leading rows marked `w:tblHeader` (§17.4.49). Only a *leading* run counts:
 * the flag on a row in the middle of a table isn't a header, and Word ignores it.
 */
function countRepeatingHeaderRows(block: TableBlock, measure: TableMeasure): number {
  let n = 0;
  while (n < measure.rows.length && block.rows[n]?.isHeader) n++;
  // A table that is *entirely* header rows has nothing to repeat them above.
  return n < measure.rows.length ? n : 0;
}

function sliceRowHeight(measure: TableMeasure, from: number, to: number): number {
  let h = 0;
  for (let i = from; i < to; i++) h += measure.rows[i]?.height ?? 0;
  return h;
}

/** `w:jc` on a table centres or right-aligns it in the column (§17.4.29). */
function tableOffsetX(block: TableBlock, measure: TableMeasure, region: ColumnRegion): number {
  const slack = region.width - measure.totalWidth;
  if (block.indent) return block.indent;
  if (slack <= 0) return 0;
  if (block.justification === 'center') return slack / 2;
  if (block.justification === 'right') return slack;
  return 0;
}

/**
 * A `w:tblpPr` table: positioned against the margin, out of the body flow.
 */
function placeFloatingTable(
  ctx: FlowContext,
  cursor: LayoutCursor,
  block: TableBlock,
  measure: TableMeasure
): LayoutCursor {
  const region = currentRegion(ctx, cursor);
  const anchor = block.floating!;

  const x = region.left + (anchor.tblpX ?? tableOffsetX(block, measure, region));
  const y = anchor.tblpY != null ? region.top + anchor.tblpY : cursor.y;

  ctx.pages[cursor.pageIndex].fragments.push({
    kind: 'table',
    blockId: block.id,
    x,
    y,
    width: measure.totalWidth,
    height: measure.totalHeight,
    fromRow: 0,
    toRow: measure.rows.length,
    columnIndex: cursor.columnIndex,
    ...(block.docFrom !== undefined ? { docFrom: block.docFrom } : {}),
    ...(block.docTo !== undefined ? { docTo: block.docTo } : {}),
  });

  // The pen does not advance: body text wraps beside the table, and the measure
  // pass has already narrowed those lines.
  return { ...cursor, prev: block };
}
