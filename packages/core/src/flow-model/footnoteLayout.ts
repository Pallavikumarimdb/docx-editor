/**
 * Footnote PageLayout Utilities
 *
 * Shared OOXML footnote conversion, reference-to-page mapping, reservation,
 * continuation pagination, and render-item construction. Adapters supply only
 * their platform-specific block measurement function.
 */

import type {
  NodeId,
  ContentNode,
  ParagraphBlock,
  LayoutMetrics,
  Page,
  PageLayout,
  FootnoteContent,
  FootnoteFragment,
  TextRun,
} from '../pagination-model/types';
import { layOutPages, type LayoutConfig } from '../pagination-model';
import type { Document, Footnote, StyleDefinitions, Theme } from '../types/document';
import type { FootnoteRenderItem } from '../painter-model';
import { footnoteToProseDoc } from '../prosemirror/conversion/toProseDoc';
import { buildBoxTree } from './buildBoxTree';
import { getFootnoteText } from '../docx/footnoteParser';
import { takeFootnoteSlice, type FootnoteSliceCursor } from './footnoteSlices';
import type { FootnoteRefLocation } from './footnoteReferenceLayout';
import {
  addDeferredStartReservationFloors,
  footnotePlansEqual,
  footnoteReservedHeightsCover,
  footnoteReservedHeightsEqual,
  mergeFootnoteReservedHeights,
  type FootnotePaginationPlan,
} from './footnotePlan';

export { collectFootnoteRefs, type FootnoteRefLocation } from './footnoteReferenceLayout';
export { footnoteReservedHeightsEqual };

/** Separator line height + vertical padding in pixels. */
export const FOOTNOTE_SEPARATOR_HEIGHT = 12;

/**
 * Gutter between footnote columns when `w15:footnoteColumns` > 1, in pixels
 * (≈ 0.25in). Shared by the reserved-height/measurement path (core) and the
 * footnote painter so a footnote measured at column width paints into a column
 * of exactly that width. Single-column footnotes never consult it.
 */
export const FOOTNOTE_COLUMN_GAP_PX = 24;

/**
 * Hard cap on the multi-pass footnote layout loop. Reserving footnote
 * space can move a reference to another page, so adapters keep remapping
 * until the page→height contract is stable. Dense layouts converge in
 * 2–3 passes in practice; 6 is a safe ceiling.
 */
export const FOOTNOTE_REFLOW_LIMIT = 6;

/**
 * Default footnote font size in points. Word's built-in "Footnote Text"
 * style sets 8pt; we apply this only when the footnote's runs don't
 * already specify a fontSize (avoids overriding authored sizes).
 *
 * TODO once the style cascade for paragraph styles is fully wired through
 * the bridge, footnotes should pick this up from the resolved
 * "FootnoteText" / "footnote text" style instead of hardcoding the value.
 */
const FOOTNOTE_FONT_SIZE_PT = 8;

// ============================================================================
// 2. Map footnote references to pages
// ============================================================================

interface FootnotePageIndex {
  ranges: Array<{ from: number; to: number; pageNumber: number }>;
  tableRows: Map<
    string,
    Map<number, Array<{ topClip: number; bottomClip: number; pageNumber: number }>>
  >;
}

/**
 * Build the immutable lookup used for all references in one layout pass.
 *
 * Body ranges are disjoint and sorted by PM position; table row slices are
 * indexed per table. Lookup is therefore O(log fragments) instead of scanning
 * every page and every fragment for every reference on every stabilization pass.
 */
