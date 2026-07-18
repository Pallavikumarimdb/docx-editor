import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { singletonManager } from '../../schema';
import { DOMParser } from 'prosemirror-model';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('ImageExtension border serialization', () => {
  test('serializes and parses border attributes correctly', () => {
    const schema = singletonManager.getSchema();
    const node = schema.nodes.image.create({
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      borderWidth: 2,
      borderColor: '#ff0000',
      borderKind: 'dashed',
    });

    // 1. Serialize to DOM
    const output = schema.nodes.image.spec.toDOM!(node);
    expect(output).toBeDefined();

    const [tag, domAttrs] = output as [string, Record<string, string>];
    expect(tag).toBe('img');
    expect(domAttrs.style).toContain('border: 2px dashed #ff0000');
    expect(domAttrs['data-border-width']).toBe('2');
    expect(domAttrs['data-border-color']).toBe('#ff0000');
    expect(domAttrs['data-border-style']).toBe('dashed');

    // 2. Build DOM element inside a container to parse back
    const container = document.createElement('div');
    const p = document.createElement('p');
    const imgEl = document.createElement('img');
    imgEl.setAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    );
    for (const [k, v] of Object.entries(domAttrs)) {
      if (k !== 'style') {
        imgEl.setAttribute(k, v);
      }
    }
    imgEl.setAttribute('style', domAttrs.style);
    p.appendChild(imgEl);
    container.appendChild(p);

    // 3. Parse DOM back to ProseMirror Node
    const parser = DOMParser.fromSchema(schema);
    const parsedDoc = parser.parse(container);
    console.log('parsedDoc content:', parsedDoc.toString());
    let parsedNode: any = null;
    parsedDoc.descendants((n) => {
      if (n.type.name === 'image') {
        parsedNode = n;
      }
    });

    expect(parsedNode).not.toBeNull();
    console.log('Parsed attrs:', parsedNode.attrs);
    expect(parsedNode.attrs.borderWidth).toBe(2);
    expect(parsedNode.attrs.borderColor).toBe('#ff0000');
    expect(parsedNode.attrs.borderKind).toBe('dashed');
  });
});
