// Loosening your guardrails goes on record in trust.json, and a folder's view says where each rule in force comes from.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOOSENED_KEEP,
  readGuardrailLoosening,
  readTrustFile,
  recordGuardrailLoosening,
} from '../../src/core/config/trust.ts'
import { homePaths } from '../../src/core/home.ts'
import type { GuardrailRule, Guardrails } from '../../src/shared/guardrails.ts'
import { guardrailsInForce, loosenedBetween } from '../../src/shared/guardrails.ts'

const push: GuardrailRule = { kind: 'forbiddenCommand', argvPrefix: ['terraform', 'apply'] }
const env: GuardrailRule = { kind: 'privateFiles', paths: ['.env*'] }

describe('what a change loosened', () => {
  it('names a lowered preset and each rule taken away', () => {
    expect(
      loosenedBetween({ preset: 'strict', rules: [push, env] }, { preset: 'recommended', rules: [env] }),
    ).toEqual(['Preset lowered from Strict to Recommended', 'Removed Forbidden command: terraform apply'])
  })

  it('names the settings exception', () => {
    expect(
      loosenedBetween({ preset: 'off', rules: [] }, { preset: 'off', rules: [], allowAgentSettings: true }),
    ).toEqual(['Runs may change agent settings files'])
  })

  it('is empty when a change only tightens', () => {
    expect(loosenedBetween({ preset: 'off', rules: [] }, { preset: 'strict', rules: [push] })).toEqual([])
    expect(loosenedBetween({}, {})).toEqual([])
  })
})

describe('the record in trust.json', () => {
  const home = (): string => mkdtempSync(join(tmpdir(), 'loosened-home-'))

  it('keeps each loosening with its date, beside the folder grants', async () => {
    const h = home()
    writeFileSync(
      homePaths(h).trust,
      JSON.stringify({
        schemaVersion: 1,
        folders: {
          '0123456789abcdef': { path: 'C:\\w', grants: { largeFolder: { at: 1, files: 1, bytes: 1 } } },
        },
      }),
    )
    await recordGuardrailLoosening(['Removed Private files: .env*'], { home: h, now: () => 42 })
    await recordGuardrailLoosening([], { home: h, now: () => 43 })
    expect(await readGuardrailLoosening({ home: h })).toEqual([
      { at: 42, what: 'Removed Private files: .env*' },
    ])
    const { file } = await readTrustFile({ home: h })
    expect(Object.keys(file.folders)).toEqual(['0123456789abcdef'])
    expect(JSON.parse(readFileSync(homePaths(h).trust, 'utf8'))).toHaveProperty('guardrails.loosened')
  })

  it('keeps only the newest records', async () => {
    const h = home()
    const many = Array.from({ length: LOOSENED_KEEP + 5 }, (_, i) => `Removed rule ${i}`)
    await recordGuardrailLoosening(many, { home: h, now: () => 1 })
    const kept = await readGuardrailLoosening({ home: h })
    expect(kept).toHaveLength(LOOSENED_KEEP)
    expect(kept.at(-1)?.what).toBe(`Removed rule ${LOOSENED_KEEP + 4}`)
  })

  it('reads nothing from a missing file', async () => {
    expect(await readGuardrailLoosening({ home: home() })).toEqual([])
  })
})

describe('where each rule in force comes from', () => {
  it('names settings files, the preset, your rules and the project', () => {
    const user: Guardrails = { preset: 'recommended', rules: [push] }
    const merged: Guardrails = { preset: 'strict', rules: [push, env] }
    const r = guardrailsInForce(user, merged)
    expect(r.preset).toBe('strict')
    expect(r.presetFrom).toBe('project')
    expect(r.rules[0]).toEqual({ label: 'Settings files', kind: 'self', from: 'always' })
    expect(r.rules.find((x) => x.kind === 'requireIsolated')?.from).toBe('preset')
    expect(r.rules.find((x) => x.label === 'Forbidden command: terraform apply')?.from).toBe('user')
    expect(r.rules.find((x) => x.kind === 'privateFiles')?.from).toBe('project')
  })

  it('names your preset when the project did not raise it', () => {
    const g: Guardrails = { preset: 'recommended', rules: [] }
    expect(guardrailsInForce(g, g).presetFrom).toBe('user')
  })
})
