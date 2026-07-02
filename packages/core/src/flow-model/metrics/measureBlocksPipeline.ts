/**
 * Floating-aware block measurement pipeline.
 *
 * Pre-scans a block list to extract exclusion zones from anchored images,
 * floating tables, and floating text boxes; estimates page/section/column
 * flow scopes; then walks the blocks calling the caller-supplied
 * `measureBlock` with only the zones active in that scope.
 *
 * Adapters (React, Vue) provide their own `measureBlock` so they can
 * decide e.g. whether to cache paragraph metrics. The orchestration,
 * extraction, and grouping live here so both adapters stay in lockstep.
 *
 * @packageDocumentation
 * @public
 */
import {
  isFloatingTextBoxBlock,
  isWrapNone,
  type ContentNode,
  type ImageRun,
  type ImageRunPosition,
  type LayoutMetrics,
  type ParagraphBlock,
  type TableBlock,
  type TextBoxBlock,
} from '../../pagination-model';
import { isTextWrappingFloatingImageRun } from '../../painter-model/floatingImageFlow';
import {
  resolveAnchoredObjectVerticalTop,
  type PageGeometry,
} from '../../painter-model/anchoredObjectPosition';
import { emuToPixels } from '../../utils/units';
import { constrainWrapMargins } from './paragraphLayout';
import type { FloatingImageZone } from './floatingZones';
import { measureTable } from '../measureTable';

/**
 * A floating exclusion zone tagged with the block index that anchors it.
 */
interface FloatingZoneWithAnchor extends FloatingImageZone {
  anchorNodeIndex: number;
  /** True for floats positioned relative to page/margin (not paragraph). */
  isMarginRelative?: boolean;
}

interface FloatFlowScopes {
  geometryByBlock: Array<FloatPageGeometry | undefined>;
  baseMeasures: Measure[];
}

/**
 * Block-measurement callback shape passed to {@link measureBlocksWithFloats}.
 * Adapters (React, Vue) supply this so they can decide platform-specific
 * concerns (e.g. paragraph-measure caching, per-section width) while
 * sharing the floating-zone orchestration. This is adapter-author API,
 * not end-consumer API.
 *
 * @public
 */
export type MeasureBlockFn = (
  block: ContentNode,
  contentWidth: number,
  floatingZones?: FloatingImageZone[],
  cumulativeY?: number
) => LayoutMetrics;

/**
 * Page geometry (CSS px) used to resolve page/margin-relative anchored objects
 * into content-area coordinates — currently the vertical anchor of a top-pinned
 * `topAndBottom` band. Same shape the painter uses (see `pageGeometryFromPage`),
 * so both paths resolve to identical positions.
 *
 * @public
 */
export type FloatPageGeometry = PageGeometry;

/**
 * Walk `nodes` and produce one `LayoutMetrics` per block. Before measuring, this
 * extracts floating exclusion zones (images / floating tables / floating
 * textboxes), scopes them to their anchor's page/section flow interval, and
 * threads the active zones plus cumulative Y into each `measureBlock` call.
 *
 * Pass `pageGeometry` whenever the document may contain page/margin-anchored
 * `topAndBottom` text boxes (e.g. a title banner pinned to the page top):
 * without it their reserved band falls back to flow-relative Y and the band
 * won't line up with where the painter places the box. Build it with the
 * shared `pageGeometryFromPage` helper.
 *
 * @public
 */
