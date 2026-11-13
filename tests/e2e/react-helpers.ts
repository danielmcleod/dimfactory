// The web starter (React) in E2E, with no network: a project folder gets the packages its package.json names from
// Dim Factory's own node_modules (each a directory junction or link, never a copy, never downloaded) and a .bin shim for
// each program its scripts run, so the real `npm run test`, `npm run build` and `npm run dev` work offline. Vite's and
// Vitest's caches land in the project's own node_modules (a real folder), never in Dim Factory's. Also a realistic
// sample site's words (tests/fixtures/web/bakery-content.ts.txt), written where the starter keeps them.
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { REPO_ROOT } from '../integration/run/scenario.ts'

const PACKAGES = [
  'react',
  'react-dom',
  'scheduler',
  'vite',
  'vitest',
  'happy-dom',
  'typescript',
  '@vitejs',
  '@testing-library',
  '@types',
]
const BINS: Readonly<Record<string, string>> = {
  vite: 'vite/bin/vite.js',
  vitest: 'vitest/vitest.mjs',
  tsc: 'typescript/bin/tsc',
}

/** Link the packages the web starter needs into `project`'s node_modules, with shims for vite, vitest and tsc. */
export function linkReactDeps(project: string): void {
  const nm = join(project, 'node_modules')
  mkdirSync(join(nm, '.bin'), { recursive: true })
  for (const p of PACKAGES) {
    mkdirSync(dirname(join(nm, p)), { recursive: true })
    symlinkSync(join(REPO_ROOT, 'node_modules', p), join(nm, p), 'junction')
  }
  for (const [name, rel] of Object.entries(BINS)) {
    writeFileSync(join(nm, '.bin', `${name}.cmd`), `@node "%~dp0\\..\\${rel.split('/').join('\\')}" %*\r\n`)
    writeFileSync(join(nm, '.bin', name), `#!/bin/sh\nexec node "$(dirname "$0")/../${rel}" "$@"\n`, {
      mode: 0o755,
    })
  }
}

/** The sample site's words (a neighbourhood bakery), as the starter's src/content.ts. */
export const BAKERY_CONTENT = readFileSync(
  join(REPO_ROOT, 'tests', 'fixtures', 'web', 'bakery-content.ts.txt'),
  'utf8',
)

export const BAKERY_IDEA =
  'A website for Bramble & Rye, our neighbourhood bakery in Leeds: sourdough, seasonal bakes and a sign-up form for our weekly newsletter.'

/** Copy the web starter's files (without their .txt) into `dir`, as the template would (for a staged sample). */
export function stageStarter(dir: string): void {
  const src = join(REPO_ROOT, 'src', 'core', 'templates', 'vendor', 'starter', 'react')
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })
  for (const f of walk(src)) {
    const rel = relative(src, f).replace(/\.txt$/, '')
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), readFileSync(f))
  }
}
