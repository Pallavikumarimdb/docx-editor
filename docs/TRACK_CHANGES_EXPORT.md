# Track Changes Export Workflow

This project supports opt-in DOCX export with Word Track Changes markup.

Default behavior is unchanged:

- `DocxEditorRef.save()` produces normal non-tracked output unless `DocxEditor` is configured with `trackChanges.enabled: true`.
- `DocumentAgent.toBuffer()` / `toBlob()` without `trackChanges.enabled: true` produces normal non-tracked output.
- Tracked export only runs when explicitly enabled.

## API Surface

`TrackChangesExportOptions`:

```ts
interface TrackChangesExportOptions {
  enabled?: boolean;
  author?: string;
  date?: string; // ISO 8601 recommended
}
```

React API:

```ts
interface DocxEditorProps {
  trackChanges?: TrackChangesExportOptions;
}

interface DocxEditorRef {
  save(): Promise<ArrayBuffer | null>;
}
```

Headless/API options:

```ts
interface SaveDocxOptions {
  trackChanges?: {
    enabled?: boolean;
    author?: string;
    date?: string; // ISO 8601 recommended
  };
}
```

Available on:

- `DocxEditor` prop: `trackChanges`
- `DocumentAgent.toBuffer(options?)`
- `DocumentAgent.toBlob(mimeType?, options?)`
- `repackDocx(document, options?)`

## React Usage

```tsx
<DocxEditor
  ref={editorRef}
  documentBuffer={file}
  trackChanges={{
    enabled: true,
    author: 'John Doe',
    date: new Date().toISOString(),
  }}
/>;

const buffer = await editorRef.current?.save();
```

## Headless Usage

```ts
import { DocumentAgent } from '@eigenpal/docx-js-editor/headless';

const agent = await DocumentAgent.fromBuffer(originalBuffer);
const trackedBuffer = await agent.toBuffer({
  trackChanges: {
    enabled: true,
    author: 'John Doe',
  },
});
```

## Current Export Behavior

When tracked export is enabled, the export pipeline compares the current document against the baseline snapshot and emits tracked insertion/deletion wrappers in WordprocessingML.

Current guarantees:

- Standard save output remains non-tracked unless explicitly enabled.
- Author/date metadata is attached to generated revisions.
- If no baseline snapshot exists, export safely falls back to normal non-tracked output.

## Advanced Revision Primitives

The codebase also includes parser/serializer and helper support for:

- Move wrappers (`w:moveFrom` / `w:moveTo`)
- Run/paragraph property changes (`w:rPrChange` / `w:pPrChange`)
- Table property and structural revision elements (`w:tblPrChange`, `w:trPrChange`, `w:tcPrChange`, row/cell structural markers)

These primitives round-trip through parsing/serialization and can be applied programmatically via revision helper modules under `src/docx/revisions/`.