function buildFootnotePageIndex(
  pages: Page[],
  footnoteRefs: FootnoteRefLocation[]
): FootnotePageIndex {
  const ranges: FootnotePageIndex['ranges'] = [];
  const tableRows: FootnotePageIndex['tableRows'] = new Map();
  const referencedRows = new Map<string, number[]>();

  for (const ref of footnoteRefs) {
    if (ref.tableBlockId == null || ref.rowIndex == null) continue;
    const key = String(ref.tableBlockId);
    const rows = referencedRows.get(key) ?? [];
    rows.push(ref.rowIndex);
    referencedRows.set(key, rows);
  }
  for (const [key, rows] of referencedRows) {
    referencedRows.set(
      key,
      Array.from(new Set(rows)).sort((a, b) => a - b)
    );
  }

  for (const page of pages) {
    for (const fragment of page.fragments) {
      if (fragment.kind === 'table') {
        const key = String(fragment.blockId);
        const rows = referencedRows.get(key);
        if (!rows) continue;
        let low = 0;
        let high = rows.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (rows[mid] < fragment.fromRow) low = mid + 1;
          else high = mid;
        }
        let rowCursor = low;
        while (rowCursor < rows.length && rows[rowCursor] < fragment.toRow) {
          const rowIndex = rows[rowCursor++];
          const slicesByRow = tableRows.get(key) ?? new Map();
          const slices = slicesByRow.get(rowIndex) ?? [];
          slices.push({
            topClip: rowIndex === fragment.fromRow ? (fragment.topClip ?? 0) : 0,
            bottomClip: rowIndex === fragment.toRow - 1 ? (fragment.bottomClip ?? 0) : 0,
            pageNumber: page.number,
          });
          slicesByRow.set(rowIndex, slices);
          tableRows.set(key, slicesByRow);
        }
        continue;
      }

      if (fragment.docFrom == null || fragment.docTo == null) continue;
      ranges.push({
        from: fragment.docFrom,
        to: fragment.docTo,
        pageNumber: page.number,
      });
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const slicesByRow of tableRows.values()) {
    for (const slices of slicesByRow.values()) {
      slices.sort((a, b) => a.topClip - b.topClip || a.pageNumber - b.pageNumber);
    }
  }
  return { ranges, tableRows };
}

function pageForPmPos(index: FootnotePageIndex, pmPos: number): number | undefined {
  let low = 0;
  let high = index.ranges.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (index.ranges[mid].from <= pmPos) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate < 0) return undefined;
  const range = index.ranges[candidate];
  return pmPos < range.to ? range.pageNumber : undefined;
}

function pageForTableRow(
  index: FootnotePageIndex,
  tableBlockId: BlockId,
  rowIndex: number,
  rowOffset?: number,
  rowHeight?: number
): number | undefined {
  const slices = index.tableRows.get(String(tableBlockId))?.get(rowIndex);
  if (!slices?.length) return undefined;
  if (rowOffset == null || rowHeight == null) return slices[0].pageNumber;

  let low = 0;
  let high = slices.length - 1;
  let candidate = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (slices[mid].topClip <= rowOffset) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const slice = slices[candidate];
  return rowOffset < rowHeight - slice.bottomClip ? slice.pageNumber : undefined;
}

/**
 * After layout, determine which footnotes appear on which pages.
 *
 * Returns Map<pageNumber, footnoteId[]> in document order.
 */
export function mapFootnotesToPages(
  pages: Page[],
  footnoteRefs: FootnoteRefLocation[]
): Map<number, number[]> {
  const pageFootnotes = new Map<number, number[]>();

  if (footnoteRefs.length === 0) return pageFootnotes;
  const index = buildFootnotePageIndex(pages, footnoteRefs);

  const assign = (pageNumber: number, footnoteId: number): void => {
    const existing = pageFootnotes.get(pageNumber) ?? [];
    // Avoid duplicates (same footnote shouldn't appear twice on same page)
    if (!existing.includes(footnoteId)) existing.push(footnoteId);
    pageFootnotes.set(pageNumber, existing);
  };

  for (const ref of footnoteRefs) {
    const pageNumber =
      ref.tableBlockId != null && ref.rowIndex != null
        ? pageForTableRow(index, ref.tableBlockId, ref.rowIndex, ref.rowOffset, ref.rowHeight)
        : pageForPmPos(index, ref.pmPos);
    if (pageNumber != null) assign(pageNumber, ref.footnoteId);
  }

  return pageFootnotes;
}

// ============================================================================
// 3. Convert a footnote to renderable FlowBlocks (body-pipeline)
// ============================================================================

/**
 * Footnote-specific block normalization. Mirrors the spirit of
 * `normalizeHeaderFooterMeasureBlocks`: post-process the body-pipeline
 * output for a single footnote so it carries the correct visual prefix
 * (its display number, rendered as a superscript) and a default 8pt font
 * for any run that didn't specify a size.
 *
 * The displayNumber is prepended onto the FIRST paragraph as a fresh
 * superscript text run — visually matches Word's footnote numbering
 * without disturbing the authored runs.
 *
 * Exported for callers that want to compose their own conversion
 * pipeline; `convertFootnoteToContent` calls it as part of its flow.
 */