export function measureBlocksWithFloats(
  nodes: ContentNode[],
  contentWidth: number | number[],
  measureBlock: MeasureBlockFn,
  pageGeometry?: FloatPageGeometry
): LayoutMetrics[] {
  const defaultWidth = Array.isArray(contentWidth) ? (contentWidth[0] ?? 0) : contentWidth;
  const blockWidthAt = (blockIndex: number): number =>
    Array.isArray(contentWidth) ? (contentWidth[blockIndex] ?? defaultWidth) : contentWidth;
  const scopes = buildFloatFlowScopes(blocks, blockWidthAt, measureBlock, pageGeometry);
  const floatingZonesWithAnchors = extractFloatingZones(
    blocks,
    blockWidthAt,
    measureBlock,
    scopes.geometryByBlock
  );

  const zonesByAnchor = new Map<number, FloatingZoneWithAnchor[]>();
  for (const zone of floatingZonesWithAnchors) {
    const existing = zonesByAnchor.get(zone.anchorBlockIndex) ?? [];
    existing.push(zone);
    zonesByAnchor.set(zone.anchorBlockIndex, existing);
  }

  let cumulativeY = 0;
  let activeZones: FloatingImageZone[] = [];
  let startsNewScope = blocks.length > 0;
  const measures: Measure[] = [];

  const activateAnchoredZones = (blockIndex: number): void => {
    for (const anchored of zonesByAnchor.get(blockIndex) ?? []) {
      const { anchorBlockIndex: _anchorBlockIndex, isMarginRelative, ...zone } = anchored;
      activeZones.push(
        isMarginRelative
          ? zone
          : {
              ...zone,
              topY: zone.topY + cumulativeY,
              bottomY: zone.bottomY + cumulativeY,
            }
      );
    }
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (startsNewScope) {
      cumulativeY = 0;
      activeZones = [];
      startsNewScope = false;
    }

    activateAnchoredZones(blockIndex);
    activeZones = activeZones.filter((zone) => zone.bottomY > cumulativeY);
    const blockWidth = blockWidthAt(blockIndex);
    let zones = activeZones.length > 0 ? activeZones : undefined;
    let measure =
      zones == null
        ? scopes.baseMeasures[blockIndex]
        : measureBlock(block, blockWidth, zones, cumulativeY);
    let height = measureFlowHeight(block, measure);
    const contentHeight =
      scopes.geometryByBlock[blockIndex]?.contentHeight ?? Number.POSITIVE_INFINITY;

    // A zone can increase this block's measured height enough to move the block
    // itself onto the next page. Re-evaluate it at the new scope origin without
    // zones from the previous page; otherwise the stale zone becomes the reason
    // it keeps wrapping after the page break.
    if (
      height > 0 &&
      cumulativeY > 0 &&
      Number.isFinite(contentHeight) &&
      cumulativeY + height > contentHeight
    ) {
      cumulativeY = 0;
      activeZones = [];
      activateAnchoredZones(blockIndex);
      activeZones = activeZones.filter((zone) => zone.bottomY > 0);
      zones = activeZones.length > 0 ? activeZones : undefined;
      measure =
        zones == null
          ? scopes.baseMeasures[blockIndex]
          : measureBlock(block, blockWidth, zones, cumulativeY);
      height = measureFlowHeight(block, measure);
    }
    measures.push(measure);

    // Floating tables don't advance flow Y (their wrap zone already accounts
    // for vertical space). Every other measurable block advances the scope pen.
    cumulativeY += height;

    if (
      block.kind === 'pageBreak' ||
      block.kind === 'columnBreak' ||
      block.kind === 'sectionBreak' ||
      (Number.isFinite(contentHeight) && cumulativeY >= contentHeight)
    ) {
      startsNewScope = true;
    }
  }

  return measures;
}

function buildFloatFlowScopes(
  blocks: FlowBlock[],
  blockWidthAt: (blockIndex: number) => number,
  measureBlock: MeasureBlockFn,
  initialGeometry?: FloatPageGeometry
): FloatFlowScopes {
  const geometryByBlock: Array<FloatPageGeometry | undefined> = [];
  const baseMeasures: Measure[] = [];
  let geometry = initialGeometry;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    geometryByBlock.push(geometry);
    const measure = measureBlock(block, blockWidthAt(blockIndex));
    baseMeasures.push(measure);

    if (block.kind === 'sectionBreak') {
      geometry = geometryAfterSectionBreak(geometry, block, blockWidthAt(blockIndex + 1));
    }
  }

  return { geometryByBlock, baseMeasures };
}

