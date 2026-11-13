// scripts/gen-codex-types.mjs (types generated with generate-ts, committed under protocol/v0.160.0/,
// diffed weekly in CI): version parsing, the methods inventory, and what the weekly diff calls breaking.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMITTED_BUNDLE } from '../../../../scripts/codex-fixture-check.mjs'
import type { CompareResult } from '../../../../scripts/gen-codex-types.mjs'
import {
  compareGenerated,
  methodsInventory,
  parseCodexVersion,
  reportMarkdown,
} from '../../../../scripts/gen-codex-types.mjs'
import { METHODS, SCHEMA_BUNDLE_FILE, WATCHED_TYPES } from '../../../../src/core/adapters/codex/protocol.ts'

type Json = Record<string, unknown>
const SCRIPT = fileURLToPath(new URL('../../../../scripts/gen-codex-types.mjs', import.meta.url))
const bundleText = readFileSync(COMMITTED_BUNDLE, 'utf8')
const fresh = (): Json => JSON.parse(bundleText) as Json
const def = (b: Json, name: string): Json => {
  const defs = b['definitions'] as Json
  return (defs[name] ?? (defs['v2'] as Json)[name]) as Json
}

/** A minimal generated folder: one TS file and the schema bundle. */
function folder(
  bundle: Json,
  files: Record<string, string> = { 'Thread.ts': '// GENERATED CODE!\n' },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-gen-'))
  mkdirSync(join(dir, 'schema'))
  writeFileSync(join(dir, 'schema', SCHEMA_BUNDLE_FILE), JSON.stringify(bundle))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  writeFileSync(join(dir, 'meta.json'), '{"cliVersion":"x"}\n')
  return dir
}

const report = (r: CompareResult): string =>
  reportMarkdown(r, { cliVersion: '0.161.0', committedVersion: '0.160.1', folder: 'v0.160.0' })

describe('parseCodexVersion', () => {
  it.each([
    ['codex-cli 0.160.1', '0.160.1'],
    ['codex-cli 0.147.0-alpha.6.5\n', '0.147.0-alpha.6.5'],
    ['WARNING: something\ncodex-cli 0.162.0-alpha.15', '0.162.0-alpha.15'],
  ])('%j → %s', (text, version) => {
    expect(parseCodexVersion(text)).toBe(version)
  })

  it.each(['2.1.289 (Claude Code)', 'codex 0.160.1', ''])('%j is not a Codex CLI', (text) => {
    expect(parseCodexVersion(text)).toBeNull()
  })
})

describe('methodsInventory', () => {
  it('lists every method by direction and flags what the stable schema lacks', () => {
    const b = fresh()
    const stable = fresh()
    const root = def(stable, 'ClientRequest')
    root['oneOf'] = (root['oneOf'] as Json[]).filter(
      (v) => !(((v['properties'] as Json)['method'] as Json)['enum'] as string[]).includes('model/list'),
    )
    const inv = methodsInventory(b, stable)
    expect(inv.clientRequests.find((m) => m.method === 'model/list')).toEqual({
      method: 'model/list',
      experimental: true,
    })
    expect(inv.clientRequests.find((m) => m.method === 'turn/start')).toEqual({
      method: 'turn/start',
      experimental: false,
    })
    expect(Object.keys(inv.fields)).toEqual([...WATCHED_TYPES])
    for (const m of METHODS)
      expect(
        inv[m.set].some((r) => r.method === m.method),
        m.method,
      ).toBe(true)
  })
})

describe('compareGenerated: what the weekly type diff calls breaking', () => {
  it('identical output: no difference', () => {
    const r = compareGenerated(folder(fresh()), folder(fresh()))
    expect(r).toMatchObject({ different: false, breaking: false, missingRequired: [], newShapeProblems: [] })
    expect(report(r)).toContain('No difference.')
  })

  it('a new file or method only: different, not breaking', () => {
    const b = fresh()
    const root = def(b, 'ClientRequest')
    const extra = structuredClone((root['oneOf'] as Json[])[0]!)
    ;((extra['properties'] as Json)['method'] as Json)['enum'] = ['thread/brandNew']
    ;(root['oneOf'] as Json[]).push(extra)
    const r = compareGenerated(
      folder(fresh()),
      folder(b, { 'Thread.ts': '// GENERATED CODE!\n', 'New.ts': 'x' }),
    )
    expect(r.different).toBe(true)
    expect(r.breaking).toBe(false)
    expect(r.files.added).toEqual(['New.ts'])
    expect(r.methods.added).toEqual(['clientRequests: thread/brandNew'])
    expect(report(r)).toContain('nothing Dim Factory requires changed')
  })

  it('a description-only change of a watched type is reported, not breaking', () => {
    const b = fresh()
    def(b, 'TurnStartParams')['description'] = 'reworded'
    const r = compareGenerated(folder(fresh()), folder(b))
    expect(r.watchedChanged).toEqual(['TurnStartParams'])
    expect(r.breaking).toBe(false)
  })

  it('a required method gone: breaking', () => {
    const b = fresh()
    const root = def(b, 'ServerNotification')
    root['oneOf'] = (root['oneOf'] as Json[]).filter(
      (v) => !(((v['properties'] as Json)['method'] as Json)['enum'] as string[]).includes('turn/completed'),
    )
    const r = compareGenerated(folder(fresh()), folder(b))
    expect(r.breaking).toBe(true)
    expect(r.missingRequired).toEqual(['turn/completed'])
    expect(r.methods.removed).toEqual(['serverNotifications: turn/completed'])
    expect(report(r)).toMatch(
      /\*\*Breaking for Dim Factory\.\*\*[\s\S]*Required methods missing: turn\/completed/,
    )
  })

  it('a property Dim Factory sends gone: breaking, named in the report', () => {
    const b = fresh()
    delete (def(b, 'TurnStartParams')['properties'] as Json)['outputSchema']
    const r = compareGenerated(folder(fresh()), folder(b))
    expect(r.newShapeProblems).toEqual(['TurnStartParams.outputSchema: property removed'])
    expect(r.breaking).toBe(true)
    expect(report(r)).toContain(
      'Shapes Dim Factory relies on broke: TurnStartParams.outputSchema: property removed',
    )
  })

  it('no schema bundle in the new output: breaking', () => {
    const empty = mkdtempSync(join(tmpdir(), 'codex-gen-empty-'))
    const r = compareGenerated(folder(fresh()), empty)
    expect(r.breaking).toBe(true)
    expect(r.missingRequired[0]).toMatch(/no codex_app_server_protocol\.schemas\.json/)
  })
})

describe('the script', () => {
  it('--help prints the usage; an unknown flag is a usage error (exit 2), and nothing is generated', () => {
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', timeout: 30_000 })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--check generates into a temp dir')
    const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8', timeout: 30_000 })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('unknown argument --nope')
  })
})