export function applyFootnotePresentation(
  nodes: ContentNode[],
  displayNumber: number
): ContentNode[] {
  if (nodes.length === 0) {
    return [
      {
        kind: 'paragraph',
        id: `fn-empty-${displayNumber}`,
        runs: [
          {
            kind: 'text',
            text: `${displayNumber}  `,
            fontSize: FOOTNOTE_FONT_SIZE_PT,
            superscript: true,
          },
        ],
      } as ParagraphBlock,
    ];
  }

  // Apply default 8pt to every run that didn't specify a fontSize. Mutating
  // a copy keeps the input nodes pure for caching upstream.
  const out = nodes.map((b) => {
    if (b.kind !== 'paragraph') return b;
    const para = b as ParagraphBlock;
    return {
      ...para,
      runs: para.runs.map((r) => {
        if (r.kind === 'text' || r.kind === 'tab') {
          if (r.fontSize == null) {
            return { ...r, fontSize: FOOTNOTE_FONT_SIZE_PT };
          }
        }
        return r;
      }),
    } as ParagraphBlock;
  });

  // Prepend display number on the first paragraph.
  const first = out[0];
  if (first.kind === 'paragraph') {
    const firstPara = first as ParagraphBlock;
    // Match the marker's font to the note text it precedes. Word renders the
    // footnote number in the FootnoteText paragraph font; the FootnoteReference
    // char style only adds superscript, not a face. Without this the synthetic
    // run carries no fontFamily and the painter falls back to the inherited
    // container default, so the number renders in a different font than the
    // note text. When the note text itself has no explicit font we leave the
    // marker unset too (both then inherit the same container font and match).
    const firstTextRun = firstPara.runs.find((r) => r.kind === 'text') as TextRun | undefined;
    const numberRun: TextRun = {
      kind: 'text',
      text: `${displayNumber}  `,
      fontSize: FOOTNOTE_FONT_SIZE_PT,
      superscript: true,
      ...(firstTextRun?.fontFamily ? { fontFamily: firstTextRun.fontFamily } : {}),
    };
    out[0] = {
      ...firstPara,
      runs: [numberRun, ...firstPara.runs],
    } as ParagraphBlock;
  }

  return out;
}

/**
 * Adapter-supplied block measurement function. The caller (React /
 * Vue / etc.) supplies its platform's measure routine — at minimum
 * paragraph + table + image + textBox — so this core helper stays
 * Canvas-free.
 */
export type MeasureBlocksFn = (nodes: ContentNode[], contentWidth: number) => LayoutMetrics[];

/**
 * Options for {@link convertFootnoteToContent}.
 */
export type ConvertFootnoteOptions = {
  /** The document's parsed style definitions, threaded into the body pipeline. */
  styles?: StyleDefinitions | null;
  /** Theme for resolving themed fills / fonts inside the footnote. */
  theme?: Theme | null;
  /** LayoutMetrics callback supplied by the rendering adapter. */
  measureBlocks: MeasureBlocksFn;
  /**
   * Doc-level `w:defaultTabMark` (twips) from the body so list markers
   * inside footnotes honor the same tab grid.
   */
  defaultTabMarkTwips?: number | null;
};

/**
 * Convert a Footnote to renderable FootnoteContent via the body pipeline:
 * `footnoteToProseDoc → buildBoxTree → applyFootnotePresentation →
 * measureBlocks`. Pre-PR (#378) this lived in a hand-rolled shadow stack
 * that silently dropped non-paragraph content; routing through the body
 * pipeline gives footnotes full block-kind support — paragraph + table
 * + image + textBox + fields.
 */
