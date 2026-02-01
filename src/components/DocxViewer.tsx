import React, { useEffect, useRef } from 'react';
import { the editor } from 'editor';
import 'editor/style.css';

interface DocxViewerProps {
  file: File | null;
}

export function DocxViewer({ file }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<the editor | null>(null);

  useEffect(() => {
    // Clean up previous instance if it exists
    if (editorRef.current) {
      editorRef.current.destroy();
      editorRef.current = null;
    }

    // Don't initialize if no file or no container
    if (!file || !containerRef.current) {
      return;
    }

    // Clear the container before mounting
    containerRef.current.innerHTML = '';

    // Initialize the editor with the File object
    const editor = new the editor({
      selector: containerRef.current,
      document: file,
      documentMode: 'editing',
      onReady: (event: unknown) => {
        console.log('the editor is ready', event);
      },
      onEditorCreate: (event: unknown) => {
        console.log('Editor created', event);
      },
    });

    editorRef.current = editor;

    // Cleanup on unmount or when file changes
    return () => {
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
  }, [file]);

  if (!file) {
    return (
      <div style={placeholderStyle}>
        <p style={{ fontSize: '16px', color: '#666' }}>
          No document loaded. Please select a DOCX file.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={containerStyle}
    />
  );
}

const placeholderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '400px',
  border: '1px solid #e0e0e0',
  borderRadius: '4px',
  backgroundColor: '#fafafa',
};

const containerStyle: React.CSSProperties = {
  minHeight: '600px',
  border: '1px solid #e0e0e0',
  borderRadius: '4px',
};
