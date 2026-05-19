# @eigenpal/docx-editor-core

## 1.0.0

### Major Changes

- 6272b32: # 1.0.0

  First multi-package, multi-framework release. The monolithic `@eigenpal/docx-js-editor` is split into a framework-agnostic core and per-framework adapters, Vue 3 ships as a first-class adapter alongside React, and the license moves to Apache 2.0 across all packages.

  ## Package restructure (breaking)

  | Old import                                 | New import                                |
  | ------------------------------------------ | ----------------------------------------- |
  | `@eigenpal/docx-js-editor`                 | `@eigenpal/docx-editor-react`             |
  | `@eigenpal/docx-js-editor/react`           | `@eigenpal/docx-editor-react`             |
  | `@eigenpal/docx-editor-react/core`         | `@eigenpal/docx-editor-core`              |
  | `@eigenpal/docx-editor-react/headless`     | `@eigenpal/docx-editor-core/headless`     |
  | `@eigenpal/docx-editor-react/core-plugins` | `@eigenpal/docx-editor-core/core-plugins` |
  | `@eigenpal/docx-editor-react/mcp`          | `@eigenpal/docx-editor-agents/mcp`        |
  | `@eigenpal/docx-editor-react/i18n/*.json`  | `@eigenpal/docx-editor-i18n/*.json`       |

  The old `@eigenpal/docx-js-editor` package stays on 0.x for legacy maintenance — no 1.x compatibility shim ships. Framework-agnostic utilities (e.g. `createEmptyDocument`) move to core:

  ```diff
  - import { DocxEditor, createEmptyDocument } from '@eigenpal/docx-js-editor';
  + import { DocxEditor } from '@eigenpal/docx-editor-react';
  + import { createEmptyDocument } from '@eigenpal/docx-editor-core';
  ```

  ## Vue 3 adapter (`@eigenpal/docx-editor-vue`)

  The Vue package becomes a real adapter (previously a stub). Public API mirrors React:
  - `<DocxEditor>` with matching prop surface
  - `useDocxEditor` composable + `renderAsync` for the Node.js path
  - `/ui`, `/composables`, `/dialogs`, `/plugin-api`, `/styles` subpaths

  Parity gates cover insert-table, find/replace, page-setup, context menus, image overlay (resize/move/rotate/aspect-locked corners, dimension tooltip), advanced cell/row options (margins, height rule, text direction, no-wrap), menu-bar icons + shortcuts + carets, toolbar pickers, and the agent UI surface.

  ## Shared i18n package (`@eigenpal/docx-editor-i18n`)

  Locale strings move out of `@eigenpal/docx-editor-react` into a dedicated package consumed by both adapters from a single source.

  ```diff
  - import de from '@eigenpal/docx-editor-react/i18n/de.json';
  + import de from '@eigenpal/docx-editor-i18n/de.json';
  ```

  The `defaultLocale` value (English) is still re-exported from the adapter packages, unchanged.

  ## Agent UI relocation (breaking)

  `AgentPanel`, `AgentChatLog`, `AgentComposer`, `AgentSuggestionChip`, `AgentTimeline` no longer ship from `@eigenpal/docx-editor-react`. They live at:
  - `@eigenpal/docx-editor-agents/react` — React components + `useAgentChat`
  - `@eigenpal/docx-editor-agents/vue` — Vue 3 twins, plus `AIContextMenu` and `AIResponsePreview`
  - `@eigenpal/docx-editor-agents/ai-sdk/react` / `/ai-sdk/vue` — `@ai-sdk/*` adapters
  - `@eigenpal/docx-editor-agents/bridge` — React-free `createEditorBridge`, `agentTools`, `executeToolCall`, `getToolSchemas`, `createReviewerBridge`. Safe for headless / Vue / Node.

  ```diff
  - import { AgentPanel, AgentChatLog } from '@eigenpal/docx-editor-react';
  + import { AgentPanel, AgentChatLog } from '@eigenpal/docx-editor-agents/react';
  ```

  The agent components no longer call `useTranslation` directly — pass localized `*Label` props instead. `<DocxEditor>`'s built-in agent panel slot still forwards localized strings automatically.

  Accessibility polish on the agent surface: keyboard-operable resize handle, Escape-dismissable context menu, live-region chat log, WCAG AA contrast on response previews.

  ## Toolbar naming unified (breaking)

  The standalone formatting bar is `Toolbar` on both adapters. The old "classic" single-row `Toolbar` (with File/Format/Insert menus baked in) is removed — compose `EditorToolbar.MenuBar` + `EditorToolbar.Toolbar` for that layout.

  | Old (React)                    | New (React + Vue)       |
  | ------------------------------ | ----------------------- |
  | `FormattingBar`                | `Toolbar`               |
  | Classic `Toolbar` (with menus) | `EditorToolbar`         |
  | `EditorToolbar.FormattingBar`  | `EditorToolbar.Toolbar` |

  Vue: `BasicToolbar` / `FormattingBar` aliases removed; `EditorToolbar`'s `formatting-bar` slot is now `toolbar`. Vue's table border-color and cell-fill pickers now use the advanced color picker matching React. Vue `MenuDropdown`'s `showChevron` default flips from `true` to `false` — pass `:show-chevron="true"` explicitly to keep the caret.

  ## `showPrintButton` prop removed (breaking)

  Removed from `<DocxEditor>` and `<Toolbar>` on both adapters; the Vue `<Toolbar>` `print` event is gone with it. `onPrint` callback stays.

  ```diff
  - <DocxEditor showPrintButton onPrint={handlePrint} />
  + <DocxEditor onPrint={handlePrint} />
  ```

  To hide File > Print, omit `onPrint`. Programmatic print still works via `ref.current.print()` / `editorRef.value.print()`.

  ## License moves to Apache 2.0

  All published packages relicense to Apache 2.0. Notably: `@eigenpal/docx-editor-agents` was AGPL-3.0-or-later — the relicense lifts copyleft obligations on agent embedders.

