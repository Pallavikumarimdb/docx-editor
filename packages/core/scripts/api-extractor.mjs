#!/usr/bin/env node
// Run API Extractor over every published subpath in packages/core/package.json's
// exports map. Generates one `etc/<slug>.api.md` snapshot per entry. Pass
// `--local` to write/update snapshots; default is CI mode (compare and fail
// on drift).
//
// Shared logic lives in `scripts/lib/api-extractor-runner.mjs` so each
// adapter package can reuse the same machinery.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApiExtractor } from '../../../scripts/lib/api-extractor-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

runApiExtractor({
  packageRoot,
  isLocal: process.argv.includes('--local'),
  buildHint: "bun run --filter '@eigenpal/docx-editor-core' build",
});
