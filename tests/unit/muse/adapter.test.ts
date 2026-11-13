// The Muse adapter's contract surface (the "Muse exec" mode row: readonly unsupported; autoedit
// `--disable-approval` "sandbox-gated, never prompts; escalations fail" (degraded); full `--yolo`; plan emulated. No
// relay, Experimental, not in any built-in profile; it appears under "More").
import { describe, expect, it } from 'vitest'
import { AdapterRegistry, EXPERIMENTAL_VENDORS } from '@core/adapters/registry.ts'
import {
  MUSE_AUTOEDIT_COPY,
  MUSE_FULL_COPY,
  MUSE_NO_RELAY_NOTE,
  MUSE_READONLY_COPY,
  MUSE_REQUIRED_EXEC_FLAGS,
  museCapabilities,
  museEffectiveMode,
  museSupport,
} from '@core/adapters/muse/capabilities.ts'
import { createMuseAdapter } from '@core/adapters/muse/index.ts'
import { museArgv } from '@core/adapters/muse/launch.ts'
import { BUILTIN_PROFILES } from '@core/config/builtins.ts'
import { probeView } from '@core/handlers.ts'
import { PASS_NAMES } from '@shared/run.ts'
import type { Mode } from '@shared/run.ts'
import { FOLDER_TRUST_VENDORS, needsFolderTrust } from '@shared/vendors.ts'

const adapter = createMuseAdapter({
  env: {},
  dimFactoryHome: 'C:\\dim-factory-home-unused',
  search: 'configured',
})

describe('support(): the Muse mode row, the only source of its mode copy', () => {
  it.each(['plan', 'review', 'critic'] as const)(
    '%s is unsupported in any mode (no read-only exec)',
    (pass) => {
      for (const mode of ['readonly', 'autoedit', 'full'] as const) {
        expect(museSupport({ pass, mode })).toEqual({ status: 'unsupported', copy: MUSE_READONLY_COPY })
      }
    },
  )

  it('a read-only Plan stays unsupported even when the plan would be emulated', () => {
    expect(
      adapter.support({ pass: 'plan', mode: 'readonly', planNative: false, trustFolder: true }).status,
    ).toBe('unsupported')
    expect(
      adapter.support({ pass: 'plan', mode: 'readonly', planNative: true, trustFolder: true }).status,
    ).toBe('unsupported')
  })

  it('heal and the price refresh never run on Muse', () => {
    expect(museSupport({ pass: 'heal', mode: 'readonly' }).status).toBe('unsupported')
    expect(museSupport({ pass: 'catalog', mode: 'readonly' }).status).toBe('unsupported')
  })

  it('Implement and Fix: autoedit is degraded with the honest copy, full is --yolo (supported), readonly unsupported', () => {
    for (const pass of ['implement', 'fix'] as const) {
      expect(museSupport({ pass, mode: 'autoedit' })).toEqual({
        status: 'degraded',
        copy: MUSE_AUTOEDIT_COPY,
      })
      expect(museSupport({ pass, mode: 'full' })).toEqual({ status: 'supported', copy: MUSE_FULL_COPY })
      expect(museSupport({ pass, mode: 'readonly' }).status).toBe('unsupported')
    }
    expect(MUSE_AUTOEDIT_COPY.startsWith('Sandbox-gated, never prompts; escalations fail.')).toBe(true)
  })

  it('the autoedit copy claims only what the docs and the argv make true', () => {
    // dev.meta.ai/docs/muse-code/permissions: the sandbox confines writes to the workspace, reads pass anywhere; the
    // network is off because Dim Factory passes --sandbox-network restricted; a remembered Unrestricted profile versus the
    // flags is undocumented, so the copy says Dim Factory cannot check it.
    expect(MUSE_AUTOEDIT_COPY).toContain('write only in the folder')
    expect(MUSE_AUTOEDIT_COPY).toContain('reading files outside it is possible')
    expect(MUSE_AUTOEDIT_COPY).toContain('no network, which Dim Factory turns off')
    expect(MUSE_AUTOEDIT_COPY).toMatch(
      /Unrestricted, Muse may run without its sandbox: Dim Factory cannot check that yet/,
    )
    expect(MUSE_AUTOEDIT_COPY).not.toMatch(/files outside the folder\) fails/)
    expect(
      museArgv({ promptFile: 'f.md', step: 'implement', mode: 'autoedit', trust: true }).join(' '),
    ).toContain('--disable-approval --sandbox-network restricted')
    expect(museArgv({ promptFile: 'f.md', step: 'implement', mode: 'full', trust: true })).not.toContain(
      '--sandbox-network',
    )
    // The probe fails (flag_drift) when exec cannot take it, rather than a pass failing on an unknown flag.
    expect(MUSE_REQUIRED_EXEC_FLAGS).toContain('--sandbox-network')
  })

  it('every edit copy says asks are not relayed and the stall timer is the safety net (the PassCard shows it)', () => {
    expect(MUSE_NO_RELAY_NOTE).toMatch(/not relayed/)
    expect(MUSE_NO_RELAY_NOTE).toMatch(/stall timer/)
    for (const copy of [MUSE_AUTOEDIT_COPY, MUSE_FULL_COPY]) expect(copy).toContain(MUSE_NO_RELAY_NOTE)
    expect(MUSE_FULL_COPY).toMatch(/Auto only/)
  })

  it('no copy carries an em dash or a reason code', () => {
    for (const pass of [...PASS_NAMES, 'heal', 'catalog'] as const) {
      for (const mode of ['readonly', 'autoedit', 'full'] as Mode[]) {
        const s = museSupport({ pass, mode })
        expect(s.copy).not.toContain('\u2014')
        expect(s.reason).toBeUndefined()
      }
    }
  })

  it('effective mode: read-only steps are readonly whatever the config says', () => {
    expect(museEffectiveMode('review', 'full')).toBe('readonly')
    expect(museEffectiveMode('implement', 'full')).toBe('full')
    expect(museEffectiveMode('fix', 'readonly')).toBe('readonly')
  })
})

