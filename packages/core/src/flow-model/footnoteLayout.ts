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
 * Compare two per-page footnote reservation maps. Used by the React +
 * Vue adapters to detect when the multi-pass loop has converged.
 */
export function footnoteReservedHeightsEqual(
  a: Map<number, number>,
  b: Map<number, number>
): boolean {
  if (a.size !== b.size) return false;
  for (const [pageNumber, height] of a) {
    if (b.get(pageNumber) !== height) return false;
  }
  return true;
}

function footnoteReservedHeightsCover(
  reserved: Map<number, number>,
  required: Map<number, number>
): boolean {
  for (const [pageNumber, height] of required) {
    if ((reserved.get(pageNumber) ?? 0) < height) return false;
  }
  return true;
}

function mergeFootnoteReservedHeights(
  a: Map<number, number>,
  b: Map<number, number>
): Map<number, number> {
  const merged = new Map(a);
  for (const [pageNumber, height] of b) {
    merged.set(pageNumber, Math.max(merged.get(pageNumber) ?? 0, height));
  }
  return merged;
}

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
// 1. Scan FlowBlocks for footnote references
// ============================================================================

/**
 * Where a footnote reference lives, as found by {@link collectFootnoteRefs}.
 *
 * `pmPos` alone is enough to attribute a reference to a page for ordinary
 * (paragraph) content, whose fragments carry a per-page pm sub-range. A table
 * is different: it splits across pages by ROW, but every `TableFragment` keeps
 * the whole table's `docFrom`/`docTo` (those drive selection mapping and must
 * not be narrowed). So for a reference authored inside a table cell we also
 * record the OUTERMOST table's id and the index of the row that contains it,
 * letting {@link mapFootnotesToPages} attribute the reference to the page that
 * actually laid out that row.
 */
export type FootnoteRefLocation = {
  footnoteId: number;
  pmPos: number;
  /** Id of the outermost enclosing table block, when the ref is in a table cell. */
  tableNodeId?: NodeId;
  /** Index (into the outermost table's `rows`) of the row holding the ref. */
  rowIndex?: number;
};

/**
 * Scan FlowBlocks for runs with footnoteRefId set.
 * Returns a list of {@link FootnoteRefLocation} in document order.
 *
 * Recurses into container nodes (table cells, text boxes) so footnote
 * references authored anywhere in the body reach the page-reservation
 * pass. Without this, a `footnoteRefId` nested inside a table cell never
 * gets mapped to a page and the per-page `.layout-footnote-area` silently
 * drops that entry even though the body still renders the in-line ref
 * marker.
 *
 * For refs inside a table, the OUTERMOST table's id and row index are
 * recorded (a nested table keeps the outer context, since the outer row is
 * what the pageComposer splits into per-page fragments).
 */
export function collectFootnoteRefs(nodes: ContentNode[]): FootnoteRefLocation[] {
  const refs: FootnoteRefLocation[] = [];

  const walk = (
    input: ContentNode[],
    tableCtx?: { tableNodeId: NodeId; rowIndex: number }
  ): void => {
    for (const block of input) {
      if (block.kind === 'paragraph') {
        for (const run of block.runs) {
          if (run.kind === 'text' && run.footnoteRefId != null) {
            refs.push({
              footnoteId: run.footnoteRefId,
              pmPos: run.docFrom ?? 0,
              ...(tableCtx ?? {}),
            });
          }
        }
      } else if (block.kind === 'table') {
        block.rows.forEach((row, rowIndex) => {
          for (const cell of row.cells) {
            // Keep the outermost table context for nested tables: the outer
            // row is the unit the pageComposer places on a page.
            walk(cell.nodes, tableCtx ?? { tableNodeId: block.id, rowIndex });
          }
        });
      } else if (block.kind === 'textBox') {
        walk(block.content, tableCtx);
      }
    }
  };

  walk(nodes);

  return refs;
}

// ============================================================================
// 2. Map footnote references to pages
// ============================================================================

interface FootnotePageIndex {
  ranges: Array<{ from: number; to: number; pageNumber: number }>;
  tableRows: Map<string, Array<{ fromRow: number; toRow: number; pageNumber: number }>>;
}

/**
 * Build the immutable lookup used for all references in one layout pass.
 *
 * Body ranges are disjoint and sorted by PM position; table row slices are
 * indexed per table. Lookup is therefore O(log fragments) instead of scanning
 * every page and every fragment for every reference on every stabilization pass.
 */