function measureFlowHeight(block: FlowBlock, measure: Measure): number {
  if (block.kind === 'table' && (block as TableBlock).floating) return 0;
  if (block.kind === 'textBox' && isFloatingTextBoxBlock(block as TextBoxBlock)) return 0;
  if ('totalHeight' in measure) return measure.totalHeight;
  if ('height' in measure) return measure.height;
  return 0;
}

function geometryAfterSectionBreak(
  current: FloatPageGeometry | undefined,
  marker: Extract<FlowBlock, { kind: 'sectionBreak' }>,
  fallbackContentWidth: number
): FloatPageGeometry | undefined {
  const pageWidth = marker.pageSize?.w ?? current?.pageWidth;
  const pageHeight = marker.pageSize?.h ?? current?.pageHeight;
  const marginLeft = marker.margins?.left ?? current?.marginLeft ?? 0;
  const marginTop = marker.margins?.top ?? current?.marginTop ?? 0;
  const marginRight =
    marker.margins?.right ??
    (current ? current.pageWidth - current.marginLeft - current.contentWidth : 0);
  const marginBottom =
    marker.margins?.bottom ??
    (current ? current.pageHeight - current.marginTop - current.contentHeight : 0);
  if (pageWidth == null || pageHeight == null) return current;
  return {
    pageWidth,
    pageHeight,
    marginLeft,
    marginTop,
    contentWidth: Math.max(0, pageWidth - marginLeft - marginRight) || fallbackContentWidth,
    contentHeight: Math.max(0, pageHeight - marginTop - marginBottom),
  };
}

/**
 * Extract floating exclusion zones from all nodes that anchor floats —
 * paragraph runs (images), top-level floating tables, and top-level
 * floating textboxes. Paragraph-relative zones are relative to their anchor;
 * margin/page-relative zones use the anchor section's content-area coordinates.
 */
function extractFloatingZones(
  blocks: FlowBlock[],
  blockWidthAt: (blockIndex: number) => number,
  measureBlock: MeasureBlockFn,
  geometryByBlock: Array<FloatPageGeometry | undefined>
): FloatingZoneWithAnchor[] {
  const zones: FloatingZoneWithAnchor[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const contentWidth = blockWidthAt(blockIndex);
    const pageGeometry = geometryByBlock[blockIndex];
    switch (block.kind) {
      case 'paragraph':
        extractImageZonesFromParagraph(block as ParagraphBlock, nodeIndex, contentWidth, zones);
        break;
      case 'table':
        extractFloatingTableZone(block as TableBlock, nodeIndex, contentWidth, measureBlock, zones);
        break;
      case 'textBox':
        extractFloatingTextBoxZone(
          block as TextBoxBlock,
          nodeIndex,
          contentWidth,
          zones,
          pageGeometry
        );
        break;
    }
  }

  return zones;
}

/**
 * Resolve left/right exclusion margins for an OOXML-positioned anchored
 * object (image or text box). Shared between image-in-paragraph and
 * top-level textbox extraction since both use the same
 * `ImageRunPosition` shape and `cssFloat` fallback.
 */
function computeAnchoredMargins(
  position: ImageRunPosition | undefined,
  cssFloat: 'left' | 'right' | 'none' | undefined,
  width: number,
  distLeft: number,
  distRight: number,
  contentWidth: number
): { leftMargin: number; rightMargin: number } {
  let leftMargin = 0;
  let rightMargin = 0;

  const h = position?.horizontal;
  if (h?.align === 'left') {
    leftMargin = width + distRight;
  } else if (h?.align === 'right') {
    rightMargin = width + distLeft;
  } else if (h?.posOffset !== undefined) {
    const x = emuToPixels(h.posOffset);
    if (x < contentWidth / 2) {
      leftMargin = x + width + distRight;
    } else {
      rightMargin = contentWidth - x + distLeft;
    }
  } else if (cssFloat === 'left') {
    leftMargin = width + distRight;
  } else if (cssFloat === 'right') {
    rightMargin = width + distLeft;
  }

  return constrainWrapMargins(leftMargin, rightMargin, contentWidth);
}