export function convertFootnoteToContent(
  footnote: Footnote,
  displayNumber: number,
  contentWidth: number,
  config: ConvertFootnoteOptions
): FootnoteContent {
  const pmDoc = footnoteToProseDoc(footnote.content, {
    styles: config.styles ?? undefined,
    theme: config.theme ?? null,
    defaultTabMarkTwips: config.defaultTabMarkTwips ?? null,
  });
  const rawNodes = buildBoxTree(pmDoc, { theme: config.theme ?? undefined });
  const nodes = applyFootnotePresentation(rawNodes, displayNumber);

  const metrics = config.measureBlocks(nodes, contentWidth);

  const totalHeight = metrics.reduce((h, m) => {
    if (m.kind === 'paragraph') return h + m.totalHeight;
    if (m.kind === 'table') return h + m.totalHeight;
    if (m.kind === 'image') return h + m.height;
    if (m.kind === 'textBox') return h + m.height;
    return h;
  }, 0);

  return {
    id: footnote.id,
    displayNumber,
    nodes,
    metrics,
    height: totalHeight,
  };
}

/**
 * Build footnote content for all footnotes referenced in the document.
 * Display numbers are assigned by first-appearance order (the same way
 * Word renders them).
 */
export function buildFootnoteContentMap(
  footnotes: Footnote[],
  footnoteRefs: Array<{ footnoteId: number }>,
  contentWidth: number | ((footnoteId: number) => number),
  options: ConvertFootnoteOptions
): Map<number, FootnoteContent> {
  const contentMap = new Map<number, FootnoteContent>();
  const footnoteById = new Map<number, Footnote>();

  for (const fn of footnotes) {
    if (fn.noteType === 'normal' || fn.noteType == null) {
      footnoteById.set(fn.id, fn);
    }
  }

  let displayNumber = 1;
  const seen = new Set<number>();

  for (const ref of footnoteRefs) {
    if (seen.has(ref.footnoteId)) continue;
    seen.add(ref.footnoteId);

    const footnote = footnoteById.get(ref.footnoteId);
    if (!footnote) continue;

    contentMap.set(
      ref.footnoteId,
      convertFootnoteToContent(
        footnote,
        displayNumber,
        typeof contentWidth === 'function' ? contentWidth(ref.footnoteId) : contentWidth,
        options
      )
    );
    displayNumber++;
  }

  return contentMap;
}

// ============================================================================
// 4. Per-page footnote area height reservation
// ============================================================================

/**
 * Distribute footnote items across `columns` balanced columns, preserving
 * document order (footnotes must still read in numeric sequence). Items fill
 * the first column until it reaches the balanced target height (≈ total / N),
 * then spill into the next column — the same order-preserving balance Word
 * applies to its footnote columns, not a greedy shortest-column packing
 * (which would scramble the reading order).
 *
 * `columns <= 1` (the default for ordinary single-column footnotes) returns a
 * single column unchanged, so callers that never opt into multi-column
 * footnotes are byte-for-byte unaffected.
 *
 * Pure and shared by the reserved-height calculation (core) and the footnote
 * painter (painter) so the reserved area and the rendered columns are
 * computed from the same partition.
 */
export function distributeFootnotesIntoColumns<T extends { height: number }>(
  items: T[],
  columns: number
): T[][] {
  const n = Math.max(1, Math.floor(columns));
  if (n <= 1 || items.length <= 1) return [items];

  const total = items.reduce((sum, item) => sum + item.height, 0);
  const target = total / n;

  const result: T[][] = [[]];
  let columnHeight = 0;
  for (const item of items) {
    // Move to the next column once the current one has passed the balanced
    // target (measured at the item's midpoint to avoid lopsided splits) and
    // columns remain. Never leave a column empty.
    if (result.length < n && columnHeight > 0 && columnHeight + item.height / 2 > target) {
      result.push([]);
      columnHeight = 0;
    }
    result[result.length - 1].push(item);
    columnHeight += item.height;
  }

  return result;
}

/**
 * Calculate per-page footnote reserved heights.
 * Returns Map<pageNumber, reservedHeight>.
 *
 * With `columns > 1` the footnotes are balanced across that many columns and
 * the reserved height is the tallest column (plus the separator), since the
 * columns sit side by side — not the sum of every footnote height.
 */
