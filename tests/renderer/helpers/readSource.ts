// Read a repository file as text in a renderer test. Vitest empties CSS imports (even `?raw`), and the web tsconfig
// has no Node types, so this reaches node:fs through process.getBuiltinModule with a local type.
type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
type NodeProcess = { getBuiltinModule(id: 'node:fs'): Fs }

// Not inlined into `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset lookup.
const here = import.meta.url

/** `path` is relative to the repository root, e.g. `src/renderer/src/styles/tokens.css`. */
export function readSource(path: string): string {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  return proc.getBuiltinModule('node:fs').readFileSync(new URL(`../../../${path}`, here), 'utf8')
}