/**
 * True when an OOXML position anchors vertically against the page or
 * margin (not the surrounding paragraph). Margin/page-relative zones
 * apply globally across nodes instead of attaching to one anchor
 * paragraph.
 */
function isPositionMarginRelative(position: ImageRunPosition | undefined): boolean {
  const rel = position?.vertical?.relativeTo;
  return rel === 'margin' || rel === 'page';
}

function extractImageZonesFromParagraph(
  paragraphBlock: ParagraphBlock,
  nodeIndex: number,
  contentWidth: number,
  out: FloatingZoneWithAnchor[]
): void {
  for (const run of paragraphBlock.runs) {
    if (run.kind !== 'image') continue;
    const imgRun = run as ImageRun;
    if (!isTextWrappingFloatingImageRun(imgRun)) continue;

    const distTop = imgRun.distTop ?? 0;
    const distBottom = imgRun.distBottom ?? 0;
    const distLeft = imgRun.distLeft ?? 12;
    const distRight = imgRun.distRight ?? 12;

    let topY = 0;
    const v = imgRun.position?.vertical;
    if (v?.align === 'top' && v.relativeTo === 'margin') {
      topY = 0;
    } else if (v?.posOffset !== undefined) {
      topY = emuToPixels(v.posOffset);
    }
    const bottomY = topY + imgRun.height;

    const { leftMargin, rightMargin } = computeAnchoredMargins(
      imgRun.position,
      imgRun.cssFloat,
      imgRun.width,
      distLeft,
      distRight,
      contentWidth
    );

    if (leftMargin > 0 || rightMargin > 0) {
      out.push({
        leftMargin,
        rightMargin,
        topY: topY - distTop,
        bottomY: bottomY + distBottom,
        anchorNodeIndex: nodeIndex,
        isMarginRelative: isPositionMarginRelative(imgRun.position),
      });
    }
  }
}

function extractFloatingTableZone(
  tableBlock: TableBlock,
  nodeIndex: number,
  contentWidth: number,
  measureBlock: MeasureBlockFn,
  out: FloatingZoneWithAnchor[]
): void {
  const floating = tableBlock.floating;
  if (!floating) return;

  const tableMeasure = measureTable(tableBlock, contentWidth, measureBlock);
  const tableWidth = tableMeasure.totalWidth;
  const tableHeight = tableMeasure.totalHeight;

  const distLeft = floating.leftFromText ?? 12;
  const distRight = floating.rightFromText ?? 12;
  const distTop = floating.topFromText ?? 0;
  const distBottom = floating.bottomFromText ?? 0;

  // Tables use OOXML `w:tblpXSpec` / `tblpX` instead of the image-style
  // `align` / `posOffset`, so the common helper above doesn't apply.
  let x = 0;
  if (floating.tblpX !== undefined) {
    x = floating.tblpX;
  } else if (floating.tblpXSpec) {
    if (floating.tblpXSpec === 'left' || floating.tblpXSpec === 'inside') {
      x = 0;
    } else if (floating.tblpXSpec === 'right' || floating.tblpXSpec === 'outside') {
      x = contentWidth - tableWidth;
    } else if (floating.tblpXSpec === 'center') {
      x = (contentWidth - tableWidth) / 2;
    }
  } else if (tableBlock.justification === 'center') {
    x = (contentWidth - tableWidth) / 2;
  } else if (tableBlock.justification === 'right') {
    x = contentWidth - tableWidth;
  }

  let leftMargin = 0;
  let rightMargin = 0;
  if (x < contentWidth / 2) {
    leftMargin = x + tableWidth + distRight;
  } else {
    rightMargin = contentWidth - x + distLeft;
  }

  ({ leftMargin, rightMargin } = constrainWrapMargins(leftMargin, rightMargin, contentWidth));

  const topY = floating.tblpY ?? 0;
  const bottomY = topY + tableHeight;

  out.push({
    leftMargin,
    rightMargin,
    topY: topY - distTop,
    bottomY: bottomY + distBottom,
    anchorNodeIndex: nodeIndex,
  });
}

