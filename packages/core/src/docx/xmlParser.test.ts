import { describe, test, expect } from 'bun:test';
import { xml2js } from 'xml-js';
import { parseXml, getTextContent, findChild, elementToXml } from './xmlParser';

describe('parseXml — stray ampersand tolerance', () => {
  test('parses text with a literal & followed by a space', () => {
    const xml = `<?xml version="1.0"?><root><w:t xmlns:w="http://x">Smith & Jones</w:t></root>`;
    const result = parseXml(xml);
    const root = (result.elements ?? []).find((e) => e.name === 'root');
    const wt = findChild(root, 'w', 't');
    expect(getTextContent(wt)).toBe('Smith & Jones');
  });

  test('parses text with & followed by a digit (not a valid entity start)', () => {
    const xml = `<?xml version="1.0"?><root><a>Q&amp;A and Q&1A</a></root>`;
    const result = parseXml(xml);
    const root = (result.elements ?? []).find((e) => e.name === 'root');
    const a = root?.elements?.find((e) => e.name === 'a');
    expect(getTextContent(a)).toBe('Q&A and Q&1A');
  });

  test('preserves valid named, decimal, and hex entity references', () => {
    const xml = `<?xml version="1.0"?><r><t>&amp; &lt; &#x20AC; &#169;</t></r>`;
    const result = parseXml(xml);
    const r = (result.elements ?? []).find((e) => e.name === 'r');
    const t = r?.elements?.find((e) => e.name === 't');
    expect(getTextContent(t)).toBe('& < € ©');
  });

  test('error message includes surrounding context when xml-js still throws', () => {
    // Unterminated tag — sanitization can't fix this; we still rethrow but
    // with a "Near: ..." snippet so callers know which bytes broke the parse.
    const xml = `<?xml version="1.0"?><root><a><b></root>`;
    expect(() => parseXml(xml)).toThrow(/Near: /);
  });
});

describe('elementToXml', () => {
  test('escapes parsed attribute values when reserializing raw OOXML', () => {
    const xml =
      '<w:sdtPr><w:dropDownList><w:listItem w:displayText="Commercial, corporate and M&amp;A" w:value="A&lt;B"/></w:dropDownList></w:sdtPr>';
    const parsed = parseXml(xml);
    const sdtPr = (parsed.elements ?? []).find((e) => e.name === 'w:sdtPr');

    const out = elementToXml(sdtPr!);

    expect(out).toContain('w:displayText="Commercial, corporate and M&amp;A"');
    expect(out).toContain('w:value="A&lt;B"');
    expect(() => xml2js(out, { compact: false })).not.toThrow();
  });
});
