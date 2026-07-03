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
  collectSectionConfigs,
  isFloatingTextBoxBlock,
  isWrapNone,
  type ContentNode,
  type ImageRun,
  type ImageRunPosition,
  type Measure,
  type MeasuredLine,
  type ParagraphBlock,
  type ParagraphMetrics,
  type Run,
  type TableBlock,
  type TextBoxBlock,
} from '../../pagination-model';
import { isTextWrappingFloatingImageRun } from '../../painter-model/floatingImageFlow';
import {
  pageGeometryFromPage,
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
  initialGeometry: FloatPageGeometry | undefined;
  geometryAfterBreak: Map<number, FloatPageGeometry | undefined>;
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
 * `finalPageGeometry` is the trailing section's geometry. Together with
 * `pageGeometry`, it lets measurement build the exact same section schedule as
 * page composition. In particular, a continuous section's geometry remains
 * pending until flow advances to a new physical page.
 *
 * @public
 */
export function measureBlocksWithFloats(
  nodes: ContentNode[],
  contentWidth: number | number[],
  measureBlock: MeasureBlockFn,
  pageGeometry?: FloatPageGeometry,
  finalPageGeometry?: FloatPageGeometry
): Measure[] {
  const defaultWidth = Array.isArray(contentWidth) ? (contentWidth[0] ?? 0) : contentWidth;
  const blockWidthAt = (blockIndex: number): number =>
    Array.isArray(contentWidth) ? (contentWidth[blockIndex] ?? defaultWidth) : contentWidth;
  const scopes = buildFloatFlowScopes(
    blocks,
    blockWidthAt,
    measureBlock,
    pageGeometry,
    finalPageGeometry
  );
  let cumulativeY = 0;
  let activeZones: FloatingImageZone[] = [];
  let startsNewScope = blocks.length > 0;
  let startsNewPhysicalPage = blocks.length > 0;
  let currentPageGeometry = scopes.initialGeometry;
  let nextPageGeometry = scopes.initialGeometry;
  const measures: Measure[] = [];

  const activateAnchoredZones = (
    block: FlowBlock,
    blockIndex: number,
    blockWidth: number
  ): void => {
    const anchoredZones: FloatingZoneWithAnchor[] = [];
    extractFloatingZonesFromBlock(
      block,
      blockIndex,
      blockWidth,
      measureBlock,
      currentPageGeometry,
      anchoredZones
    );
    for (const anchored of anchoredZones) {
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

  const resetFlowScope = (): void => {
    cumulativeY = 0;
    activeZones = [];
  };

  const beginPhysicalScope = (): void => {
    resetFlowScope();
    currentPageGeometry = nextPageGeometry;
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (startsNewScope) {
      if (startsNewPhysicalPage) {
        beginPhysicalScope();
      } else {
        resetFlowScope();
      }
      startsNewScope = false;
      startsNewPhysicalPage = false;
    }

    const blockWidth = blockWidthAt(blockIndex);
    activateAnchoredZones(block, blockIndex, blockWidth);
    activeZones = activeZones.filter((zone) => zone.bottomY > cumulativeY);
    let zones = activeZones.length > 0 ? activeZones : undefined;
    let measure =
      zones == null
        ? scopes.baseMeasures[blockIndex]
        : measureBlock(block, blockWidth, zones, cumulativeY);
    let height = measureFlowHeight(block, measure);
    let contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;

    // A splittable paragraph can begin beside a float and continue on the next
    // physical page, where that float no longer exists. Keep the wrapped lines
    // that fit this scope, then append a fresh unwrapped continuation. Feeding
    // the whole wrapped measure to pagination would make its continuation reuse
    // stale line breaks even after activeZones is cleared for the next page.
    if (
      block.kind === 'paragraph' &&
      measure.kind === 'paragraph' &&
      zones != null &&
      block.attrs?.keepLines !== true &&
      Number.isFinite(contentHeight) &&
      cumulativeY + height > contentHeight
    ) {
      const availableForLines = Math.max(
        0,
        contentHeight - cumulativeY - (block.attrs?.spacing?.before ?? 0)
      );
      const prefixLineCount = countParagraphLinesThatFit(measure.lines, availableForLines);
      if (prefixLineCount > 0 && prefixLineCount < measure.lines.length) {
        measure = mergeParagraphContinuation(
          block,
          measure,
          scopes.baseMeasures[blockIndex] as ParagraphMetrics,
          prefixLineCount,
          blockWidth,
          measureBlock
        );
        height = measureFlowHeight(block, measure);
      }
    }

    // A zone can increase an atomic/keep-lines block enough to move that whole
    // block onto the next page. Re-evaluate only those blocks at the new scope
    // origin. Splittable paragraphs keep their current-page lines in the zone
    // and continue without it after pagination cuts the measured line set.
    const remainingInScope = contentHeight - cumulativeY;
    const firstParagraphLineHeight =
      block.kind === 'paragraph' && measure.kind === 'paragraph'
        ? (block.attrs?.spacing?.before ?? 0) +
          (measure.lines[0]?.lineHeight ?? 0) +
          (measure.lines[0]?.floatSkipBefore ?? 0)
        : 0;
    const movesWholeToNextScope =
      block.kind === 'image' ||
      block.kind === 'textBox' ||
      (block.kind === 'paragraph' &&
        (block.attrs?.keepLines === true || firstParagraphLineHeight > remainingInScope));
    if (
      movesWholeToNextScope &&
      height > 0 &&
      cumulativeY > 0 &&
      Number.isFinite(contentHeight) &&
      cumulativeY + height > contentHeight
    ) {
      beginPhysicalScope();
      contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;
      activateAnchoredZones(block, blockIndex, blockWidth);
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

    if (block.kind === 'sectionBreak') {
      nextPageGeometry = scopes.geometryAfterBreak.get(blockIndex);
    }

    const pageOverflowed = Number.isFinite(contentHeight) && cumulativeY >= contentHeight;
    const sectionStartsNewScope = block.kind === 'sectionBreak' && block.type !== 'continuous';
    if (
      block.kind === 'pageBreak' ||
      block.kind === 'columnBreak' ||
      sectionStartsNewScope ||
      pageOverflowed
    ) {
      startsNewScope = true;
      startsNewPhysicalPage =
        block.kind === 'pageBreak' ||
        pageOverflowed ||
        (block.kind === 'sectionBreak' &&
          block.type !== 'continuous' &&
          block.type !== 'nextColumn');
    }
  }

  return measures;
}

function lineFlowHeight(line: MeasuredLine): number {
  return line.lineHeight + (line.floatSkipBefore ?? 0);
}

function countParagraphLinesThatFit(lines: MeasuredLine[], available: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const height = lineFlowHeight(line);
    if (used + height > available) break;
    used += height;
    count++;
  }
  return count;
}

interface RunPosition {
  run: number;
  char: number;
}

function compareRunPositions(a: RunPosition, b: RunPosition): number {
  return a.run === b.run ? a.char - b.char : a.run - b.run;
}

function mergeParagraphContinuation(
  block: ParagraphBlock,
  wrapped: ParagraphMetrics,
  unwrapped: ParagraphMetrics,
  prefixLineCount: number,
  contentWidth: number,
  measureBlock: MeasureBlockFn
): ParagraphMetrics {
  const prefix = wrapped.lines.slice(0, prefixLineCount);
  const lastPrefixLine = prefix[prefix.length - 1];
  const boundary = { run: lastPrefixLine.toRun, char: lastPrefixLine.toChar };
  const exactUnwrappedStart = unwrapped.lines.findIndex(
    (line) => compareRunPositions({ run: line.fromRun, char: line.fromChar }, boundary) === 0
  );
  const continuation =
    exactUnwrappedStart >= 0
      ? unwrapped.lines.slice(exactUnwrappedStart)
      : measureParagraphRemainder(block, boundary, contentWidth, measureBlock);
  const lines = [...prefix, ...continuation];
  const spacing = block.attrs?.spacing;

  return {
    kind: 'paragraph',
    lines,
    totalHeight:
      lines.reduce((sum, line) => sum + lineFlowHeight(line), 0) +
      (spacing?.before ?? 0) +
      (spacing?.after ?? 0),
  };
}

function runLength(run: Run): number {
  return run.kind === 'text' ? run.text.length : 1;
}

function measureParagraphRemainder(
  block: ParagraphBlock,
  from: RunPosition,
  contentWidth: number,
  measureBlock: MeasureBlockFn
): MeasuredLine[] {
  let runOffset = from.run;
  let charOffset = from.char;
  while (runOffset < block.runs.length && charOffset >= runLength(block.runs[runOffset])) {
    runOffset++;
    charOffset = 0;
  }
  if (runOffset >= block.runs.length) return [];

  const runs = block.runs.slice(runOffset);
  if (charOffset > 0 && runs[0]?.kind === 'text') {
    runs[0] = { ...runs[0], text: runs[0].text.slice(charOffset) };
  }

  const attrs = block.attrs
    ? {
        ...block.attrs,
        spacing: undefined,
        indent: block.attrs.indent
          ? { left: block.attrs.indent.left, right: block.attrs.indent.right }
          : undefined,
        listMarker: undefined,
        listIsBullet: undefined,
        listMarkerHidden: undefined,
        listMarkerFontFamily: undefined,
        listMarkerFontSize: undefined,
        listMarkerSuffix: undefined,
        listMarkerRevision: undefined,
        pageBreakBefore: undefined,
      }
    : undefined;
  const remainder = measureBlock({ ...block, runs, attrs }, contentWidth);
  if (remainder.kind !== 'paragraph') return [];

  return remainder.lines.map((line) => remapContinuationLine(line, runOffset, charOffset));
}

function remapContinuationLine(
  line: MeasuredLine,
  runOffset: number,
  charOffset: number
): MeasuredLine {
  const remapPosition = (run: number, char: number): RunPosition => ({
    run: run + runOffset,
    char: char + (run === 0 ? charOffset : 0),
  });
  const from = remapPosition(line.fromRun, line.fromChar);
  const to = remapPosition(line.toRun, line.toChar);
  const segments = line.segments?.map((segment) => {
    const segmentFrom = remapPosition(segment.fromRun, segment.fromChar);
    const segmentTo = remapPosition(segment.toRun, segment.toChar);
    return {
      ...segment,
      fromRun: segmentFrom.run,
      fromChar: segmentFrom.char,
      toRun: segmentTo.run,
      toChar: segmentTo.char,
    };
  });
  const atomAdvances = line.atomAdvances
    ? Object.fromEntries(
        Object.entries(line.atomAdvances).map(([run, advance]) => [
          Number(run) + runOffset,
          advance,
        ])
      )
    : undefined;

  return {
    ...line,
    fromRun: from.run,
    fromChar: from.char,
    toRun: to.run,
    toChar: to.char,
    ...(segments ? { segments } : {}),
    ...(atomAdvances ? { atomAdvances } : {}),
  };
}

function buildFloatFlowScopes(
  blocks: FlowBlock[],
  blockWidthAt: (blockIndex: number) => number,
  measureBlock: MeasureBlockFn,
  initialGeometry?: FloatPageGeometry,
  finalGeometry?: FloatPageGeometry
): FloatFlowScopes {
  const baseMeasures: Measure[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const measure = measureBlock(block, blockWidthAt(blockIndex));
    baseMeasures.push(measure);
  }

  if (!initialGeometry) {
    return { initialGeometry: undefined, geometryAfterBreak: new Map(), baseMeasures };
  }

  const sectionPlan = collectSectionConfigs(
    blocks,
    sectionConfigFromGeometry(initialGeometry),
    sectionConfigFromGeometry(finalGeometry ?? initialGeometry)
  );
  const sectionGeometries = sectionPlan.configs.map((config) =>
    pageGeometryFromPage({ size: config.pageSize, margins: config.margins })
  );
  const geometryAfterBreak = new Map<number, FloatPageGeometry | undefined>();
  for (let sectionIndex = 0; sectionIndex < sectionPlan.breakIndices.length; sectionIndex++) {
    geometryAfterBreak.set(
      sectionPlan.breakIndices[sectionIndex],
      sectionGeometries[sectionIndex + 1] ?? sectionGeometries[sectionIndex]
    );
  }

  return {
    initialGeometry: sectionGeometries[0] ?? initialGeometry,
    geometryAfterBreak,
    baseMeasures,
  };
}

function measureFlowHeight(block: FlowBlock, measure: Measure): number {
  if (block.kind === 'table' && (block as TableBlock).floating) return 0;
  if (block.kind === 'textBox' && isFloatingTextBoxBlock(block as TextBoxBlock)) return 0;
  if ('totalHeight' in measure) return measure.totalHeight;
  if ('height' in measure) return measure.height;
  return 0;
}

function sectionConfigFromGeometry(geometry: FloatPageGeometry) {
  return {
    pageSize: { w: geometry.pageWidth, h: geometry.pageHeight },
    margins: {
      top: geometry.marginTop,
      right: geometry.marginRight,
      bottom: geometry.marginBottom,
      left: geometry.marginLeft,
    },
  };
}

/**
 * Extract floating exclusion zones from one anchor block using the physical
 * page geometry currently receiving that block.
 */
function extractFloatingZonesFromBlock(
  block: FlowBlock,
  blockIndex: number,
  contentWidth: number,
  measureBlock: MeasureBlockFn,
  pageGeometry: FloatPageGeometry | undefined,
  zones: FloatingZoneWithAnchor[]
): void {
  switch (block.kind) {
    case 'paragraph':
      extractImageZonesFromParagraph(
        block as ParagraphBlock,
        blockIndex,
        contentWidth,
        zones,
        pageGeometry
      );
      break;
    case 'table':
      extractFloatingTableZone(block as TableBlock, blockIndex, contentWidth, measureBlock, zones);
      break;
    case 'textBox':
      extractFloatingTextBoxZone(
        block as TextBoxBlock,
        blockIndex,
        contentWidth,
        zones,
        pageGeometry
      );
      break;
  }
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
  out: FloatingZoneWithAnchor[],
  pageGeometry?: FloatPageGeometry
): void {
  for (const run of paragraphBlock.runs) {
    if (run.kind !== 'image') continue;
    const imgRun = run as ImageRun;

    const distTop = imgRun.distTop ?? 0;
    const distBottom = imgRun.distBottom ?? 0;
    const distLeft = imgRun.distLeft ?? 12;
    const distRight = imgRun.distRight ?? 12;

    if (imgRun.wrapType === 'topAndBottom') {
      const rawTopY = resolveAnchoredObjectVerticalTop(imgRun, 0, pageGeometry);
      const bottomY = rawTopY + imgRun.height + distBottom;
      if (bottomY <= 0) continue;
      out.push({
        leftMargin: 0,
        rightMargin: 0,
        topY: rawTopY - distTop,
        bottomY,
        anchorBlockIndex: blockIndex,
        isMarginRelative: isPositionMarginRelative(imgRun.position),
        fullWidthBlock: true,
      });
      continue;
    }

    if (!isTextWrappingFloatingImageRun(imgRun)) continue;

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
