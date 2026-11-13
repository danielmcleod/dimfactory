// The Gemini renderer fixtures speak core's words ("Mode mapping and honest copy": `support().copy` is the
// ONLY source of mode copy; the Gemini probe checks; readiness `trust`; the commands table), checked against core's text.
import { describe, expect, it } from 'vitest'
import {
  GEMINI_COPY,
  GEMINI_INSTALL,
  GEMINI_RECOMMENDED,
  GEMINI_TESTED_UP_TO,
  INSTALL_ACTION,
  LOGIN_ACTION,
  NO_ACP_DETAIL,
  NOT_SIGNED_IN_DETAIL,
  TRUST_ACTION_DETAIL,
  TRUST_ACTION_ID,
  TRUST_CHECK_DETAIL,
  TRUST_CHECK_TITLE,
  UPDATE_ACTION,
} from './fixtures.ts'

type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
// Not inlined into `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset lookup.
const here = import.meta.url

/**
 * A core source as text: string literals joined by `+` read as one, and the vendor's name and id put where core's
 * templates take them from the config (`${cfg.displayName}`, `${name}`, `${cfg.id}`), as core renders them for Gemini.
 */
function coreText(rel: string): string {
  const fs = (
    globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }
  ).process.getBuiltinModule('node:fs')
  const text = fs.readFileSync(new URL(`../../../src/core/${rel}`, here), 'utf8')
  return text
    .replace(/'\s*\+\s*'/g, '')
    .split('${cfg.displayName}')
    .join('Gemini')
    .split('${name}')
    .join('Gemini')
    .split('${GEMINI_DISPLAY_NAME}')
    .join('Gemini')
    .split('${cfg.id}')
    .join('gemini')
}

describe('the fixtures use core’s Gemini words', () => {
  it('mode copy and versions: src/core/adapters/gemini/config.ts', () => {
    const core = coreText('adapters/gemini/config.ts')
    for (const s of Object.values(GEMINI_COPY)) expect(core.includes(s), s).toBe(true)
    expect(core).toContain(`VERSION_RECOMMENDED = '${GEMINI_RECOMMENDED}'`)
    expect(core).toContain(`TESTED_UP_TO = '${GEMINI_TESTED_UP_TO}'`)
    expect(core).toContain("VERSION_FLOOR = ''")
  })

  it('the readiness trust check and its grant: src/core/adapters/acp-base/index.ts', () => {
    const core = coreText('adapters/acp-base/index.ts')
    for (const s of [
      TRUST_CHECK_TITLE,
      TRUST_CHECK_DETAIL,
      TRUST_ACTION_DETAIL,
      'Trust this folder for Gemini',
    ])
      expect(core.includes(s), s).toBe(true)
    expect(core).toContain(`\`${TRUST_ACTION_ID}\``)
    expect(core).toContain("grant: 'vendorFolder'")
  })

  it('install, update and sign-in: src/core/adapters/acp-base/probe.ts, gemini/auth.ts, heal/commands.ts', () => {
    const probe = coreText('adapters/acp-base/probe.ts')
    expect(probe).toContain(`\`${INSTALL_ACTION.id}\``)
    expect(probe).toContain(`\`${UPDATE_ACTION.id}\``)
    expect(probe).toContain(INSTALL_ACTION.label)
    expect(probe).toContain(UPDATE_ACTION.label)
    expect(probe).toContain('cannot talk to Dim Factory')
    const [before, after] = NO_ACP_DETAIL.split('--acp')
    expect(probe).toContain(`${before ?? ''}\${missing.join(', ')}${after ?? ''}`)
    const auth = coreText('adapters/gemini/auth.ts')
    expect(auth).toContain(`'${LOGIN_ACTION.id}'`)
    expect(auth).toContain(`'${LOGIN_ACTION.label}'`)
    expect(auth).toContain(NOT_SIGNED_IN_DETAIL)
    expect(auth).toContain('Gemini is not signed in')
    expect(coreText('heal/commands.ts')).toContain(`'${GEMINI_INSTALL}'`)
  })
})