export function calculateFootnoteReservedHeights(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, { height: number }>,
  columns: number = 1
): Map<number, number> {
  const reserved = new Map<number, number>();

  for (const [pageNumber, footnoteIds] of pageFootnoteMap) {
    const heights = footnoteIds
      .map((fnId) => footnoteContentMap.get(fnId)?.height ?? 0)
      .filter((h) => h > 0)
      .map((height) => ({ height }));

    if (heights.length === 0) continue;

    const cols = distributeFootnotesIntoColumns(heights, columns);
    const tallestColumn = cols.reduce(
      (max, col) =>
        Math.max(
          max,
          col.reduce((sum, item) => sum + item.height, 0)
        ),
      0
    );

    if (tallestColumn > 0) {
      // Add separator height
      reserved.set(pageNumber, tallestColumn + FOOTNOTE_SEPARATOR_HEIGHT);
    }
  }

  return reserved;
}

/** Keep enough body room for at least one ordinary footnote-reference line. */
const MIN_BODY_FLOW_HEIGHT_PX = 12;

interface PendingFootnote {
  content: FootnoteContent;
  cursor: FootnoteSliceCursor;
  /** Whether at least one slice has already appeared on an earlier page. */
  started: boolean;
}

function firstSliceHeight(content: FootnoteContent): number {
  return (
    takeFootnoteSlice(content, { blockIndex: 0, unitIndex: 0 }, 0, 0, true).fragment?.height ?? 0
  );
}

function pageContentHeight(pages: Page[], pageNumber: number): number {
  const page = pages[pageNumber - 1] ?? pages[pages.length - 1];
  if (!page) return 0;
  return Math.max(0, page.size.h - page.margins.top - page.margins.bottom);
}

/**
 * Slice referenced footnotes into page-local fragments. Every page keeps one
 * body-line slot, continuation content is ordered before newly referenced
 * notes, and each new note is guaranteed a first slice on its reference page.
 */