function buildFootnotePageIndex(pages: Page[]): FootnotePageIndex {
  const ranges: FootnotePageIndex['ranges'] = [];
  const tableRows: FootnotePageIndex['tableRows'] = new Map();

  for (const page of pages) {
    for (const fragment of page.fragments) {
      if (fragment.kind === 'table') {
        const key = String(fragment.blockId);
        const slices = tableRows.get(key) ?? [];
        slices.push({
          fromRow: fragment.fromRow,
          toRow: fragment.toRow,
          pageNumber: page.number,
        });
        tableRows.set(key, slices);
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
  for (const slices of tableRows.values()) {
    slices.sort((a, b) => a.fromRow - b.fromRow);
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
  rowIndex: number
): number | undefined {
  const slices = index.tableRows.get(String(tableBlockId));
  if (!slices) return undefined;

  let low = 0;
  let high = slices.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const slice = slices[mid];
    if (rowIndex < slice.fromRow) high = mid - 1;
    else if (rowIndex >= slice.toRow) low = mid + 1;
    else return slice.pageNumber;
  }
  return undefined;
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
  const index = buildFootnotePageIndex(pages);

  const assign = (pageNumber: number, footnoteId: number): void => {
    const existing = pageFootnotes.get(pageNumber) ?? [];
    // Avoid duplicates (same footnote shouldn't appear twice on same page)
    if (!existing.includes(footnoteId)) existing.push(footnoteId);
    pageFootnotes.set(pageNumber, existing);
  };

  for (const ref of footnoteRefs) {
    const pageNumber =
      ref.tableBlockId != null && ref.rowIndex != null
        ? pageForTableRow(index, ref.tableBlockId, ref.rowIndex)
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
  contentWidth: number,
  config: ConvertFootnoteOptions
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
      convertFootnoteToContent(footnote, displayNumber, contentWidth, config)
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
}

interface FootnotePaginationPlan {
  reservedHeights: Map<number, number>;
  fragmentsByPage: Map<number, FootnoteFragment[]>;
  footnoteIdsByPage: Map<number, number[]>;
  minimumPageCount: number;
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
  columns: number
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

  const columnCount = Math.max(1, Math.floor(columns));
  const reservedHeights = new Map<number, number>();
  const fragmentsByPage = new Map<number, FootnoteFragment[]>();
  const footnoteIdsByPage = new Map<number, number[]>();
  let pending: PendingFootnote[] = [];
  let pageNumber = 1;

  while (pageNumber <= lastStartPage || pending.length > 0) {
    const carriedFootnoteIds = new Set(pending.map((state) => state.content.id));
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
          current = { content: current.content, cursor: taken.cursor };
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
        const remainder = consume(
          { content, cursor: { blockIndex: 0, unitIndex: 0 } },
          starterBudget
        );
        if (remainder) nextPending.push(remainder);
      }
      pending = nextPending;
    }

    const continuingFootnoteIds = new Set(pending.map((state) => state.content.id));
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
    fragmentsByPage,
    footnoteIdsByPage,
    minimumPageCount: Math.max(pages.length, pageNumber - 1),
  };
}

function footnotePlansEqual(a: FootnotePaginationPlan, b: FootnotePaginationPlan): boolean {
  if (!footnoteReservedHeightsEqual(a.reservedHeights, b.reservedHeights)) return false;
  if (a.minimumPageCount !== b.minimumPageCount) return false;
  if (a.fragmentsByPage.size !== b.fragmentsByPage.size) return false;
  for (const [pageNumber, fragments] of a.fragmentsByPage) {
    const other = b.fragmentsByPage.get(pageNumber);
    if (!other || other.length !== fragments.length) return false;
    for (let i = 0; i < fragments.length; i++) {
      const left = fragments[i];
      const right = other[i];
      if (
        left.footnoteId !== right.footnoteId ||
        left.height !== right.height ||
        left.continuesFromPrev !== right.continuesFromPrev ||
        left.continuesOnNext !== right.continuesOnNext ||
        left.columnIndex !== right.columnIndex ||
        left.blocks.length !== right.blocks.length
      ) {
        return false;
      }
      for (let j = 0; j < left.blocks.length; j++) {
        if (JSON.stringify(left.blocks[j]) !== JSON.stringify(right.blocks[j])) return false;
      }
    }
  }
  return true;
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
  const { nodes, metrics, layoutConfig, footnoteRefs, footnoteContentMap, initialLayout } = args;
  const footnoteColumns = Math.max(1, args.footnoteColumns ?? 1);

  let referenceMap = mapFootnotesToPages(initialLayout.pages, footnoteRefs);
  let plan = paginateFootnoteFragments(
    initialLayout.pages,
    referenceMap,
    footnoteContentMap,
    footnoteColumns
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
    const nextPlan = paginateFootnoteFragments(
      newLayout.pages,
      nextReferenceMap,
      footnoteContentMap,
      footnoteColumns
    );

    referenceMap = nextReferenceMap;
    if (footnotePlansEqual(plan, nextPlan)) {
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
      const requiredPlan = paginateFootnoteFragments(
        newLayout.pages,
        referenceMap,
        footnoteContentMap,
        footnoteColumns
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
      plan = paginateFootnoteFragments(
        newLayout.pages,
        referenceMap,
        footnoteContentMap,
        footnoteColumns
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
    page.footnoteFragments = fragments;
    page.footnoteIds = plan.footnoteIdsByPage.get(page.number);
    if (footnoteColumns > 1) page.footnoteColumns = footnoteColumns;
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
