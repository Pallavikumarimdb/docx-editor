import { describe, expect, test } from 'bun:test';
import type {
  FlowBlock,
  ImageRun,
  Measure,
  ParagraphBlock,
  TextBoxBlock,
} from '../../pagination-model/types';
import type { FloatingImageZone } from '../metrics/floatingZones';
import {
  measureBlocksWithFloats,
  type FloatPageGeometry,
  type MeasureBlockFn,
} from '../metrics/measureBlocksPipeline';

const initialGeometry: FloatPageGeometry = {
  pageWidth: 400,
  pageHeight: 120,
  marginLeft: 50,
  marginTop: 10,
  contentWidth: 300,
  contentHeight: 100,
};

function paragraph(id: string, runs: ParagraphBlock['runs'] = []): ParagraphBlock {
  return { kind: 'paragraph', id, runs };
}

function floatingImage(posOffsetPx: number): ImageRun {
  return {
    kind: 'image',
    src: 'embedded.png',
    width: 40,
    height: 25,
    displayMode: 'float',
    wrapType: 'square',
    position: {
      horizontal: { relativeTo: 'margin', posOffset: posOffsetPx * 9_525 },
      vertical: { relativeTo: 'margin', posOffset: 70 * 9_525 },
    },
  };
}

interface FinalCall {
  width: number;
  zones?: FloatingImageZone[];
  cumulativeY?: number;
}

function recordingMeasure(
  heights: Record<string, number>,
  finalCalls: Map<string, FinalCall>
): MeasureBlockFn {
  const calls = new Map<string, number>();
  return (block, width, zones, cumulativeY): Measure => {
    const id = String(block.id);
    const call = (calls.get(id) ?? 0) + 1;
    calls.set(id, call);
    if (call === 2) finalCalls.set(id, { width, zones, cumulativeY });

    switch (block.kind) {
      case 'paragraph': {
        const height = (zones ? heights[`${id}:wrapped`] : undefined) ?? heights[id] ?? 20;
        return {
          kind: 'paragraph',
          lines: [
            {
              fromRun: 0,
              fromChar: 0,
              toRun: 0,
              toChar: 0,
              width: 0,
              ascent: height * 0.75,
              descent: height * 0.25,
              lineHeight: height,
            },
          ],
          totalHeight: height,
        };
      }
      case 'textBox':
        return {
          kind: 'textBox',
          width: block.width,
          height: block.height ?? 20,
          innerMeasures: [],
        };
      case 'sectionBreak':
        return { kind: 'sectionBreak' };
      case 'pageBreak':
        return { kind: 'pageBreak' };
      case 'columnBreak':
        return { kind: 'columnBreak' };
      case 'image':
        return { kind: 'image', width: block.width, height: block.height };
      case 'table':
        return {
          kind: 'table',
          rows: [],
          columnWidths: [],
          totalWidth: width,
          totalHeight: heights[id] ?? 20,
        };
    }
  };
}

