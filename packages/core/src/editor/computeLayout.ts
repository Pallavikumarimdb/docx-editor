/**
 * The pure layout COMPUTE pass shared by the React and Vue adapters — issue
 * #696 Tier 2, the clean half of the engine spine.
 *
 * This is the 6-step pass from React's `useLayoutPipeline` minus the DOM paint
 * + scroll/event side-effects (which stay adapter-side, where the framework
 * timing lives): PM doc → flow nodes → measure → header/footer resolve →
 * margin extension → `layOutPages` (+ two-pass footnote stabilization) →
 * footnote render items. It is pure (no DOM, no refs, no rAF) and returns
 * everything the adapter needs to paint.
 *
 * The one injected seam is `measureBlocks` — each adapter passes its own
 * measurer (React's is caching), same pattern as `measureBlocksWithFloats`.
 * `getHfPmDoc` is the HF-unification seam (prefer the persistent PM doc over
 * re-parsing `HeaderFooter.content`).
 */

import type { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

import {
  layOutPages,
  type ColumnLayout,
  type ContentNode,
  type FootnoteContent,
  type PageLayout,
  type LayoutMetrics,
  type PageMargins,
  type SectionMarkerBlock,
} from '../pagination-model';
import {
  buildBoxTree,
  computePerBlockWidths,
  demoteBlockLikeFloatingTables,
  collectFootnoteRefs,
  convertHeaderFooterToContent,
  convertHeaderFooterPmDocToContent,
  buildFootnoteContentMap,
  buildFootnoteRenderItems,
  stabilizeFootnoteLayout,
  FOOTNOTE_COLUMN_GAP_PX,
  getColumns,
  getMargins,
  getPageSize,
  resolvePageHeaderFooter,
  twipsToPixels,
  type FloatPageGeometry,
} from '../flow-model';
import {
  pageGeometryFromPage,
  type FootnoteRenderItem,
  type HeaderFooterContent,
} from '../painter-model';
import type {
  Document,
  HeaderFooter,
  SectionProperties,
  StyleDefinitions,
  Theme,
  Watermark,
} from '../types/document';
import { registerPageFurniture, type PageFurniture } from '../painter-model/pageFurnitureRegistry';

interface PageSizePx {
  w: number;
  h: number;
}

/** Adapter-supplied block measurer (React's is caching). */
export type MeasureBlocksFn = (
  nodes: ContentNode[],
  contentWidth: number | number[],
  pageGeometry?: FloatPageGeometry
) => LayoutMetrics[];

export interface ComputeLayoutInputs {
  state: EditorState;
  document: Document | null;
  pageSize: PageSizePx;
  margins: PageMargins;
  columns: ColumnLayout | undefined;
  finalPageSize: PageSizePx;
  finalMargins: PageMargins;
  finalColumns: ColumnLayout | undefined;
  pageGap: number;
  contentWidth: number;
  theme: Theme | null | undefined;
  styles: StyleDefinitions | null | undefined;
  sectionProperties: SectionProperties | null | undefined;
  finalSectionProperties: SectionProperties | null | undefined;
  /** Resolved HF objects for the section (default + first-page). */
  headerContent: HeaderFooter | null | undefined;
  footerContent: HeaderFooter | null | undefined;
  firstPageHeaderContent: HeaderFooter | null | undefined;
  firstPageFooterContent: HeaderFooter | null | undefined;
  measureBlocks: MeasureBlocksFn;
  /** HF unification: the persistent PM doc for an HF, or null to re-parse content. */
  getHfPmDoc: (hf: HeaderFooter) => PMNode | null | undefined;
}

export interface LayoutComputation {
  nodes: ContentNode[];
  metrics: LayoutMetrics[];
  layout: PageLayout;
  headerContentForRender: HeaderFooterContent | undefined;
  footerContentForRender: HeaderFooterContent | undefined;
  firstPageHeaderForRender: HeaderFooterContent | undefined;
  firstPageFooterForRender: HeaderFooterContent | undefined;
  hasTitlePg: boolean;
  watermark: Watermark | undefined;
  headerDistancePx: number | undefined;
  footerDistancePx: number | undefined;
  pageBorders: SectionProperties['pageBorders'] | undefined;
  footnotesByPage: Map<number, FootnoteRenderItem[]> | undefined;
}

/**
 * Resolve the document-level footnote column layout from `w15:footnoteColumns`.
 *
 * Footnotes paint N-up when any section opts into multiple footnote columns.
 * In a mixed-section document we take the first multi-column section's count
 * and full content width (a documented limitation — per-section footnote
 * column counts are a follow-up); the overwhelmingly common case is a single
 * uniform setting. Returns `{ columns: 1, columnWidth: fallback }` — i.e. the
 * unchanged single-column path — when no section opts in.
 */
function resolveFootnoteColumnLayout(
  document: Document | null,
  fallbackColumnWidth: number
): { columns: number; columnWidth: number } {
  const body = document?.package?.document;
  const sectionProps: Array<SectionProperties | null | undefined> = body
    ? [...(body.sections ?? []).map((s) => s.properties), body.finalSectionProperties]
    : [];
  const fnSection = sectionProps.find((p) => (p?.footnoteColumns ?? 1) > 1);
  if (!fnSection?.footnoteColumns) {
    return { columns: 1, columnWidth: fallbackColumnWidth };
  }

  const columns = fnSection.footnoteColumns;
  // Footnote columns span the section's full content width, independent of the
  // body's w:cols. Mirror the painter's width math so a footnote measured here
  // wraps exactly as it paints.
  const sectionContentWidthPx =
    fnSection.pageWidth != null
      ? twipsToPixels(
          fnSection.pageWidth - (fnSection.marginLeft ?? 1440) - (fnSection.marginRight ?? 1440)
        )
      : fallbackColumnWidth;
  const columnWidth = (sectionContentWidthPx - (columns - 1) * FOOTNOTE_COLUMN_GAP_PX) / columns;
  return { columns, columnWidth: Math.max(1, columnWidth) };
}

/**
 * Run the pure layout compute pass (the 6 steps in this file's header), lifted
 * verbatim from `useLayoutPipeline`. The adapter performs the DOM paint
 * (`paintPages`), scroll-restore, `painter:painted`, and state writeback with
 * the returned values.
 */
export function computeLayout(inputs: ComputeLayoutInputs): LayoutComputation {
  const {
    state,
    document,
    pageSize,
    margins,
    columns,
    finalPageSize,
    finalMargins,
    finalColumns,
    pageGap,
    contentWidth,
    theme,
    styles,
    sectionProperties,
    finalSectionProperties,
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    measureBlocks,
    getHfPmDoc,
  } = inputs;

  const sectionProps =
    document?.package.document.sections?.map((section) => section.properties) ?? [];
  if (sectionProps.length === 0) {
    sectionProps.push(sectionProperties ?? finalSectionProperties ?? {});
  }
  const firstSectionProps = sectionProps[0] ?? sectionProperties ?? {};
  const lastSectionProps = sectionProps[sectionProps.length - 1] ?? finalSectionProperties ?? {};
  const resolvedPageSize = document ? getPageSize(firstSectionProps) : pageSize;
  const resolvedMargins = document ? getMargins(firstSectionProps) : margins;
  const resolvedColumns = document ? getColumns(firstSectionProps) : columns;
  const resolvedFinalPageSize = document ? getPageSize(lastSectionProps) : finalPageSize;
  const resolvedFinalMargins = document ? getMargins(lastSectionProps) : finalMargins;
  const resolvedFinalColumns = document ? getColumns(lastSectionProps) : finalColumns;

  // Step 1: PM doc → flow blocks.
  const pageContentHeight = resolvedPageSize.h - resolvedMargins.top - resolvedMargins.bottom;
  const blocks = buildBoxTree(state.doc, { theme, pageContentHeight });

  // Section markers in the PM carry the authored sectPr that closes each
  // section. Rebind them to the parser's effective section list so inherited
  // HF refs plus explicit zero distances survive and every later section gets
  // its own complete geometry.
  let markerIndex = 0;
  for (const block of blocks) {
    if (block.kind !== 'sectionBreak') continue;
    const properties = sectionProps[markerIndex++] ?? firstSectionProps;
    const marker = block as SectionMarkerBlock;
    marker.pageSize = getPageSize(properties);
    marker.margins = getMargins(properties);
    marker.columns = getColumns(properties);
    marker.type = properties.sectionStart;
  }

  // Step 2: Measure all blocks (per-section widths; full measure for float context).
  const blockWidths = computePerBlockWidths(
    blocks,
    {
      pageSize: resolvedPageSize,
      margins: resolvedMargins,
      columns: resolvedColumns,
    },
    {
      pageSize: resolvedFinalPageSize,
      margins: resolvedFinalMargins,
      columns: resolvedFinalColumns,
    }
  );

  // Step 1.5: Demote full-width "floating" tables to inline. A positioned table
  // that leaves no room for text to wrap beside it (a common full-width contract
  // form table) is block-like in Word/Google Docs — it paginates across pages.
  // Our floating path instead paints it as one overflowing fragment AND makes
  // the next paragraph skip past the whole table height (a wrap zone), stranding
  // it off-page. Clearing `floating` here — before measure and layout — routes
  // it through `layoutTable` (which breaks rows across pages) and suppresses the
  // wrap zone. Purely a layout transform on the ephemeral FlowBlocks; the PM doc
  // and the saved DOCX keep the original floating table.
  demoteBlockLikeFloatingTables(nodes, blockWidths, contentWidth);

  const measures = measureBlocks(
    blocks,
    blockWidths,
    pageGeometryFromPage({
      size: resolvedPageSize,
      margins: resolvedMargins,
    })
  );

  // Step 2.5: Footnote references.
  const footnoteRefs = collectFootnoteRefs(nodes);
  const hasFootnotes = footnoteRefs.length > 0 && !!document?.package?.footnotes;

  // Step 2.75: Header/footer content is resolved per physical page. Conversion
  // is cached per section/rId because the same story can wrap differently when
  // later sections change page width or margins.
  const defaultTabMarkTwips = state.doc.attrs?.defaultTabMarkTwips as number | null;
  const hfOptions = { styles, theme, measureBlocks, defaultTabMarkTwips };
  const converted = new Map<string, HeaderFooterContent | undefined>();

  const convertHf = (
    hf: HeaderFooter | null | undefined,
    region: 'header' | 'footer',
    sectionIndex: number,
    rId: string | null
  ): HeaderFooterContent | undefined => {
    if (!hf) return undefined;
    const key = `${sectionIndex}:${region}:${rId ?? 'anonymous'}`;
    if (converted.has(key)) return converted.get(key);
    const properties = sectionProps[sectionIndex] ?? firstSectionProps;
    const sectionPageSize = getPageSize(properties);
    const sectionMargins = getMargins(properties);
    const sectionContentWidth = sectionPageSize.w - sectionMargins.left - sectionMargins.right;
    const metrics = { section: region, pageSize: sectionPageSize, margins: sectionMargins };
    const pmDoc = getHfPmDoc(hf);
    const value = pmDoc
      ? convertHeaderFooterPmDocToContent(pmDoc, sectionContentWidth, metrics, hfOptions)
      : convertHeaderFooterToContent(hf, sectionContentWidth, metrics, hfOptions);
    converted.set(key, value);
    return value;
  };

  const furnitureByPageNumber = new Map<number, PageFurniture>();
  const resolveFurniture = (
    pageNumber: number,
    sectionIndex: number,
    sectionPageNumber: number
  ): PageFurniture => {
    if (!document) {
      const firstVariant = sectionPageNumber === 1 && sectionProperties?.titlePg === true;
      return {
        sectionIndex,
        sectionPageNumber,
        headerRId: null,
        footerRId: null,
        headerVariant: firstVariant ? 'first' : 'default',
        footerVariant: firstVariant ? 'first' : 'default',
        headerContent: convertHf(
          firstVariant ? firstPageHeaderContent : headerContent,
          'header',
          sectionIndex,
          null
        ),
        footerContent: convertHf(
          firstVariant ? firstPageFooterContent : footerContent,
          'footer',
          sectionIndex,
          null
        ),
        headerDistance: resolvedMargins.header ?? 48,
        footerDistance: resolvedMargins.footer ?? 48,
        pageBorders: firstSectionProps.pageBorders,
      };
    }
    const resolved = resolvePageHeaderFooter(document, pageNumber, sectionIndex, sectionPageNumber);
    return {
      sectionIndex,
      sectionPageNumber,
      headerRId: resolved.header.rId,
      footerRId: resolved.footer.rId,
      headerVariant: resolved.header.variant,
      footerVariant: resolved.footer.variant,
      headerContent: convertHf(
        resolved.header.content,
        'header',
        sectionIndex,
        resolved.header.rId
      ),
      footerContent: convertHf(
        resolved.footer.content,
        'footer',
        sectionIndex,
        resolved.footer.rId
      ),
      headerDistance: resolved.headerDistance,
      footerDistance: resolved.footerDistance,
      pageBorders: resolved.pageBorders,
    };
  };

  // Watermark rides PM state as a doc attr (so it's undoable).
  const watermark = (state.doc.attrs?.watermark as Watermark | null) ?? undefined;

  // Step 3: Layout onto pages (two-pass when footnotes exist).
  const bodyBreakType = lastSectionProps.sectionStart as
    | 'continuous'
    | 'nextPage'
    | 'evenPage'
    | 'oddPage'
    | undefined;
  const layoutOpts = {
    pageSize: resolvedPageSize,
    margins: resolvedMargins,
    finalPageSize: resolvedFinalPageSize,
    finalMargins: resolvedFinalMargins,
    columns: resolvedFinalColumns,
    bodyBreakType,
    pageGap,
    resolvePageMargins: ({
      base,
      pageNumber,
      sectionIndex,
      sectionPageNumber,
    }: {
      base: PageMargins;
      pageNumber: number;
      sectionIndex: number;
      sectionPageNumber: number;
    }): PageMargins => {
      const furniture = resolveFurniture(pageNumber, sectionIndex, sectionPageNumber);
      const headerHeight =
        furniture.headerContent?.flowHeight ?? furniture.headerContent?.height ?? 0;
      const footerHeight =
        furniture.footerContent?.flowHeight ?? furniture.footerContent?.height ?? 0;
      const out = { ...base };
      if (headerHeight > base.top - furniture.headerDistance) {
        out.top = Math.max(base.top, furniture.headerDistance + headerHeight);
      }
      if (footerHeight > base.bottom - furniture.footerDistance) {
        out.bottom = Math.max(base.bottom, furniture.footerDistance + footerHeight);
      }
      const sectionHeight = getPageSize(sectionProps[sectionIndex] ?? firstSectionProps).h;
      const maxMargins = Math.max(0, sectionHeight - 24);
      if (out.top + out.bottom > maxMargins) {
        out.bottom = Math.max(0, Math.min(out.bottom, maxMargins - out.top));
        if (out.top + out.bottom > maxMargins) out.top = Math.max(0, maxMargins - out.bottom);
      }
      return out;
    },
    onPageStart: ({
      pageNumber,
      sectionIndex,
      sectionPageNumber,
    }: {
      pageNumber: number;
      sectionIndex: number;
      sectionPageNumber: number;
    }) => {
      furnitureByPageNumber.set(
        pageNumber,
        resolveFurniture(pageNumber, sectionIndex, sectionPageNumber)
      );
    },
  };

  let layout: PageLayout;
  let pageFootnoteMap = new Map<number, number[]>();
  let footnoteContentMap = new Map<number, FootnoteContent>();

  if (hasFootnotes) {
    const pass1Layout = layOutPages(nodes, metrics, layoutConfig);
    // w15:footnoteColumns: when a section lays its footnotes out in multiple
    // columns, measure each footnote at the column width (so it wraps the way
    // it will paint) rather than the full content width.
    const { columns: footnoteColumns, columnWidth: footnoteColumnWidth } =
      resolveFootnoteColumnLayout(document, contentWidth);
    footnoteContentMap = buildFootnoteContentMap(
      document!.package.footnotes!,
      footnoteRefs,
      footnoteColumnWidth,
      {
        styles: styles ?? undefined,
        theme: theme ?? null,
        measureBlocks,
        defaultTabMarkTwips,
      }
    );
    const stabilized = stabilizeFootnoteLayout({
      nodes,
      metrics,
      layoutConfig,
      footnoteRefs,
      footnoteContentMap,
      initialLayout: pass1Layout,
      footnoteColumns,
    });
    layout = stabilized.layout;
    pageFootnoteMap = stabilized.pageFootnoteMap;
  } else {
    layout = layOutPages(nodes, metrics, layoutConfig);
  }

  const footnotesByPage = hasFootnotes
    ? buildFootnoteRenderItems(pageFootnoteMap, footnoteContentMap, document)
    : undefined;

  for (const page of layout.pages) {
    const furniture = furnitureByPageNumber.get(page.number);
    if (furniture) registerPageFurniture(page, furniture);
  }
  const firstFurniture = furnitureByPageNumber.get(1);
  const headerContentForRender = firstFurniture?.headerContent;
  const footerContentForRender = firstFurniture?.footerContent;
  const hasTitlePg = firstSectionProps.titlePg === true;
  const firstPageHeaderForRender =
    hasTitlePg && firstFurniture?.headerVariant === 'first'
      ? firstFurniture.headerContent
      : undefined;
  const firstPageFooterForRender =
    hasTitlePg && firstFurniture?.footerVariant === 'first'
      ? firstFurniture.footerContent
      : undefined;

  return {
    nodes,
    metrics,
    layout,
    headerContentForRender,
    footerContentForRender,
    firstPageHeaderForRender,
    firstPageFooterForRender,
    hasTitlePg,
    watermark,
    headerDistancePx: firstFurniture?.headerDistance,
    footerDistancePx: firstFurniture?.footerDistance,
    pageBorders: firstFurniture?.pageBorders,
    footnotesByPage: footnotesByPage?.size ? footnotesByPage : undefined,
  };
}
