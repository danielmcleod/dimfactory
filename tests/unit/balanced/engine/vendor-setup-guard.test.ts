// Guard: the Codex sandbox setup runs only from a user's click (recovery actions: vendor_setup "runs
// on click"; "vendor_setup runs ONLY from a user click"). The only way in is
// `recovery.execute` (handlers-recovery.ts → dispatcher.ts executeAction → recovery/vendor-setup.ts runVendorSetup →
// the adapter's vendorSetup). Nothing in a run, Auto mode, the healer or the scheduler calls those, and a healer's
// answer can never carry a vendor_setup action.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import { healViewOf } from '@core/recovery/heal-api.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CORE = join(ROOT, 'src', 'core')

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Core files (outside the Codex adapter, which implements the call) whose code matches `re`. */
function callers(re: RegExp): string[] {
  return files(CORE)
    .map((f) => relative(CORE, f).split(sep).join('/'))
    .filter((f) => !f.startsWith('adapters/codex/'))
    .filter((f) => {
      const code = readFileSync(join(CORE, f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      return re.test(code)
    })
    .sort()
}

describe('vendor_setup is reachable only through recovery.execute', () => {
  it('only the recovery handler wires the adapter’s setup', () => {
    expect(callers(/\.vendorSetup\(/)).toEqual(['handlers-recovery.ts'])
  })

  it('only the dispatcher runs the setup, and only recovery.execute calls the dispatcher', () => {
    expect(callers(/\brunVendorSetup\(/)).toEqual(['recovery/dispatcher.ts', 'recovery/vendor-setup.ts'])
    expect(callers(/\bexecuteAction\(/)).toEqual(['handlers-recovery.ts', 'recovery/dispatcher.ts'])
  })

  it('a healer’s suggestion can never be a vendor_setup (hidden, counted)', () => {
    const setup: RecoveryAction = {
      id: 'x',
      label: 'Set up the sandbox',
      kind: 'vendor_setup',
      vendor: 'codex',
      call: 'windowsSandbox/setupStart',
      params: { mode: 'unelevated' },
    }
    const view = healViewOf(
      {
        status: 'ok',
        at: 1,
        actions: [setup],
        hidden: 0,
        diagnosis: 'd',
        confidence: 'low',
        category: 'unknown',
      },
      'auto',
      { step: 'implement', managedFlags: {} },
    )
    expect(view.actions).toEqual([])
    expect(view.hidden).toBe(1)
  })
})
