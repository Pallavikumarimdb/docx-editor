/**
 * Stable DOM-facing rendering facade.
 *
 * This module intentionally exposes only browser and document vocabulary.
 * The page-flow, measurement, and paint models behind it are implementation
 * details and may change without affecting this contract.
 *
 * @packageDocumentation
 * @public
 */

import { EditorState } from 'prosemirror-state';

import type { Document as OoxmlDocument } from './types/document';
import { schema } from './prosemirror/schema';
import { toProseDoc } from './prosemirror/conversion/toProseDoc';
import { computeLayout } from './editor/computeLayout';
import {
  getColumns,
  getMargins,
  getPageSize,
  measureBlocksWithFloats,
  paragraphLayout,
  measureTable,
  resolveHeaderFooter,
  type FloatingImageZone,
} from './flow-model';
import {
  DEFAULT_TEXTBOX_MARGINS,
  DEFAULT_TEXTBOX_WIDTH,
  assertExhaustiveContentNode,
  type ContentNode,
  type LayoutMetrics,
} from './pagination-model';
import { indexNodesById, paintPages, type RenderPageOptions } from './painter-model';
import { getCaretPositionFromDom, readSelectionGeometry } from './flow-model/resolveDomPosition';

/** A CSS-pixel rectangle within a rendered document. */
export interface RenderedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
  docFrom?: number;
  docTo?: number;
}

/** One painted page and the positioned DOM boxes it contains. */
export interface RenderedPage {
  element: HTMLElement;
  boxes: readonly RenderedBox[];
}

/** A snapshot of the pages currently painted below a DOM root. */
export interface RenderedDocument {
  root: HTMLElement;
  pages: readonly RenderedPage[];
}

/**
 * Render an OOXML document into paged DOM below `root`.
 *
 * The returned coordinates are CSS pixels relative to the root. Calling this
 * again replaces the current painted pages with a fresh rendering.
 */
export function renderDocument(document: OoxmlDocument, root: HTMLElement): RenderedDocument {
  const body = document.package.document;
  const sectionProperties =
    body.sections?.[0]?.properties ?? body.finalSectionProperties ?? undefined;
  const finalSectionProperties = body.finalSectionProperties ?? sectionProperties;
  const pageSize = getPageSize(sectionProperties);
  const margins = getMargins(sectionProperties);
  const columns = getColumns(sectionProperties);
  const finalPageSize = getPageSize(finalSectionProperties);
  const finalMargins = getMargins(finalSectionProperties);
  const finalColumns = getColumns(finalSectionProperties);
  const pageGap = 24;
  const contentWidth = pageSize.w - margins.left - margins.right;
  const state = EditorState.create({
    schema,
    doc: toProseDoc(document, { styles: document.package.styles ?? undefined }),
  });
  const { header, footer, firstHeader, firstFooter } = resolveHeaderFooter(
    document,
    sectionProperties
  );
  const result = computeLayout({
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
    theme: document.package.theme,
    styles: document.package.styles,
    sectionProperties,
    finalSectionProperties,
    headerContent: header,
    footerContent: footer,
    firstPageHeaderContent: firstHeader,
    firstPageFooterContent: firstFooter,
    measureBlocks,
    getHfPmDoc: () => null,
  });

  const nodeLookup = indexNodesById(result.nodes, result.metrics);
  paintPages(result.layout.pages, root, {
    document: root.ownerDocument,
    pageGap,
    showShadow: true,
    pageBackground: 'var(--doc-page-bg, #ffffff)',
    nodeLookup,
    headerContent: result.headerContentForRender,
    footerContent: result.footerContentForRender,
    firstPageHeaderContent: result.firstPageHeaderForRender,
    firstPageFooterContent: result.firstPageFooterForRender,
    titlePg: result.hasTitlePg,
    headerDistance: result.headerDistancePx,
    footerDistance: result.footerDistancePx,
    pageBorders: result.pageBorders,
    theme: document.package.theme,
    watermark: result.watermark,
    footnotesByPage: result.footnotesByPage,
  } as RenderPageOptions & { pageGap: number });

  return snapshotRenderedDocument(root);
}

function snapshotRenderedDocument(root: HTMLElement): RenderedDocument {
  const rootRect = root.getBoundingClientRect();
  const pages = Array.from(root.querySelectorAll<HTMLElement>('.layout-page')).map(
    (element, pageIndex): RenderedPage => {
      const boxes = Array.from(element.querySelectorAll<HTMLElement>('[data-doc-from]')).map(
        (box): RenderedBox => {
          const rect = box.getBoundingClientRect();
          const docFrom = numberData(box.dataset.docFrom);
          const docTo = numberData(box.dataset.docTo);
          return {
            x: rect.left - rootRect.left,
            y: rect.top - rootRect.top,
            width: rect.width,
            height: rect.height,
            pageIndex,
            ...(docFrom === undefined ? {} : { docFrom }),
            ...(docTo === undefined ? {} : { docTo }),
          };
        }
      );
      return { element, boxes };
    }
  );

  return { root, pages };
}

function measureBlocks(
  nodes: ContentNode[],
  contentWidth: number | number[],
  pageGeometry?: Parameters<typeof measureBlocksWithFloats>[3]
): LayoutMetrics[] {
  return measureBlocksWithFloats(nodes, contentWidth, measureBlock, pageGeometry);
}

function measureBlock(
  block: ContentNode,
  contentWidth: number,
  floatingZones?: FloatingImageZone[],
  cumulativeY?: number
): LayoutMetrics {
  switch (block.kind) {
    case 'paragraph':
      return paragraphLayout(block, contentWidth, {
        floatingZones,
        paragraphYOffset: cumulativeY ?? 0,
      });
    case 'table':
      return measureTable(block, contentWidth, measureBlock);
    case 'image':
      return { kind: 'image', width: block.width ?? 100, height: block.height ?? 100 };
    case 'textBox': {
      const margins = block.margins ?? DEFAULT_TEXTBOX_MARGINS;
      const width = block.width ?? DEFAULT_TEXTBOX_WIDTH;
      const innerWidth = width - margins.left - margins.right;
      const innerMetrics = block.content.map((paragraph) => paragraphLayout(paragraph, innerWidth));
      const contentHeight = innerMetrics.reduce((sum, measure) => sum + measure.totalHeight, 0);
      return {
        kind: 'textBox',
        width,
        height: block.height ?? contentHeight + margins.top + margins.bottom,
        innerMetrics,
      };
    }
    case 'pageBreak':
      return { kind: 'pageBreak' };
    case 'columnBreak':
      return { kind: 'columnBreak' };
    case 'sectionBreak':
      return { kind: 'sectionBreak' };
    default:
      return assertExhaustiveContentNode(block, 'api renderDocument measureBlock');
  }
}

/** Return the CSS-pixel caret box for a document position. */
export function caretAt(document: RenderedDocument, position: number): RenderedBox | null {
  const rect = getCaretPositionFromDom(
    document.root,
    position,
    document.root.getBoundingClientRect(),
    1
  );
  if (!rect) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: 0,
    height: rect.height,
    pageIndex: rect.pageIndex,
    docFrom: position,
    docTo: position,
  };
}

/** Return CSS-pixel highlight boxes for a half-open document-position range. */
export function rectsFor(
  document: RenderedDocument,
  from: number,
  to: number
): readonly RenderedBox[] {
  return readSelectionGeometry(document.root, from, to, document.root.getBoundingClientRect()).map(
    (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      pageIndex: rect.pageIndex,
      docFrom: from,
      docTo: to,
    })
  );
}

function numberData(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
