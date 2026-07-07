import { describe, expect, test } from 'bun:test';
import { schema } from '../../prosemirror/schema';
import { buildBoxTree } from '../buildBoxTree';

describe('buildBoxTree — page-break paragraphs', () => {
  test('turns empty pageBreakBefore paragraphs into structural page breaks', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Before')]),
      schema.node('paragraph', { pageBreakBefore: true }, []),
      schema.node('paragraph', null, [schema.text('After')]),
    ]);

    const blocks = buildBoxTree(doc, {});

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
  });
});
