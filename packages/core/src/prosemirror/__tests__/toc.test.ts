import { describe, expect, test } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';
import { parseDocumentBody } from '../../docx/documentParser';
import { serializeDocumentBody } from '../../docx/serializer/documentSerializer';
import type { Layout } from '../../layout-engine/types';
import type { BlockSdt } from '../../types/document';
import { fromProseDoc } from '../conversion/fromProseDoc';
import { schema } from '../schema';
import {
  findTableOfContentsBlocks,
  hasTableOfContentsNeedingUpdate,
  insertTableOfContents,
  parseTocInstruction,
  updateTableOfContents,
} from '../toc';

const TOC_RAW_EMPTY = [
  '<w:sdt>',
  '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
  '<w:sdtContent>',
  '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
  '<w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r>',
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
  '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '</w:sdtContent>',
  '</w:sdt>',
].join('');

function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return schema.node('paragraph', attrs, text ? [schema.text(text)] : []);
}

function tocBlock() {
  return schema.node(
    'blockSdt',
    {
      sdtType: 'richText',
      alias: 'Table of Contents',
      rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      rawPreserveXml: TOC_RAW_EMPTY,
      rawPreserveText: '',
    },
    [paragraph('')]
  );
}

function rawTocBlock(rawPreserveXml: string, rawPreserveText = 'Heading\t3') {
  return schema.node(
    'blockSdt',
    {
      sdtType: 'richText',
      alias: 'Table of Contents',
      rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      rawPreserveXml,
      rawPreserveText,
    },
    [paragraph(rawPreserveText)]
  );
}