function paginateFootnoteFragments(
  pages: Page[],
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, FootnoteContent>,
  columns: number | ((pageNumber: number) => number)
): FootnotePaginationPlan {
  const startsByPage = new Map<number, FootnoteContent[]>();
  const globallyStarted = new Set<number>();
  let lastStartPage = 0;
  for (const [pageNumber, ids] of pageFootnoteMap) {
    const starts: FootnoteContent[] = [];
    for (const id of ids) {
      if (globallyStarted.has(id)) continue;
      const content = footnoteContentMap.get(id);
      if (!content) continue;
      globallyStarted.add(id);
      starts.push(content);
    }
    if (starts.length > 0) {
      startsByPage.set(pageNumber, starts);
      lastStartPage = Math.max(lastStartPage, pageNumber);
    }
  }

  const reservedHeights = new Map<number, number>();
  const fragmentsByPage = new Map<number, FootnoteFragment[]>();
  const footnoteIdsByPage = new Map<number, number[]>();
  const deferredStartIdsByPage = new Map<number, number[]>();
  let pending: PendingFootnote[] = [];
  let pageNumber = 1;

  while (pageNumber <= lastStartPage || pending.length > 0) {
    const columnCount = Math.max(
      1,
      Math.floor(typeof columns === 'function' ? columns(pageNumber) : columns)
    );
    const carriedFootnoteIds = new Set(
      pending.filter((state) => state.started).map((state) => state.content.id)
    );
    const starts = startsByPage.get(pageNumber) ?? [];
    const contentHeight = pageContentHeight(pages, pageNumber);
    const columnCapacity = Math.max(
      1,
      contentHeight - MIN_BODY_FLOW_HEIGHT_PX - FOOTNOTE_SEPARATOR_HEIGHT
    );
    const pageFragments: FootnoteFragment[] = [];
    const columnUsed = Array.from({ length: columnCount }, () => 0);

    // Preserve the existing balanced-column behavior when every note is whole
    // and no continuation is entering this page.
    const canUseBalancedColumns =
      columnCount > 1 &&
      pending.length === 0 &&
      starts.every((content) => content.height <= columnCapacity) &&
      starts.reduce((sum, content) => sum + content.height, 0) <= columnCapacity * columnCount;

    if (canUseBalancedColumns) {
      const partitions = distributeFootnotesIntoColumns(starts, columnCount);
      partitions.forEach((partition, columnIndex) => {
        for (const content of partition) {
          const taken = takeFootnoteSlice(
            content,
            { blockIndex: 0, unitIndex: 0 },
            Number.POSITIVE_INFINITY,
            columnIndex,
            true
          );
          if (taken.fragment) {
            pageFragments.push(taken.fragment);
            columnUsed[columnIndex] += taken.fragment.height;
          }
        }
      });
      pending = [];
    } else {
      let columnIndex = 0;
      const advanceColumn = (): boolean => {
        while (columnIndex < columnCount && columnUsed[columnIndex] >= columnCapacity - 0.5) {
          columnIndex++;
        }
        return columnIndex < columnCount;
      };

      const consume = (
        state: PendingFootnote,
        budget: { remaining: number }
      ): PendingFootnote | undefined => {
        let current = state;
        while (budget.remaining > 0 && advanceColumn()) {
          const available = Math.min(budget.remaining, columnCapacity - columnUsed[columnIndex]);
          const taken = takeFootnoteSlice(
            current.content,
            current.cursor,
            available,
            columnIndex,
            columnUsed[columnIndex] === 0
          );
          if (!taken.fragment) {
            columnIndex++;
            continue;
          }
          pageFragments.push(taken.fragment);
          columnUsed[columnIndex] += taken.fragment.height;
          budget.remaining -= taken.fragment.height;
          current = { content: current.content, cursor: taken.cursor, started: true };
          if (taken.done) return undefined;
          if (columnUsed[columnIndex] >= columnCapacity - 0.5) columnIndex++;
        }
        return current;
      };

      const totalCapacity = columnCapacity * columnCount;
      const starterReserve = starts.reduce((sum, content) => sum + firstSliceHeight(content), 0);
      const carryBudget = { remaining: Math.max(0, totalCapacity - starterReserve) };
      const nextPending: PendingFootnote[] = [];
      for (const state of pending) {
        const remainder = consume(state, carryBudget);
        if (remainder) nextPending.push(remainder);
      }

      const starterBudget = {
        remaining: Math.max(0, totalCapacity - columnUsed.reduce((sum, h) => sum + h, 0)),
      };
      for (const content of starts) {
        const fragmentCountBefore = pageFragments.length;
        const remainder = consume(
          { content, cursor: { blockIndex: 0, unitIndex: 0 }, started: false },
          starterBudget
        );
        if (remainder) nextPending.push(remainder);
        if (pageFragments.length === fragmentCountBefore) {
          const deferred = deferredStartIdsByPage.get(pageNumber) ?? [];
          deferred.push(content.id);
          deferredStartIdsByPage.set(pageNumber, deferred);
        }
      }
      pending = nextPending;
    }

    const continuingFootnoteIds = new Set(
      pending.filter((state) => state.started).map((state) => state.content.id)
    );
    for (const fragment of pageFragments) {
      if (carriedFootnoteIds.has(fragment.footnoteId)) fragment.continuesFromPrev = true;
      if (continuingFootnoteIds.has(fragment.footnoteId)) fragment.continuesOnNext = true;
    }

    if (pageFragments.length > 0) {
      const maxColumnHeight = Math.max(...columnUsed);
      reservedHeights.set(
        pageNumber,
        Math.min(contentHeight, FOOTNOTE_SEPARATOR_HEIGHT + maxColumnHeight)
      );
      fragmentsByPage.set(pageNumber, pageFragments);
      footnoteIdsByPage.set(
        pageNumber,
        Array.from(new Set(pageFragments.map((fragment) => fragment.footnoteId)))
      );
    } else if (pending.length > 0) {
      // Defensive escape for malformed zero-height page geometries.
      console.warn('[docx-editor] unable to make progress while slicing a footnote continuation');
      break;
    }
    pageNumber++;
  }

  return {
    reservedHeights,
    areaHeights: new Map(reservedHeights),
    fragmentsByPage,
    footnoteIdsByPage,
    deferredStartIdsByPage,
    minimumPageCount: Math.max(pages.length, pageNumber - 1),
  };
}

// ============================================================================
// 4b. Multi-pass footnote layout convergence
// ============================================================================

