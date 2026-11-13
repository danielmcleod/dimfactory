// electron-vite build: main (ESM, hosts the core), the sandboxed preload (CJS,
// emitted as .cjs because package.json is "type":"module") and the React renderer. `dependencies` is empty, so every
// import is bundled; nothing is externalized but Electron and Node built-ins.
import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { RENDERER_CSP } from './src/main/csp.ts'

/**
 * The core reads its builtin prompt texts, its internal prompts (the self-heal template) and the pricing seed
 * next to its own module (`import.meta.url`), and the Brief's built-in packs, the built-in recipes and New project's
 * built-in templates likewise. Bundled, that module is out/main/index.js, so the files are copied to
 * out/main/defaults/, out/main/internal/, out/main/seed/, out/main/packs/, out/main/recipes/ and out/main/templates/
 * (the JSON only).
 */
const coreRuntimeFiles = (): Plugin => ({
  name: 'dim-factory-core-runtime-files',
  writeBundle() {
    cpSync(resolve('src/core/prompts/defaults'), resolve('out/main/defaults'), { recursive: true })
    cpSync(resolve('src/core/prompts/internal'), resolve('out/main/internal'), { recursive: true })
    cpSync(resolve('src/core/catalog/seed/pricing.seed.json'), resolve('out/main/seed/pricing.seed.json'))
    cpSync(resolve('src/core/packs'), resolve('out/main/packs'), {
      recursive: true,
      filter: (src) => !src.endsWith('.ts'),
    })
    cpSync(resolve('src/core/recipes'), resolve('out/main/recipes'), {
      recursive: true,
      filter: (src) => !src.endsWith('.ts'),
    })
    cpSync(resolve('src/core/templates'), resolve('out/main/templates'), {
      recursive: true,
      filter: (src) => !src.endsWith('.ts'),
    })
  },
})

const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src'),
}

/**
 * The renderer's Content-Security-Policy as a <meta> in the built index.html: the policy is
 * src/main/csp.ts, which main also sends as a header with every built file. Production only: the dev server injects
 * inline scripts.
 */
const rendererCsp = (): Plugin => ({
  name: 'dim-factory-renderer-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
      injectTo: 'head-prepend',
    },
  ],
})

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [coreRuntimeFiles()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react(), tailwindcss(), rendererCsp()],
    // Diff tab: @pierre/diffs' Shiki worker is a module worker. It keeps a dynamic import of Shiki's Oniguruma
    // WASM build, which Dim Factory never asks for (the JavaScript regex engine is used), so the worker must be able to
    // split chunks: IIFE workers cannot. The worker script is an app file ('self' under the CSP).
    worker: { format: 'es' },
    build: {
      outDir: 'out/renderer',
      // electron-vite turns minification off for the renderer; a production bundle should be minified.
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
