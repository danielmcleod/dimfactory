// The Codex renderer fixtures speak core's words ("Mode mapping and honest copy": `support().copy` is the
// ONLY source of mode copy; the sandbox procedure X11c's elevated command). The renderer project's types have no Node,
// so the fixtures copy core's strings (tests/renderer/codex/fixtures.ts); this reads core's sources as text and checks
// every copied string is there word for word, so a change in core's copy fails here rather than drifting.
import { describe, expect, it } from 'vitest'
import {
  APP_SERVER_COPY,
  ELEVATED_COMMAND,
  EXEC_COPY,
  WIN_SANDBOX_AUTOEDIT_COPY,
  WIN_SANDBOX_FULL_COPY,
  WIN_SANDBOX_READONLY_COPY,
  WIN_SANDBOX_SETUP_DETAIL,
} from './fixtures.ts'

type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
// Not inlined into `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset lookup.
const here = import.meta.url

/** A core source as text, with string literals joined by `+` read as one. */
function coreText(rel: string): string {
  const fs = (
    globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }
  ).process.getBuiltinModule('node:fs')
  const text = fs.readFileSync(new URL(`../../../src/core/${rel}`, here), 'utf8')
  return text.replace(/'\s*\+\s*'/g, '')
}

describe('the fixtures use core’s Codex words', () => {
  it('mode copy: src/core/adapters/codex/capabilities.ts', () => {
    const core = coreText('adapters/codex/capabilities.ts')
    const strings = [
      ...Object.values(APP_SERVER_COPY),
      EXEC_COPY.autoedit,
      WIN_SANDBOX_READONLY_COPY,
      WIN_SANDBOX_AUTOEDIT_COPY,
      WIN_SANDBOX_FULL_COPY,
    ]
    for (const s of strings) expect(core.includes(s), s).toBe(true)
  })

  it('the sandbox check detail: src/core/adapters/codex/probe.ts (plain words)', () => {
    const core = coreText('adapters/codex/probe.ts')
    expect(core).toContain("'The Codex Windows sandbox is not set up.'")
    expect(WIN_SANDBOX_SETUP_DETAIL.startsWith('The Codex Windows sandbox is not set up. ')).toBe(true)
    expect(core).toContain(WIN_SANDBOX_SETUP_DETAIL.slice('The Codex Windows sandbox is not set up. '.length))
  })

  it('the elevated sandbox command: src/core/heal/commands.ts', () => {
    expect(coreText('heal/commands.ts')).toContain(`'${ELEVATED_COMMAND}'`)
  })
})
