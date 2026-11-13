// The dependency and build output folders the plan-end guard leaves out.
import { describe, expect, it } from 'vitest'
import { isGeneratedPath } from '@shared/generated-paths.ts'

describe('isGeneratedPath', () => {
  it('a path inside a dependency, cache or build output folder, at any depth', () => {
    for (const p of [
      'node_modules/.bin/tsc',
      'node_modules\\.bin\\vite.cmd',
      'web/node_modules/react/index.js',
      '.venv/Lib/site.py',
      'pkg/__pycache__/a.pyc',
      'dist/index.html',
      'app/.next/cache/x',
      'target/debug/app',
    ])
      expect(isGeneratedPath(p), p).toBe(true)
  })

  it('source files, including ones named like an output folder', () => {
    for (const p of [
      'src/App.tsx',
      'package.json',
      'package-lock.json',
      'dist',
      'docs/node_modules.md',
      'build.ts',
    ])
      expect(isGeneratedPath(p), p).toBe(false)
  })
})