describe('capabilities', () => {
  it('no relay, emulated plan, Fix always fresh, a static model list', () => {
    expect(museCapabilities()).toEqual({
      planMode: 'emulated',
      askRelay: false,
      resume: 'none',
      preassignSessionId: false,
      modelList: 'static',
      usageCumulative: false,
      allowSession: 'app',
      web: false,
      resumeModelSwitch: false,
      resumeModeSwitch: false,
      reasoningIncludedInOutput: true,
      effort: false,
      modes: {
        readonly: museSupport({ pass: 'implement', mode: 'readonly' }),
        autoedit: museSupport({ pass: 'implement', mode: 'autoedit' }),
        full: museSupport({ pass: 'implement', mode: 'full' }),
      },
    })
  })

  it('canResume always says cannot-resume, and answer() is a no-op (nothing to answer)', async () => {
    await expect(adapter.canResume('0199d2a0-4c1e-7a3b-8d5f-6e7a8b9c0001', '/x')).resolves.toEqual({
      ok: false,
      reason: 'cannot-resume',
    })
    expect(() => adapter.answer({} as never, 'r1', 'allow')).not.toThrow()
  })

  it('lists its static default model', async () => {
    await expect(adapter.listModels()).resolves.toEqual([
      { id: 'muse-spark-1.2', label: 'Muse Spark 1.2', isDefault: true, source: 'static' },
    ])
  })
})

describe('the registry entry: Experimental, under "More", not in a built-in profile', () => {
  it("replaces the stub with transport 'muse-exec' and the managed flags", () => {
    expect(adapter).toMatchObject({ id: 'muse', displayName: 'Muse', transport: 'muse-exec' })
    expect(adapter.managedFlags).toEqual([
      '--json',
      '--prompt-file',
      '--model',
      '--trust-workspace',
      '--disable-approval',
      '--sandbox-network',
      '--yolo',
      '--session-id',
    ])
    const r = new AdapterRegistry()
    expect(r.isBuilt('muse')).toBe(false)
    r.register(adapter, { experimental: true })
    expect(r.isBuilt('muse')).toBe(true)
    const entry = r.list().find((e) => e.id === 'muse')
    expect(entry).toMatchObject({ built: true, experimental: true, section: 'more' })
    expect(r.more().map((e) => e.id)).toContain('muse')
    expect(EXPERIMENTAL_VENDORS).toContain('muse')
    expect(probeView(r, 'muse', null)).toMatchObject({ built: true, experimental: true, displayName: 'Muse' })
  })

  it('no built-in profile names Muse', () => {
    expect(JSON.stringify(BUILTIN_PROFILES)).not.toContain('muse')
  })

  it('Muse needs the vendorFolder grant (Readiness trust)', () => {
    expect(needsFolderTrust('muse')).toBe(true)
    expect(FOLDER_TRUST_VENDORS).toContain('muse')
  })
})
