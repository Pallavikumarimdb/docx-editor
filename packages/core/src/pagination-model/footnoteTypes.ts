/**
 * A block slice inside one page's footnote area.
 *
 * The source block index points into the owning FootnoteContent.
 *
 * @public
 */
export type FootnoteBlockFragment =
  | {
      kind: 'paragraph';
      blockIndex: number;
      y: number;
      height: number;
      fromLine: number;
      toLine: number;
    }
  | {
      kind: 'table';
      blockIndex: number;
      y: number;
      height: number;
      fromRow: number;
      toRow: number;
      topClip?: number;
      bottomClip?: number;
    }
  | {
      kind: 'image' | 'textBox';
      blockIndex: number;
      y: number;
      height: number;
    };

/**
 * The part of one footnote body painted on one page.
 *
 * @public
 */
export interface FootnoteFragment {
  footnoteId: number;
  displayNumber: number;
  blocks: FootnoteBlockFragment[];
  height: number;
  /** The page starts with content carried from an earlier page. */
  continuesFromPrev?: boolean;
  /** More of this footnote is carried to the next page. */
  continuesOnNext?: boolean;
  /** Footnote-column index, when the page uses `w15:footnoteColumns`. */
  columnIndex?: number;
}
