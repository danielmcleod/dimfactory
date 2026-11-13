// Shared helpers for the verify tests: fixture folders written into a temp directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A fixture folder: relative path → file text. */
export type Files = Readonly<Record<string, string>>

export function writeFiles(root: string, files: Files): void {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

export function tempDir(prefix = 'dim-factory-verify-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ name: 'fixture', version: '1.0.0', ...extra, scripts }, null, 2)}\n`