### Minor Changes

- 76093f9: `@eigenpal/docx-editor-core` now ships an API Extractor snapshot for every published subpath (61 entries) under `packages/core/etc/`. CI fails on any undocumented drift to the public surface via `bun run api:check`. Adds rich TSDoc on the 21 most-imported types — `Document`, `DocumentBody`, `Paragraph`, `Run`, `Table`, `TableRow`, `TableCell`, `Image`, `Hyperlink`, `Comment`, `ColorValue`, `BorderSpec`, `ShadingProperties`, `TextFormatting`, `ParagraphFormatting`, `Style`, `Section`, `SectionProperties`, `ListLevel`, `ListRendering`, `AbstractNumbering`, `NumberingDefinitions` — each linked to its ECMA-376 reference.

  No runtime change; doc-only.

### Patch Changes

- c5125ff: Annotate every subpath barrel with `@packageDocumentation` + `@public` so API Extractor can extract them in the next phase. The exports map is unchanged; the published surface is unchanged. Doc-only.
- 348fa6b: Tag three subpath helpers as `@internal` in TSDoc: `managers/TableSelectionManager`, `prosemirror/utils/extractTrackedChanges`, `prosemirror/utils/visualLineNavigation`. The subpaths stay in `package.json` `exports` for back-compat (shipped in v1.0), but the snapshots in `etc/managers-TableSelectionManager.api.md`, `etc/prosemirror-utils-extractTrackedChanges.api.md`, and `etc/prosemirror-utils-visualLineNavigation.api.md` now mark every export `// @internal`.

  Consumers should reach for the adapter-side wrappers (`useTableSelection`, `useTrackedChanges`, `useVisualLineNavigation` in React/Vue) instead of these subpaths. The tag is a signal of intent — these subpaths are expected to move behind public surfaces in a future major.

- 0187af2: Emit consumer-friendly JSON docs at `docs/json/<pkg-slug>/<subpath>.json` for every `@public` export across the published packages. Companion to the existing `etc/<slug>.api.md` snapshots — same source of truth (API Extractor), different output shape: instead of human-readable Markdown, the JSON is structured for a docs site to render any layout it wants. Includes per-export source-link URLs into the GitHub source tree, type-reference canonical IDs for cross-page linking, and TSDoc summaries/remarks/examples parsed out of the source.

  New tooling: `bun run docs:json` regenerates, `bun run docs:check` (in CI) fails on drift. Contract documented in `CLAUDE.md` under `### Docs JSON`. No runtime change to any published package.

- 61983ca: Add `@packageDocumentation` blocks to every public subpath across the published packages, and a small post-build step (`scripts/inject-package-doc.mjs`) that re-prepends the source's head doc-block to the dist `.d.ts` after tsup runs. tsup's rollup-plugin-dts hoists transitive type imports above the file-head comment, which previously stripped the description from the published types. Consumers now see the package-level prose in their IDE hover and the API Extractor snapshots no longer flag "No @packageDocumentation comment for this package".
- b2230a3: Internal refactor: TableExtension closure split into per-domain modules under `prosemirror/extensions/nodes/TableExtension/commands/` (insert, delete, selection, borders, cellFormatting, sizing, tableStyle, helpers, activeCellPlugin). Schema-binding commands become `make*(schema)` factories called once per editor; schema-free commands become module-level `Command` constants. No public API change.
- 8836214: Stop shipping sourcemaps and declaration maps in published tarballs. They were dead weight: the `.js.map` files referenced source files that aren't in the tarball, and the `.d.ts.map` files pointed at `.ts` files consumers can't see either.

  Concrete changes:
  - `@eigenpal/docx-editor-core`: drop `sourcemap: !isProd` from both tsup builds (the build never ran with `NODE_ENV=production`, so 245 `.js.map` files / ~8.2 MB were shipping). Tarball: 2.5 MB → 0.7 MB. Unpacked: 11.0 MB → 2.7 MB.
  - `@eigenpal/docx-editor-vue`: pass `compilerOptions: { declarationMap: false }` to `vite-plugin-dts` to suppress the 63 `.d.ts.map` files.
  - `@eigenpal/docx-editor-agents`: same `declarationMap: false` for the Vue sub-build; also add the missing `sideEffects: ["*.css"]` so bundlers can tree-shake.

  Total unpacked footprint across all published packages: 14.8 MB → 6.3 MB.
