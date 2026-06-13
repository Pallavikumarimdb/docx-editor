/**
 * Pure ref-API query helpers (findInDocument / getSelectionInfo /
 * getPageContent). The functions only read `view.state` and the layout, so
 * tests pass a minimal `{ state }` stand-in for the EditorView and a
 * hand-built layout rather than mounting a real view.
 */

import { describe, expect, test } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Layout } from '../../layout-engine';

import { singletonManager } from '../schema';
import {
  findInDocument,
  getSelectionInfo,
  getPageContent,
  findCommentRange,
  findChangeRange,
} from '../queries';

const schema = singletonManager.getSchema();

function para(paraId: string, text: string, styleId?: string) {
  return schema.nodes.paragraph.create(
    { paraId, ...(styleId ? { styleId } : {}) },
    schema.text(text)
  );
}

function stateWithDoc() {
  const doc = schema.nodes.doc.create(null, [
    para('AAA', 'the quick brown fox'),
    para('BBB', 'jumps over the lazy dog', 'Heading1'),
    para('CCC', 'echo echo echo'),
  ]);
  return EditorState.create({ schema, doc });
}

function asView(state: EditorState): EditorView {
  return { state } as unknown as EditorView;
}

describe('findInDocument', () => {
  test('finds a unique match with before/after context', () => {
    const view = asView(stateWithDoc());
    const out = findInDocument(view, 'brown');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      paraId: 'AAA',
      match: 'brown',
      before: 'the quick ',
      after: ' fox',
    });
  });

  test('case-insensitive by default, case-sensitive when asked', () => {
    const view = asView(stateWithDoc());
    expect(findInDocument(view, 'QUICK')).toHaveLength(1);
    expect(findInDocument(view, 'QUICK', { caseSensitive: true })).toHaveLength(0);
  });

  test('skips paragraphs where the query is ambiguous', () => {
    const view = asView(stateWithDoc());
    // 'echo' appears 3x in CCC → rejected.
    expect(findInDocument(view, 'echo')).toHaveLength(0);
  });

  test('honors limit', () => {
    const view = asView(stateWithDoc());
    // 'the' is unique within AAA and BBB → 2 matches, limit 1 truncates.
    expect(findInDocument(view, 'the', { limit: 1 })).toHaveLength(1);
  });

  test('empty query and null view return []', () => {
    expect(findInDocument(asView(stateWithDoc()), '')).toEqual([]);
    expect(findInDocument(null, 'x')).toEqual([]);
  });
});

describe('getSelectionInfo', () => {
  test('reports paraId, selected text, and surrounding slices', () => {
    const base = stateWithDoc();
    // Find 'quick' position by walking text.
    let selFrom = 0;
    base.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('quick')) {
        selFrom = pos + node.text.indexOf('quick');
      }
    });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, selFrom, selFrom + 'quick'.length))
    );
    const info = getSelectionInfo(asView(state));
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      paraId: 'AAA',
      selectedText: 'quick',
      before: 'the ',
      after: ' brown fox',
      paragraphText: 'the quick brown fox',
    });
  });

  test('null view returns null', () => {
    expect(getSelectionInfo(null)).toBeNull();
  });
});

describe('findCommentRange', () => {
  function stateWithComment(commentId: number) {
    const mark = schema.marks.comment.create({ commentId });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ paraId: 'AAA' }, [
        schema.text('plain '),
        schema.text('marked text', [mark]),
        schema.text(' tail'),
      ]),
    ]);
    return EditorState.create({ schema, doc });
  }

  test('resolves a present comment id to its marked range', () => {
    const view = asView(stateWithComment(7));
    const range = findCommentRange(view, 7);
    expect(range).not.toBeNull();
    // 'plain ' is 6 chars; paragraph open tag adds 1 → range starts at 7.
    expect(view.state.doc.textBetween(range!.from, range!.to)).toBe('marked text');
  });

  test('returns null for an absent comment id', () => {
    const view = asView(stateWithComment(7));
    expect(findCommentRange(view, 9999)).toBeNull();
  });

  test('null view returns null', () => {
    expect(findCommentRange(null, 7)).toBeNull();
  });
});

describe('findChangeRange', () => {
  function stateWithInsertion(revisionId: number) {
    const ins = schema.marks.insertion.create({ revisionId, author: 'A', date: null });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ paraId: 'AAA' }, [
        schema.text('kept '),
        schema.text('inserted', [ins]),
      ]),
    ]);
    return EditorState.create({ schema, doc });
  }

  test('resolves a present revision id to its change range', () => {
    const view = asView(stateWithInsertion(42));
    const range = findChangeRange(view, 42);
    expect(range).not.toBeNull();
    expect(view.state.doc.textBetween(range!.from, range!.to)).toBe('inserted');
  });

  test('returns null for an absent revision id', () => {
    const view = asView(stateWithInsertion(42));
    expect(findChangeRange(view, 9999)).toBeNull();
  });

  test('null view returns null', () => {
    expect(findChangeRange(null, 42)).toBeNull();
  });
});

describe('getPageContent', () => {
  function layoutFor(state: EditorState): Layout {
    // Minimal layout: one page whose fragments point at the three paragraphs.
    const fragments: Array<{ kind: string; docFrom: number }> = [];
    state.doc.forEach((_node, offset) => {
      fragments.push({ kind: 'paragraph', docFrom: offset });
    });
    return { pages: [{ fragments }] } as unknown as Layout;
  }

  test('collects page paragraphs deduped by paraId with style', () => {
    const state = stateWithDoc();
    const out = getPageContent(asView(state), layoutFor(state), 1);
    expect(out).not.toBeNull();
    expect(out!.paragraphs).toHaveLength(3);
    expect(out!.paragraphs[1]).toMatchObject({ paraId: 'BBB', styleId: 'Heading1' });
    expect(out!.text).toContain('[AAA] the quick brown fox');
  });

  test('out-of-range page returns null', () => {
    const state = stateWithDoc();
    expect(getPageContent(asView(state), layoutFor(state), 99)).toBeNull();
  });

  test('null view or layout returns null', () => {
    const state = stateWithDoc();
    expect(getPageContent(null, layoutFor(state), 1)).toBeNull();
    expect(getPageContent(asView(state), null, 1)).toBeNull();
  });
});
