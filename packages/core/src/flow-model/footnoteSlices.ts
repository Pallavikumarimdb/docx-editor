import type {
  FootnoteBlockFragment,
  FootnoteContent,
  FootnoteFragment,
} from '../pagination-model/types';

export interface FootnoteSliceCursor {
  blockIndex: number;
  unitIndex: number;
}

function measureLineHeight(line: { lineHeight: number; floatSkipBefore?: number }): number {
  return line.lineHeight + (line.floatSkipBefore ?? 0);
}

/**
 * Take the largest whole-line/whole-row footnote slice that fits the available
 * page area. Atomic images and text boxes stay unsplit.
 */
export function takeFootnoteSlice(
  content: FootnoteContent,
  cursorIn: FootnoteSliceCursor,
  capacity: number,
  columnIndex: number,
  allowOversizedFirstUnit = false
): { fragment?: FootnoteFragment; cursor: FootnoteSliceCursor; done: boolean } {
  const cursor = { ...cursorIn };
  const blocks: FootnoteBlockFragment[] = [];
  let used = 0;

  while (cursor.blockIndex < content.blocks.length) {
    const blockIndex = cursor.blockIndex;
    const block = content.blocks[blockIndex];
    const measure = content.measures[blockIndex];
    if (!block || !measure) {
      cursor.blockIndex++;
      cursor.unitIndex = 0;
      continue;
    }

    if (block.kind === 'paragraph' && measure.kind === 'paragraph') {
      const fromLine = cursor.unitIndex;
      if (fromLine >= measure.lines.length) {
        cursor.blockIndex++;
        cursor.unitIndex = 0;
        continue;
      }

      const spacingBefore = fromLine === 0 ? (block.attrs?.spacing?.before ?? 0) : 0;
      const lineTotal = measure.lines.reduce((sum, line) => sum + measureLineHeight(line), 0);
      const spacingAfter = Math.max(
        0,
        measure.totalHeight - (block.attrs?.spacing?.before ?? 0) - lineTotal
      );

      let lineHeight = 0;
      let toLine = fromLine;
      while (toLine < measure.lines.length) {
        const nextLineHeight = measureLineHeight(measure.lines[toLine]);
        const finishesParagraph = toLine + 1 === measure.lines.length;
        const candidate =
          used +
          spacingBefore +
          lineHeight +
          nextLineHeight +
          (finishesParagraph ? spacingAfter : 0);
        if (candidate > capacity && (used > 0 || lineHeight > 0 || !allowOversizedFirstUnit)) {
          break;
        }
        lineHeight += nextLineHeight;
        toLine++;
        if (candidate > capacity) break;
      }

      if (toLine === fromLine) break;
      blocks.push({
        kind: 'paragraph',
        blockIndex,
        y: used + spacingBefore,
        height: lineHeight,
        fromLine,
        toLine,
      });
      const finished = toLine === measure.lines.length;
      used += spacingBefore + lineHeight + (finished ? spacingAfter : 0);
      if (!finished) {
        cursor.unitIndex = toLine;
        break;
      }
      cursor.blockIndex++;
      cursor.unitIndex = 0;
      continue;
    }

    if (block.kind === 'table' && measure.kind === 'table') {
      const fromRow = cursor.unitIndex;
      if (fromRow >= measure.rows.length) {
        cursor.blockIndex++;
        cursor.unitIndex = 0;
        continue;
      }
      const rowsHeight = measure.rows.reduce((sum, row) => sum + row.height, 0);
      const trailing = Math.max(0, measure.totalHeight - rowsHeight);
      let height = 0;
      let toRow = fromRow;
      while (toRow < measure.rows.length) {
        const rowHeight = measure.rows[toRow].height;
        const finishesTable = toRow + 1 === measure.rows.length;
        const candidate = used + height + rowHeight + (finishesTable ? trailing : 0);
        if (candidate > capacity && (used > 0 || height > 0 || !allowOversizedFirstUnit)) {
          break;
        }
        height += rowHeight;
        toRow++;
        if (candidate > capacity) break;
      }
      if (toRow === fromRow) break;
      blocks.push({ kind: 'table', blockIndex, y: used, height, fromRow, toRow });
      const finished = toRow === measure.rows.length;
      used += height + (finished ? trailing : 0);
      if (!finished) {
        cursor.unitIndex = toRow;
        break;
      }
      cursor.blockIndex++;
      cursor.unitIndex = 0;
      continue;
    }

    if (
      (block.kind === 'image' && measure.kind === 'image') ||
      (block.kind === 'textBox' && measure.kind === 'textBox')
    ) {
      if (used + measure.height > capacity && (used > 0 || !allowOversizedFirstUnit)) {
        break;
      }
      blocks.push({
        kind: block.kind,
        blockIndex,
        y: used,
        height: measure.height,
      });
      used += measure.height;
      cursor.blockIndex++;
      cursor.unitIndex = 0;
      if (used > capacity) break;
      continue;
    }

    // Break/section blocks occupy no footnote height.
    cursor.blockIndex++;
    cursor.unitIndex = 0;
  }

  const done = cursor.blockIndex >= content.blocks.length;
  if (blocks.length === 0) return { cursor, done };
  return {
    fragment: {
      footnoteId: content.id,
      displayNumber: content.displayNumber,
      blocks,
      height: used,
      ...(columnIndex > 0 ? { columnIndex } : {}),
    },
    cursor,
    done,
  };
}
