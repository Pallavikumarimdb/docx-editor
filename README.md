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
import { parseDocx } from '@eigenpal/docx-js-editor';

const buffer = await fetch('/template.docx').then((r) => r.arrayBuffer());
const document = await parseDocx(buffer);

<DocxEditor document={document} />;
```

### Save document

```tsx
const editorRef = useRef(null);

const handleSave = async () => {
  const buffer = await editorRef.current.save();
  // Upload or download the buffer
};

<DocxEditor ref={editorRef} />;
```

### Headless mode (no toolbar)

Control everything from your own UI:

```tsx
import DocxEditor, { Toolbar } from '@eigenpal/docx-js-editor';

function App() {
  const editorRef = useRef(null);

  return (
    <>
      {/* Your own toolbar/controls */}
      <button onClick={() => editorRef.current.save()}>My Save Button</button>

      {/* Editor without built-in toolbar */}
      <DocxEditor ref={editorRef} showToolbar={false} showVariablePanel={false} />
    </>
  );
}
```

### Use standalone components

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