export interface StabilizeFootnoteLayoutArgs {
  nodes: ContentNode[];
  metrics: LayoutMetrics[];
  layoutConfig: LayoutConfig;
  footnoteRefs: FootnoteRefLocation[];
  footnoteContentMap: Map<number, FootnoteContent>;
  /** First-pass layout already computed by the caller without reserved heights. */
  initialLayout: PageLayout;
  /**
   * Number of columns the footnote area is laid out in (`w15:footnoteColumns`).
   * Defaults to 1. When > 1, reserved heights are balanced across the columns
   * (tallest column wins) instead of summing every footnote, and the value is
   * written onto each footnote-bearing page as `page.footnoteColumns`.
   */
  footnoteColumns?: number;
  /** Resolve `w15:footnoteColumns` for each physical page's owning section. */
  resolveFootnoteColumns?: (pageNumber: number) => number;
}

export interface StabilizeFootnoteLayoutResult {
  layout: PageLayout;
  pageFootnoteMap: Map<number, number[]>;
  /** True if the loop converged before hitting FOOTNOTE_REFLOW_LIMIT. */
  converged: boolean;
}

/**
 * Run the multi-pass footnote layout loop. Reserving footnote space on a
 * page can move a reference to another page, which changes the reservation,
 * which can move references again. Iterate until the page→height contract
 * is the same one used by the latest layout, or `FOOTNOTE_REFLOW_LIMIT`
 * passes have run.
 *
 * Lives in core so the React + Vue adapters call the same loop and stay in
 * lockstep on convergence behaviour. Writes `page.footnoteIds` onto each
 * page in the returned layout so renderers can paint footnote areas.
 */
export function stabilizeFootnoteLayout(
  args: StabilizeFootnoteLayoutArgs
): StabilizeFootnoteLayoutResult {
  const { blocks, measures, layoutOpts, footnoteRefs, footnoteContentMap, initialLayout } = args;
  const footnoteColumns =
    args.resolveFootnoteColumns ?? Math.max(1, Math.floor(args.footnoteColumns ?? 1));
  const reservationFloors = new Map<number, number>();

  let referenceMap = mapFootnotesToPages(initialLayout.pages, footnoteRefs);
  let plan = addDeferredStartReservationFloors(
    paginateFootnoteFragments(
      initialLayout.pages,
      referenceMap,
      footnoteContentMap,
      footnoteColumns
    ),
    initialLayout.pages,
    footnoteRefs,
    reservationFloors
  );

  if (plan.reservedHeights.size === 0) {
    return { layout: initialLayout, pageFootnoteMap: referenceMap, converged: true };
  }

  let newLayout = initialLayout;
  let converged = false;
  for (let pass = 0; pass < FOOTNOTE_REFLOW_LIMIT; pass++) {
    newLayout = layOutPages(blocks, measures, {
      ...layoutOpts,
      footnoteReservedHeights: plan.reservedHeights,
      minimumPageCount: plan.minimumPageCount,
    });

    const nextReferenceMap = mapFootnotesToPages(newLayout.pages, footnoteRefs);
    const nextPlan = addDeferredStartReservationFloors(
      paginateFootnoteFragments(
        newLayout.pages,
        nextReferenceMap,
        footnoteContentMap,
        footnoteColumns
      ),
      newLayout.pages,
      footnoteRefs,
      reservationFloors
    );

    referenceMap = nextReferenceMap;
    if (nextPlan.deferredStartIdsByPage.size === 0 && footnotePlansEqual(plan, nextPlan)) {
      plan = nextPlan;
      converged = true;
      break;
    }
    plan = nextPlan;
  }

  if (!converged) {
    let fallbackReservedHeights = plan.reservedHeights;
    let fallbackMinimumPageCount = plan.minimumPageCount;
    let fallbackCovered = false;
    for (let pass = 0; pass < FOOTNOTE_REFLOW_LIMIT; pass++) {
      newLayout = layOutPages(nodes, metrics, {
        ...layoutConfig,
        footnoteReservedHeights: fallbackReservedHeights,
        minimumPageCount: fallbackMinimumPageCount,
      });
      referenceMap = mapFootnotesToPages(newLayout.pages, footnoteRefs);
      const requiredPlan = addDeferredStartReservationFloors(
        paginateFootnoteFragments(
          newLayout.pages,
          referenceMap,
          footnoteContentMap,
          footnoteColumns
        ),
        newLayout.pages,
        footnoteRefs,
        reservationFloors
      );
      plan = requiredPlan;
      if (
        footnoteReservedHeightsCover(fallbackReservedHeights, requiredPlan.reservedHeights) &&
        fallbackMinimumPageCount >= requiredPlan.minimumPageCount
      ) {
        fallbackCovered = true;
        break;
      }
      fallbackReservedHeights = mergeFootnoteReservedHeights(
        fallbackReservedHeights,
        requiredPlan.reservedHeights
      );
      fallbackMinimumPageCount = Math.max(fallbackMinimumPageCount, requiredPlan.minimumPageCount);
    }
    if (!fallbackCovered) {
      newLayout = layOutPages(nodes, metrics, {
        ...layoutConfig,
        footnoteReservedHeights: fallbackReservedHeights,
        minimumPageCount: fallbackMinimumPageCount,
      });
      referenceMap = mapFootnotesToPages(newLayout.pages, footnoteRefs);
      plan = addDeferredStartReservationFloors(
        paginateFootnoteFragments(
          newLayout.pages,
          referenceMap,
          footnoteContentMap,
          footnoteColumns
        ),
        newLayout.pages,
        footnoteRefs,
        reservationFloors
      );
    }
    console.warn(
      `[docx-editor] footnote layout did not stabilize within ${FOOTNOTE_REFLOW_LIMIT} passes; ` +
        'settling with conservative page reservations. If footnotes appear misplaced, please file a bug with the document.'
    );
  }

  for (const page of newLayout.pages) {
    const fragments = plan.fragmentsByPage.get(page.number);
    if (!fragments?.length) continue;
    const areaHeight = plan.areaHeights.get(page.number);
    if (areaHeight != null) page.footnoteReservedHeight = areaHeight;
    page.footnoteFragments = fragments;
    page.footnoteIds = plan.footnoteIdsByPage.get(page.number);
    const pageColumns =
      typeof footnoteColumns === 'function' ? footnoteColumns(page.number) : footnoteColumns;
    if (pageColumns > 1) page.footnoteColumns = pageColumns;
  }

  return { layout: newLayout, pageFootnoteMap: plan.footnoteIdsByPage, converged };
}

