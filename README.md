# @eigenpal/docx-js-editor

An open-source, extendable WYSIWYG DOCX editor for JavaScript.

## Demo

<!-- Add video here -->

## Installation

```bash
npm install @eigenpal/docx-js-editor
```

## Usage

### Basic

```tsx
import DocxEditor from '@eigenpal/docx-js-editor';
import '@eigenpal/docx-js-editor/styles.css';

function App() {
  return <DocxEditor onChange={(doc) => console.log(doc)} />;
}
```

### Load a DOCX file

```tsx
import DocxEditor, { parseDocx } from '@eigenpal/docx-js-editor';

const buffer = await fetch('/template.docx').then((r) => r.arrayBuffer());
const document = await parseDocx(buffer);

<DocxEditor document={document} />;
```

### Save document

```tsx
import { useRef } from 'react';
import DocxEditor, { type DocxEditorRef } from '@eigenpal/docx-js-editor';

function App() {
  const editorRef = useRef<DocxEditorRef>(null);

  const handleSave = async () => {
    const buffer = await editorRef.current?.save();
    if (buffer) {
      // Upload to your backend
      await fetch('/api/documents/123', {
        method: 'PUT',
        body: buffer,
      });
    }
  };

  return (
    <>
      <button onClick={handleSave}>Save</button>
      <DocxEditor ref={editorRef} />
    </>
  );
}
```

### Ref methods

```tsx
const editorRef = useRef<DocxEditorRef>(null);

// Save and get buffer
const buffer = await editorRef.current?.save();

// Get current document object
const doc = editorRef.current?.getDocument();

// Zoom controls
editorRef.current?.setZoom(1.5); // 150%
const zoom = editorRef.current?.getZoom();

// Navigation
editorRef.current?.focus();
editorRef.current?.scrollToPage(3);
```

### Headless mode (bring your own UI)

```tsx
import { useRef } from 'react';
import DocxEditor, { type DocxEditorRef } from '@eigenpal/docx-js-editor';

function App() {
  const editorRef = useRef<DocxEditorRef>(null);

  return (
    <>
      {/* Your own toolbar/controls */}
      <button onClick={() => editorRef.current?.save()}>My Save Button</button>

      {/* Editor without built-in toolbar */}
      <DocxEditor ref={editorRef} showToolbar={false} showVariablePanel={false} />
    </>
  );
}
```

### Standalone components

```tsx
import {
  Toolbar,
  FontPicker,
  ColorPicker,
  parseDocx,
  serializeDocx,
} from '@eigenpal/docx-js-editor';
```

### Template variables

```tsx
import { processTemplate } from '@eigenpal/docx-js-editor';

const result = await processTemplate(docxBuffer, {
  name: 'John Doe',
  company: 'Acme Inc',
});
```

## Features

- Full WYSIWYG editing with Microsoft Word fidelity
- Open, edit, and save DOCX files in the browser
- Standalone components (Toolbar, FontPicker, ColorPicker, etc.)
- Template variable support (`{{variable}}`)
- Extendable plugin architecture
- Zero server dependencies

## Development

```bash
bun install
bun run dev
```

## Contributing

This is an open-source project. Contributions are welcome!

- [Open an issue](https://github.com/eigenpal/docx-js-editor/issues) to report bugs or request features
- Submit pull requests to help improve the editor

## License

MIT
