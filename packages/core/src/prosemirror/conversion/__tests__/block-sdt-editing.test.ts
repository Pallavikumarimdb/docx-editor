/**
 * Phase 2 — block-level content controls (`w:sdt`) as editable PM nodes.
 *
 * Phase 1 made block SDTs round-trip through parse↔serialize as a `BlockSdt`
 * model node, but they were flattened when converting to ProseMirror, so they
 * could not be edited or rendered as a distinct region. These tests cover the
 * editing pipeline:
 *   Document(BlockSdt) → toProseDoc → PM `blockSdt` node → fromProseDoc →
 *   Document(BlockSdt)
 */

import { describe, test, expect } from 'bun:test';
import { toProseDoc } from '../toProseDoc';
import { fromProseDoc } from '../fromProseDoc';
import type { Document, BlockSdt, Paragraph } from '../../../types/document';

function para(text: string): Paragraph {
  return { type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text }] }] };
}

function docOf(...content: Document['package']['document']['content']): Document {
  return { package: { document: { content } } };
}

function firstBlockSdt(doc: Document): BlockSdt {
  const block = doc.package.document.content[0];
  if (block?.type !== 'blockSdt') {
    throw new Error(`expected first block to be blockSdt, got ${block?.type}`);
  }
  return block;
}

describe('block SDT — toProseDoc emits an editable blockSdt node', () => {
  test('wraps children in a blockSdt PM node (not flattened)', () => {
    const sdt: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'intro', alias: 'Intro', id: 7 },
      content: [para('Hello'), para('World')],
    };
    const pm = toProseDoc(docOf(sdt));

    // The control is the first node; a trailing paragraph is appended so the
    // caret can reach past a doc-final isolating control (see the dedicated
    // boundary-reachability tests below).
    const node = pm.firstChild!;
    expect(node.type.name).toBe('blockSdt');
    expect(node.attrs.tag).toBe('intro');
    expect(node.attrs.alias).toBe('Intro');
    expect(node.attrs.id).toBe(7);
    // Children remain real, editable paragraph nodes.
    expect(node.childCount).toBe(2);
    expect(node.child(0).type.name).toBe('paragraph');
    expect(node.child(0).textContent).toBe('Hello');
  });

  test('an empty control gets a single empty paragraph to satisfy block+', () => {
    const sdt: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'empty' },
      content: [],
    };
    const node = toProseDoc(docOf(sdt)).firstChild!;
    expect(node.type.name).toBe('blockSdt');
    expect(node.childCount).toBe(1);
    expect(node.child(0).type.name).toBe('paragraph');
  });

  test('nested block SDTs survive as nested blockSdt nodes', () => {
    const inner: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'inner' },
      content: [para('deep')],
    };
    const outer: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'outer' },
      content: [inner],
    };
    const node = toProseDoc(docOf(outer)).firstChild!;
    expect(node.attrs.tag).toBe('outer');
    expect(node.child(0).type.name).toBe('blockSdt');
    expect(node.child(0).attrs.tag).toBe('inner');
    expect(node.child(0).child(0).textContent).toBe('deep');
  });
});

describe('block SDT — fromProseDoc reconstructs the BlockSdt model', () => {
  test('round-trips properties and children (Document → PM → Document)', () => {
    const original: BlockSdt = {
      type: 'blockSdt',
      properties: {
        sdtType: 'richText',
        tag: 'sec',
        alias: 'Section',
        id: 42,
        lock: 'sdtContentLocked',
        rawPropertiesXml: '<w:sdtPr><w:tag w:val="sec"/><w:id w:val="42"/></w:sdtPr>',
      },
      content: [para('A'), para('B')],
    };
    const back = fromProseDoc(toProseDoc(docOf(original)));
    const sdt = firstBlockSdt(back);

    expect(sdt.properties.tag).toBe('sec');
    expect(sdt.properties.alias).toBe('Section');
    expect(sdt.properties.id).toBe(42);
    expect(sdt.properties.lock).toBe('sdtContentLocked');
    // The captured raw w:sdtPr survives for lossless serialization.
    expect(sdt.properties.rawPropertiesXml).toContain('w:val="sec"');
    expect(sdt.content.map((c) => c.type)).toEqual(['paragraph', 'paragraph']);
  });

  test('nested control round-trips both wrappers', () => {
    const inner: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'inner' },
      content: [para('x')],
    };
    const outer: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'outer' },
      content: [inner],
    };
    const sdt = firstBlockSdt(fromProseDoc(toProseDoc(docOf(outer))));
    expect(sdt.properties.tag).toBe('outer');
    expect(sdt.content[0].type).toBe('blockSdt');
    expect((sdt.content[0] as BlockSdt).properties.tag).toBe('inner');
  });
});

describe('block SDT — boundary reachability', () => {
  test('a doc whose only block is a control gets a trailing paragraph', () => {
    const sdt: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'whole-body' },
      content: [para('controlled')],
    };
    const pm = toProseDoc(docOf(sdt));
    const kinds: string[] = [];
    pm.forEach((n) => kinds.push(n.type.name));
    // Without a trailing text-cursor host the caret would be trapped inside
    // the isolating control (no gapcursor). The last node must be a paragraph.
    expect(kinds[kinds.length - 1]).toBe('paragraph');
    expect(kinds[0]).toBe('blockSdt');
  });

  test('a doc ending in a control gets a trailing paragraph', () => {
    const sdt: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'last' },
      content: [para('x')],
    };
    const pm = toProseDoc(docOf(para('intro'), sdt));
    const kinds: string[] = [];
    pm.forEach((n) => kinds.push(n.type.name));
    expect(kinds).toEqual(['paragraph', 'blockSdt', 'paragraph']);
  });

  test('a doc not ending in a control is left unchanged (no spurious paragraph)', () => {
    const sdt: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'mid' },
      content: [para('x')],
    };
    const pm = toProseDoc(docOf(sdt, para('after')));
    expect(pm.childCount).toBe(2);
    expect(pm.child(1).type.name).toBe('paragraph');
  });

  test('the appended trailing paragraph does not survive back to the model', () => {
    // It is an editing affordance, not document content: a control-only doc
    // round-trips to just the control (plus the empty trailing paragraph the
    // editor needs). Confirm it does not nest inside the control.
    const sdt: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText', tag: 'only' },
      content: [para('c')],
    };
    const back = fromProseDoc(toProseDoc(docOf(sdt)));
    const blocks = back.package.document.content;
    expect(blocks[0].type).toBe('blockSdt');
    // The control still wraps exactly its one paragraph (trailing para is a
    // sibling, not absorbed into the control).
    expect((blocks[0] as BlockSdt).content.length).toBe(1);
  });
});