describe('floating exclusion flow scopes', () => {
  test('does not remeasure blocks when no float zone applies', () => {
    const blocks = [paragraph('one'), paragraph('two'), paragraph('three')];
    let calls = 0;
    const measure = recordingMeasure({}, new Map());
    const measured = measureBlocksWithFloats(
      blocks,
      300,
      (...args) => {
        calls++;
        return measure(...args);
      },
      initialGeometry
    );

    expect(measured).toHaveLength(3);
    expect(calls).toBe(3);
  });

  test('a bottom-page float cannot affect the following page', () => {
    const blocks: FlowBlock[] = [
      paragraph('anchor', [floatingImage(0)]),
      paragraph('page-one-tail'),
      paragraph('page-two'),
    ];
    const finalCalls = new Map<string, FinalCall>();

    const measures = measureBlocksWithFloats(
      blocks,
      300,
      recordingMeasure(
        { anchor: 20, 'page-one-tail': 70, 'page-two': 20, 'page-two:wrapped': 50 },
        finalCalls
      ),
      initialGeometry
    );

    expect(finalCalls.get('anchor')?.zones).toHaveLength(1);
    expect(finalCalls.get('page-one-tail')?.zones).toHaveLength(1);
    expect(measures[2]).toMatchObject({ kind: 'paragraph', totalHeight: 20 });
  });

  test('keeps float wrapping on the current-page part of a split paragraph', () => {
    const blocks: FlowBlock[] = [
      paragraph('anchor', [floatingImage(0)]),
      paragraph('split-paragraph'),
      paragraph('following-page'),
    ];

    const measureBlock: MeasureBlockFn = (block, _width, zones) => {
      const id = String(block.id);
      const lineHeights =
        id === 'anchor'
          ? [20]
          : id === 'split-paragraph'
            ? zones
              ? [60, 60]
              : [40, 40]
            : zones
              ? [50]
              : [20];
      return {
        kind: 'paragraph',
        lines: lineHeights.map((lineHeight) => ({
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 0,
          width: 0,
          ascent: lineHeight * 0.75,
          descent: lineHeight * 0.25,
          lineHeight,
        })),
        totalHeight: lineHeights.reduce((sum, lineHeight) => sum + lineHeight, 0),
      };
    };

    const measures = measureBlocksWithFloats(blocks, 300, measureBlock, initialGeometry);

    expect(measures[1]).toMatchObject({ kind: 'paragraph', totalHeight: 120 });
    expect(measures[2]).toMatchObject({ kind: 'paragraph', totalHeight: 20 });
  });

  test('a later-section margin band starts at its anchor with later geometry', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'later-band',
      width: 800,
      height: 40,
      content: [],
      displayMode: 'float',
      wrapType: 'topAndBottom',
      distBottom: 10,
      position: {
        vertical: { relativeTo: 'margin', align: 'top' },
        horizontal: { relativeTo: 'margin', align: 'left' },
      },
    };
    const blocks: FlowBlock[] = [
      paragraph('earlier'),
      {
        kind: 'sectionBreak',
        id: 'section',
        pageSize: { w: 1_000, h: 220 },
        margins: { top: 20, right: 100, bottom: 20, left: 100 },
      },
      textBox,
      paragraph('later-text'),
    ];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      blocks,
      [300, 300, 800, 800],
      recordingMeasure({}, finalCalls),
      initialGeometry
    );

    expect(finalCalls.get('earlier')?.zones).toBeUndefined();
    expect(finalCalls.get('section')?.zones).toBeUndefined();
    expect(finalCalls.get('later-band')?.width).toBe(800);
    expect(finalCalls.get('later-band')?.zones?.[0]).toMatchObject({
      fullWidthBlock: true,
      topY: 0,
      bottomY: 50,
    });
    expect(finalCalls.get('later-text')?.zones?.[0].fullWidthBlock).toBe(true);
  });

  test('mixed-width sections resolve each float against its own width', () => {
    const blocks: FlowBlock[] = [
      paragraph('narrow-float', [floatingImage(220)]),
      {
        kind: 'sectionBreak',
        id: 'section',
        pageSize: { w: 700, h: 120 },
        margins: { top: 10, right: 50, bottom: 10, left: 50 },
      },
      paragraph('wide-float', [floatingImage(220)]),
    ];
    const finalCalls = new Map<string, FinalCall>();

    measureBlocksWithFloats(
      blocks,
      [300, 300, 600],
      recordingMeasure({}, finalCalls),
      initialGeometry
    );

    expect(finalCalls.get('narrow-float')?.zones?.[0]).toMatchObject({
      leftMargin: 0,
      rightMargin: 92,
    });
    expect(finalCalls.get('wide-float')?.zones?.[0]).toMatchObject({
      leftMargin: 272,
      rightMargin: 0,
    });
  });
});
