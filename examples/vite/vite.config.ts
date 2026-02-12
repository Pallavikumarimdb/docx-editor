import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'path';
import fs from 'fs';

// Detect monorepo: resolve to source when developing locally
const monorepoRoot = path.resolve(__dirname, '../..');
const isMonorepo = fs.existsSync(path.join(monorepoRoot, 'src/index.ts'));

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      // In monorepo, alias to source for live development
      ...(isMonorepo
        ? { '@eigenpal/docx-js-editor': path.join(monorepoRoot, 'src/index.ts') }
        : {}),
      '@': path.join(monorepoRoot, 'src'),
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: path.join(monorepoRoot, 'tailwind.config.js') }),
        autoprefixer(),
      ],
    },
  },
  define: {
    __ENABLE_FRAMEWORK_SWITCHER__: JSON.stringify(process.env.ENABLE_FRAMEWORK_SWITCHER === 'true'),
  },
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
  },
});
