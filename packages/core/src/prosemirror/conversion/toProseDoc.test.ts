/**
 * Integration tests for toProseDoc — theme color resolution in tables.
 *
 * Verifies that themed cell shading (w:shd with w:themeFill + w:themeFillTint/Shade)
 * is correctly resolved to RGB values on ProseMirror tableCell node attrs.
 */

import { describe, test, expect } from 'bun:test';
import { toProseDoc } from './toProseDoc';
import type { Document, Table, TableRow, TableCell, Theme } from '../../types/document';

const OFFICE_THEME: Theme = {
  colorScheme: {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '44546A',
    lt2: 'E7E6E6',
    accent1: '4472C4',
    accent2: 'ED7D31',
    accent3: 'A5A5A5',
    accent4: 'FFC000',
    accent5: '5B9BD5',
    accent6: '70AD47',
    hlink: '0563C1',
    folHlink: '954F72',
  },
};

function makeCell(shading?: TableCell['formatting'] extends infer F ? F : never): TableCell {
  return {
    type: 'tableCell',
    formatting: shading as TableCell['formatting'],
    content: [
      {
        type: 'paragraph',
        content: [],
      },
    ],
  };
}

function makeTable(cells: TableCell[]): Table {
  const row: TableRow = { type: 'tableRow', cells };
  return { type: 'table', rows: [row] };
}

function makeDocument(table: Table, theme?: Theme): Document {
  return {
    package: {
      document: { content: [table] },
      theme,
    },
  };
}

// Collect all tableCell PM nodes in document order.
function collectCellAttrs(pmDoc: ReturnType<typeof toProseDoc>): Array<Record<string, unknown>> {
  const cells: Array<Record<string, unknown>> = [];
  pmDoc.descendants((node) => {
    if (node.type.name === 'tableCell') {
      cells.push(node.attrs as Record<string, unknown>);
    }
  });
  return cells;
}

describe('toProseDoc — table cell theme color resolution', () => {
  test('cell with RGB fill sets backgroundColor directly', () => {
    const cell = makeCell({ shading: { fill: { rgb: 'FF0000' } } });
    const doc = makeDocument(makeTable([cell]), OFFICE_THEME);
    const pmDoc = toProseDoc(doc);
    const cells = collectCellAttrs(pmDoc);
    expect(cells[0].backgroundColor).toBe('FF0000');
  });

  test('cell with theme fill resolves to base theme color', () => {
    // w:themeFill="accent1" with no tint/shade → base color
    const cell = makeCell({ shading: { fill: { themeColor: 'accent1' } } });
    const doc = makeDocument(makeTable([cell]), OFFICE_THEME);
    const pmDoc = toProseDoc(doc);
    const cells = collectCellAttrs(pmDoc);
    expect(cells[0].backgroundColor).toBe('4472C4');
  });

  test('cell with theme fill + tint resolves to lightened RGB', () => {
    // accent1 (#4472C4) with themeFillTint="33" → near-white blue
    // OOXML: t = 0x33/255 ≈ 0.2 → keep 20% color, 80% white
    const cell = makeCell({
      shading: { fill: { themeColor: 'accent1', themeTint: '33' } },
    });
    const doc = makeDocument(makeTable([cell]), OFFICE_THEME);
    const pmDoc = toProseDoc(doc);
    const cells = collectCellAttrs(pmDoc);
    expect(cells[0].backgroundColor).toBe('DAE3F3');
  });

  test('cell with theme fill + shade resolves to darkened RGB', () => {
    // background1 (lt1 = FFFFFF) with themeFillShade="F2" → light gray
    // OOXML: s = 0xF2/255 ≈ 0.949 → keep 95% of color
    const cell = makeCell({
      shading: { fill: { themeColor: 'background1', themeShade: 'F2' } },
    });
    const doc = makeDocument(makeTable([cell]), OFFICE_THEME);
    const pmDoc = toProseDoc(doc);
    const cells = collectCellAttrs(pmDoc);
    expect(cells[0].backgroundColor).toBe('F2F2F2');
  });

  test('cell with themed fill and no document theme leaves backgroundColor undefined', () => {
    // Without a theme, theme color references can't be resolved.
    // The rgb fallback is already overwritten by the parser when themeFill is present.
    const cell = makeCell({
      shading: { fill: { themeColor: 'accent1', themeTint: '33' } },
    });
    const doc = makeDocument(makeTable([cell]), undefined);
    const pmDoc = toProseDoc(doc);
    const cells = collectCellAttrs(pmDoc);
    expect(cells[0].backgroundColor).toBeFalsy();
  });

  test('multiple cells with different theme tints resolve independently', () => {
    // Mimics the real-world scenario: title row with dark tint, section row with light tint.
    const titleCell = makeCell({
      shading: { fill: { themeColor: 'accent1', themeTint: '99' } },
    });
    const sectionCell = makeCell({
      shading: { fill: { themeColor: 'accent1', themeTint: '33' } },
    });
    const doc = makeDocument(makeTable([titleCell, sectionCell]), OFFICE_THEME);
    const pmDoc = toProseDoc(doc);
    const cells = collectCellAttrs(pmDoc);
    // tint=99 (0.6) → medium blue
    expect(cells[0].backgroundColor).toBe('8FAADC');
    // tint=33 (0.2) → near-white
    expect(cells[1].backgroundColor).toBe('DAE3F3');
  });
});