describe('TOC field support', () => {
  test('parses common TOC field instructions and preserves unknown switches', () => {
    const parsed = parseTocInstruction(' TOC \\h \\o "1-5" \\z ');
    expect(parsed).toEqual({
      type: 'TOC',
      hyperlink: true,
      outlineStart: 1,
      outlineEnd: 5,
      raw: 'TOC \\h \\o "1-5" \\z',
      unknownSwitches: ['\\z'],
    });
  });

  test('detects dirty or empty block SDT TOCs', () => {
    const doc = schema.node('doc', null, [
      tocBlock(),
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);
    const blocks = findTableOfContentsBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].needsUpdate).toBe(true);
    expect(hasTableOfContentsNeedingUpdate(doc)).toBe(true);
  });

  test('detects Word numeric dirty TOC fields in raw SDT XML', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="1"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3" \\h</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:t>Heading</w:t></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    const doc = schema.node('doc', null, [rawTocBlock(raw)]);

    expect(findTableOfContentsBlocks(doc)[0].needsUpdate).toBe(true);
    expect(hasTableOfContentsNeedingUpdate(doc)).toBe(true);
  });

  test('updates cached TOC result while preserving the field envelope', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('First Heading', { styleId: 'Heading1' }),
        paragraph('Second Heading', { outlineLevel: 1 }),
      ]),
    });

    let firstHeadingPos = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'First Heading') {
        firstHeadingPos = pos;
        return false;
      }
      return true;
    });

    const layout: Layout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 3,
          fragments: [
            {
              kind: 'paragraph',
              blockId: 1,
              x: 0,
              y: 0,
              width: 500,
              height: 24,
              fromLine: 0,
              toLine: 1,
              pmStart: firstHeadingPos,
              pmEnd: firstHeadingPos + 20,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
      ],
    };

    const updated = updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      { layout }
    );

    expect(updated).toBe(true);
    const updatedToc = state.doc.child(0);
    expect(updatedToc.textContent).toContain('First Heading');
    expect(updatedToc.textContent).toContain('3');
    expect(updatedToc.child(0).attrs.styleId).toBe('TOC1');
    expect(updatedToc.child(1).attrs.styleId).toBe('TOC2');
    expect(updatedToc.child(0).attrs.indentLeft).toBeNull();
    expect(updatedToc.child(1).attrs.indentLeft).toBe(240);
    expect(updatedToc.child(0).attrs.lineSpacing).toBe(276);

    const raw = updatedToc.attrs.rawPreserveXml as string;
    expect(raw).toContain('w:fldCharType="begin"');
    expect(raw).toContain('TOC \\h \\o &quot;1-5&quot;');
    expect(raw).toContain('w:fldCharType="separate"');
    expect(raw).toContain('w:fldCharType="end"');
    expect(raw).toContain('w:pStyle w:val="TOC1"');
    expect(raw).toContain('w:anchor="_Toc');
    expect(raw).not.toContain('w:dirty="true"');

    const heading = state.doc.child(1);
    expect(heading.attrs.bookmarks?.[0]?.name).toMatch(/^_Toc/);

    // The regenerated TOC must save via its raw XML: the stored fingerprint
    // has to match the tab-aware fingerprint the preservation guard computes,
    // even though the generated entries contain tab leader nodes.
    const saved = fromProseDoc(state.doc);
    const savedSdt = saved.package.document.content[0] as BlockSdt;
    expect(savedSdt.rawPreserveXml).toBe(raw);

    // And the saved XML must reopen cleanly: the parser re-captures raw
    // preservation for the regenerated field and the entries stay intact.
    const savedXml = serializeDocumentBody(saved.package.document);
    const bodyXml = savedXml.replace(/^<w:body>/, '').replace(/<\/w:body>$/, '');
    const reopened = parseDocumentBody(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`
    );
    const reopenedSdt = reopened.content[0] as BlockSdt;
    expect(reopenedSdt.type).toBe('blockSdt');
    expect(reopenedSdt.rawPreserveXml).toBeTruthy();
    expect(reopenedSdt.rawPreserveText).toContain('First Heading\t3');
    expect(reopenedSdt.rawPreserveText).toContain('Second Heading\t');

    const updatedAgain = updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      {
        layout: {
          ...layout,
          pages: layout.pages.map((page) => ({
            ...page,
            number: 4,
          })),
        },
      }
    );
    expect(updatedAgain).toBe(true);
    expect(state.doc.child(0).attrs.rawPreserveText).toContain('First Heading\t4');
  });

  test('resolves a page-break-before TOC title to the page after the break', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        paragraph('Table of Contents', { styleId: 'Heading1', pageBreakBefore: true }),
        tocBlock(),
        paragraph('First Heading', { styleId: 'Heading1' }),
      ]),
    });

    const layout: Layout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 1,
          fragments: [
            {
              kind: 'paragraph',
              blockId: 0,
              x: 0,
              y: 1000,
              width: 500,
              height: 0,
              fromLine: 0,
              toLine: 0,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
        {
          number: 2,
          fragments: [
            {
              kind: 'paragraph',
              blockId: 0,
              x: 0,
              y: 100,
              width: 500,
              height: 24,
              fromLine: 0,
              toLine: 1,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
      ],
    };

    const updated = updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      { layout }
    );

    expect(updated).toBe(true);
    const updatedToc = state.doc.child(1);
    expect(updatedToc.attrs.rawPreserveText).toContain('Table of Contents\t2');
  });

  test('ignores nested PAGEREF instructions in Word cached TOC results', () => {
    const raw = [
      '<w:sdt>',
      '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      '<w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3" \\h \\z \\u</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:t>Heading</w:t></w:r><w:r><w:tab/></w:r>',
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>PAGEREF _Toc1 \\h</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r>',
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent>',
      '</w:sdt>',
    ].join('');
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        rawTocBlock(raw),
        paragraph('Heading', { styleId: 'Heading1' }),
      ]),
    });

    const block = findTableOfContentsBlocks(state.doc)[0];
    expect(block.instruction.raw).toBe('TOC \\o "1-3" \\h \\z \\u');

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(updated).toBe(true);
    const regeneratedRaw = findTableOfContentsBlocks(state.doc)[0].node.attrs
      .rawPreserveXml as string;
    expect(regeneratedRaw).toContain('TOC \\o &quot;1-3&quot; \\h \\z \\u');
    expect(regeneratedRaw).not.toContain('PAGEREF');
  });

  test('inserts a real dirty TOC field block at the current selection', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        paragraph('Intro'),
        paragraph('First Heading', { styleId: 'Heading1' }),
      ]),
    });
    const insertPos = state.doc.child(0).nodeSize;
    state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(insertPos))));

    const inserted = insertTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(inserted).toBe(true);
    const insertedToc = findTableOfContentsBlocks(state.doc)[0];
    expect(insertedToc.node.type.name).toBe('blockSdt');
    expect(hasTableOfContentsNeedingUpdate(state.doc)).toBe(true);

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(updated).toBe(true);
    expect(findTableOfContentsBlocks(state.doc)[0].node.attrs.rawPreserveText).toContain(
      'First Heading'
    );
  });
});