function extractFloatingTextBoxZone(
  tbBlock: TextBoxBlock,
  nodeIndex: number,
  contentWidth: number,
  out: FloatingZoneWithAnchor[],
  pageGeometry?: FloatPageGeometry
): void {
  if (!isFloatingTextBoxBlock(tbBlock)) return;
  if (isWrapNone(tbBlock.wrapType)) return;

  const tbWidth = tbBlock.width ?? 0;
  const tbHeight = tbBlock.height ?? 0;
  if (tbWidth <= 0 || tbHeight <= 0) return;

  const distTop = tbBlock.distTop ?? 0;
  const distBottom = tbBlock.distBottom ?? 0;
  const distLeft = tbBlock.distLeft ?? 12;
  const distRight = tbBlock.distRight ?? 12;

  // NOTE: the page-pinned topAndBottom band below is currently text-box only.
  // A topAndBottom anchored *image* is still laid out as a block image on its
  // own line at its anchor (see extractImageZonesFromParagraph / paintPage),
  // so a page-anchored image band is not yet honored — follow-up.
  //
  // topAndBottom: reserve a full-width vertical band so body text flows above
  // and below the box. Page/margin-relative boxes (e.g. a banner pinned to the
  // page top) need their offset translated into content-area coordinates.
  if (tbBlock.wrapType === 'topAndBottom') {
    // Resolve the band's vertical top via the SAME resolver the painter uses,
    // so the reserved band lines up with where the box is painted regardless of
    // anchor kind (page / margin / topMargin / bottomMargin, align or posOffset).
    // fragmentY=0: a topAndBottom band is page/margin-pinned; the paragraph-Y
    // fallback only applies to genuinely paragraph-relative boxes, which this
    // pre-pagination pass anchors at their own block (cumulativeY 0 there).
    const rawTopY = resolveAnchoredObjectVerticalTop(
      { width: tbWidth, height: tbHeight, position: tbBlock.position },
      0,
      pageGeometry
    );
    // Signed top may be negative when the box reaches up into the top margin.
    // The band reserves only the part intruding into content (topY clamped at
    // 0), but its bottom is measured from the true top so the reserved height
    // matches how far the box extends below the content edge.
    const bottomY = rawTopY + tbHeight + distBottom;
    if (bottomY <= 0) return;
    out.push({
      leftMargin: 0,
      rightMargin: 0,
      topY: Math.max(0, rawTopY - distTop),
      bottomY,
      anchorNodeIndex: nodeIndex,
      isMarginRelative: isPositionMarginRelative(tbBlock.position),
      fullWidthBlock: true,
    });
    return;
  }

  let topY = 0;
  if (tbBlock.position?.vertical?.posOffset !== undefined) {
    topY = emuToPixels(tbBlock.position.vertical.posOffset);
  }
  const bottomY = topY + tbHeight;

  const { leftMargin, rightMargin } = computeAnchoredMargins(
    tbBlock.position,
    tbBlock.cssFloat,
    tbWidth,
    distLeft,
    distRight,
    contentWidth
  );

  if (leftMargin <= 0 && rightMargin <= 0) return;

  out.push({
    leftMargin,
    rightMargin,
    topY: topY - distTop,
    bottomY: bottomY + distBottom,
    anchorNodeIndex: nodeIndex,
    isMarginRelative: isPositionMarginRelative(tbBlock.position),
  });
}
