/**
 * Watermark document API
 *
 * Platform-agnostic helpers for reading and applying a document watermark.
 * Shared by the React and Vue adapters (and the imperative ref API) so the
 * "Design → Watermark" behavior stays identical across frameworks.
 *
 * A watermark lives on `HeaderFooter.watermark`. Word repeats the same
 * watermark across every header of the section, so `setDocumentWatermark`
 * applies it to all headers (creating a default header part when the document
 * has none). All updates are immutable — a new `Document` is returned so the
 * change lands in the host's undo/redo history.
 */

import type {
  Document,
  HeaderFooter,
  Watermark,
  Relationship,
  SectionProperties,
} from '../types/document';
import { RELATIONSHIP_TYPES } from './relsParser';

/** Read the document's watermark (the first header that carries one). */
export function getDocumentWatermark(doc: Document | null | undefined): Watermark | undefined {
  const headers = doc?.package.headers;
  if (!headers) return undefined;
  for (const hf of headers.values()) {
    if (hf.watermark) return hf.watermark;
  }
  return undefined;
}

/** Strip the watermark from every header. */
function removeFromAllHeaders(doc: Document): Document {
  const headers = doc.package.headers;
  if (!headers || headers.size === 0) return doc;
  let changed = false;
  const next = new Map<string, HeaderFooter>();
  for (const [rId, hf] of headers) {
    if (hf.watermark) {
      const { watermark: _omit, ...rest } = hf;
      next.set(rId, rest);
      changed = true;
    } else {
      next.set(rId, hf);
    }
  }
  if (!changed) return doc;
  return { ...doc, package: { ...doc.package, headers: next } };
}

/** Apply the watermark to every existing header. */
function setOnAllHeaders(doc: Document, watermark: Watermark): Document {
  const headers = doc.package.headers!;
  const next = new Map<string, HeaderFooter>();
  for (const [rId, hf] of headers) {
    next.set(rId, { ...hf, watermark });
  }
  return { ...doc, package: { ...doc.package, headers: next } };
}

/** Create a default header part carrying the watermark (for headerless docs). */
function createHeaderWithWatermark(doc: Document, watermark: Watermark): Document {
  const pkg = doc.package;
  const rels: Map<string, Relationship> = pkg.relationships
    ? new Map(pkg.relationships)
    : new Map();

  // Use a stable, non-numeric relationship id. The rezip pipeline assigns
  // numeric `rIdN` ids to images/hyperlinks at save time (e.g. re-registering
  // an image whose src parsed to a data URL), so a numeric id here would
  // collide and the header relationship would be dropped. Matches the adapters'
  // on-demand header creation, which uses the same non-numeric scheme.
  const rId = 'rIdWatermarkHeader';

  // Unique header target filename.
  const usedTargets = new Set<string>();
  for (const r of rels.values()) {
    if (r.target) usedTargets.add(r.target.replace(/^\/?word\//, '').toLowerCase());
  }
  let n = 1;
  while (usedTargets.has(`header${n}.xml`)) n++;
  const target = `header${n}.xml`;

  rels.set(rId, { id: rId, type: RELATIONSHIP_TYPES.header, target });

  const headers = new Map<string, HeaderFooter>(pkg.headers ?? []);
  headers.set(rId, { type: 'header', hdrFtrType: 'default', content: [], watermark });

  const ref = { type: 'default' as const, rId };
  const withRef = (props: SectionProperties | undefined): SectionProperties => {
    const refs = props?.headerReferences ? [...props.headerReferences] : [];
    if (!refs.some((r) => r.type === 'default')) refs.push(ref);
    return { ...(props ?? {}), headerReferences: refs };
  };

  const body = pkg.document;
  const finalSectionProperties = withRef(body.finalSectionProperties);
  const sections = body.sections?.map((s) => ({ ...s, properties: withRef(s.properties) }));

  return {
    ...doc,
    package: {
      ...pkg,
      relationships: rels,
      headers,
      document: {
        ...body,
        finalSectionProperties,
        ...(sections ? { sections } : {}),
      },
    },
  };
}

/**
 * Return a new `Document` with the watermark applied to all headers, or removed
 * when `watermark` is null. Creates a default header when the document has none.
 */
export function setDocumentWatermark(doc: Document, watermark: Watermark | null): Document {
  if (!watermark) return removeFromAllHeaders(doc);
  const headers = doc.package.headers;
  if (headers && headers.size > 0) return setOnAllHeaders(doc, watermark);
  return createHeaderWithWatermark(doc, watermark);
}