// ============================================================================
// 5. Build per-page render items
// ============================================================================

/**
 * Turn the page→footnote-id map into the per-page render payload that
 * `paintPages` consumes via `footnotesByPage`. Skips non-`normal` notes
 * (separators, continuation notices), reads the display number out of the
 * content map, and pulls plain text via `getFootnoteText`.
 *
 * Lives in core (not in either adapter) so React + Vue both call the
 * same helper — same rule as the rest of this module.
 */
export function buildFootnoteRenderItems(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, FootnoteContent>,
  doc: Document | null,
  pages?: Page[]
): Map<number, FootnoteRenderItem[]> {
  const result = new Map<number, FootnoteRenderItem[]>();
  if (!doc?.package?.footnotes) return result;

  const fnLookup = new Map<number, Footnote>();
  for (const fn of doc.package.footnotes) {
    if (fn.noteType && fn.noteType !== 'normal') continue;
    fnLookup.set(fn.id, fn);
  }

  const pageLookup = new Map(pages?.map((page) => [page.number, page]));
  for (const [pageNumber, footnoteIds] of pageFootnoteMap) {
    const items: FootnoteRenderItem[] = [];
    const fragments = pageLookup.get(pageNumber)?.footnoteFragments;
    if (fragments?.length) {
      for (const fragment of fragments) {
        const fn = fnLookup.get(fragment.footnoteId);
        const content = footnoteContentMap.get(fragment.footnoteId);
        if (!fn || !content) continue;
        items.push({
          displayNumber: String(fragment.displayNumber),
          text: getFootnoteText(fn),
          content,
          fragment,
        });
      }
      if (items.length > 0) result.set(pageNumber, items);
      continue;
    }

    for (const fnId of footnoteIds) {
      const fn = fnLookup.get(fnId);
      if (!fn) continue;
      const content = footnoteContentMap.get(fnId);
      const displayNum = content?.displayNumber ?? 0;
      items.push({
        displayNumber: String(displayNum),
        text: getFootnoteText(fn),
        content,
      });
    }
    if (items.length > 0) result.set(pageNumber, items);
  }

  return result;
}
