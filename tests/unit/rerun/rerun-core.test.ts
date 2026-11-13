// Re-run plumbing ("Re-run loads resolved.json.config through ResolvedConfigZ", the scheduler and
// sessions, Re-run from Fix, R14): the settings check and the re-run equality (resolved-json.ts), the
// scheduler's take-over (a re-run queues at the head while its source still holds the folder), the findings choice
// (rerun.ts), the `runs.rerun` request (handlers-rerun.ts) and the CLI's wording.
import { describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { DimFactoryError } from '@core/errors.ts'
import { rerunHandlers, rerunRequestOf } from '@core/handlers-rerun.ts'
import {
  RESOLVED_RUN_FACTS,
  comparableResolved,
  rerunConfig,
  resolvedConfigWithPatches,
  sameResolvedSettings,
} from '@core/resolved-json.ts'
import { chosenFindings } from '@core/rerun.ts'
import { FolderScheduler } from '@core/supervisor/scheduler.ts'
import { RERUN_TEXT } from '@core/supervisor/rerun.ts'
import { rerunFromFixLine } from '../../../src/cli/commands/rerun.ts'
import { cancelledAtGate, completedFixed } from './helpers.ts'

const EM_DASH = '\u2014'

/** A resolved config as runs.start writes it (the built-in claude-only profile). */
function resolved(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    config: structuredClone(resolveBuiltinConfig({ profile: 'claude-only' })),
    provenance: { '/profile': { source: 'default' } },
    layerHashes: { user: 'u'.repeat(64), project: null },
    layers: {
      user: { path: 'C:/h/dimfactory.json', exists: true, sha256: 'u'.repeat(64) },
      project: null,
      run: {},
    },
    scopeRoot: 'C:/tmp/ts-small',
    folderKey: '0123456789abcdef',
    vendors: { claude: { route: 'stream-json', version: '2.1.288', capabilities: null, failingChecks: [] } },
    pricingRef: { sha: 'abc' },
    preflightWarnings: [],
    estimate: null,
    patches: [],
    ...over,
  }
}

describe('ResolvedConfigZ on a re-run’s settings (resolved-json.ts rerunConfig)', () => {
  it('a run’s resolved.json parses; its recovery patches are applied in order', () => {
    const doc = resolved({
      patches: [{ ops: [{ op: 'replace', path: '/timeouts/stallMs', value: 400000 }], label: 'x' }],
    })
    const r = rerunConfig(doc)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.timeouts.stallMs).toBe(400000)
  })

  it('tampered: mode "full" without auto is refused with where it is', () => {
    const doc = resolved()
    const cfg = doc['config'] as { passes: { implement: { mode: string } }; auto: boolean }
    cfg.passes.implement.mode = 'full'
    const r = rerunConfig(doc)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toBe(
        '/config/passes/implement/mode: mode "full" is only valid together with auto: true',
      )
      expect(r.issues[0]).toEqual({
        pointer: '/config/passes/implement/mode',
        message: 'mode "full" is only valid together with auto: true',
      })
    }
    // With auto (what `auto` itself produces) it is valid.
    cfg.auto = true
    expect(rerunConfig(doc).ok).toBe(true)
  })

  it('a read-only pass made mutating, or a damaged config, is refused', () => {
    const doc = resolved()
    ;(doc['config'] as { passes: { review: { mode: string } } }).passes.review.mode = 'autoedit'
    expect(rerunConfig(doc)).toMatchObject({
      ok: false,
      message: '/config/passes/review/mode: review must be read-only',
    })
    expect(rerunConfig({ config: { auto: true } }).ok).toBe(false)
    expect(rerunConfig({}).ok).toBe(false)
  })
})

describe('re-run equality (resolved.json equal except one run’s start facts)', () => {
  it('equal: a re-run writes the source’s settings and its own vendors, prices, warnings and rerunOf', () => {
    const src = resolved()
    const rerun = resolved({
      vendors: {
        claude: { route: 'stream-json', version: '2.1.300', capabilities: null, failingChecks: [] },
      },
      pricingRef: { sha: 'def' },
      preflightWarnings: [{ id: 'run.pricing' }],
      rerunOf: { runId: 'r1', displayNo: 1, from: 'start' },
    })
    expect(sameResolvedSettings(src, rerun)).toBe(true)
    expect(RESOLVED_RUN_FACTS).toEqual([
      'vendors',
      'pricingRef',
      'preflightWarnings',
      'estimate',
      'patches',
      'rerunOf',
    ])
  })

  it('a source’s patches are folded into its config (the re-run starts with them applied, patches [])', () => {
    const ops = [{ op: 'replace', path: '/passes/review/model', value: 'opus' }]
    const src = resolved({ patches: [{ ops, label: 'Use opus' }] })
    const applied = resolvedConfigWithPatches(src)
    const rerun = resolved({ config: applied, patches: [] })
    expect(sameResolvedSettings(src, rerun)).toBe(true)
    expect(
      (comparableResolved(src)['config'] as { passes: { review: { model: string } } }).passes.review.model,
    ).toBe('opus')
  })

  it('not equal: a setting, the run layer or where the settings came from differs', () => {
    const src = resolved()
    const other = resolved()
    ;(other['config'] as { gates: { afterPlan: boolean } }).gates.afterPlan = false
    expect(sameResolvedSettings(src, other)).toBe(false)
    expect(sameResolvedSettings(src, resolved({ layers: { run: { auto: true } } }))).toBe(false)
    expect(sameResolvedSettings(src, resolved({ provenance: {} }))).toBe(false)
    expect(sameResolvedSettings(src, resolved({ folderKey: 'fedcba9876543210' }))).toBe(false)
  })

  it('key order never matters', () => {
    const src = resolved()
    const reordered = Object.fromEntries(Object.entries(resolved()).reverse())
    expect(sameResolvedSettings(src, reordered)).toBe(true)
  })
})

describe('FolderScheduler.takeOverNext (R14: no other run takes the folder between the source and its re-run)', () => {
  it('the re-run queues at the head, ahead of a run already waiting behind the source', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    const granted: string[] = []
    s.request('source', 'c:\\repo', () => granted.push('source'))
    s.request('queued', 'c:\\repo\\sub', () => granted.push('queued'))
    s.takeOverNext('rerun')
    s.request('rerun', 'c:\\repo', () => granted.push('rerun'))
    expect(s.queued().map((q) => q.runId)).toEqual(['rerun', 'queued'])
    expect(s.blockedBy('queued')).toMatchObject({ runId: 'source', state: 'holder' })
    s.release('source')
    expect(granted).toEqual(['source', 'rerun'])
    expect(s.isHolder('rerun')).toBe(true)
    expect(s.blockedBy('queued')).toMatchObject({ runId: 'rerun', state: 'holder' })
    s.release('rerun')
    expect(granted).toEqual(['source', 'rerun', 'queued'])
  })

  it('only the next request: a later one queues at the end; a run that never requests is forgotten', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    s.request('a', 'c:\\repo', () => undefined)
    s.takeOverNext('x')
    s.release('x')
    s.request('b', 'c:\\repo', () => undefined)
    s.request('x', 'c:\\repo', () => undefined)
    expect(s.queued().map((q) => q.runId)).toEqual(['b', 'x'])
  })

  it('a free folder is granted at once', () => {
    const s = new FolderScheduler({ platform: 'win32', now: () => 1 })
    s.takeOverNext('rerun')
    expect(s.request('rerun', 'c:\\free', () => undefined)).toBe('granted')
  })
})

describe('the findings Fix gets (rerun.ts chosenFindings)', () => {
  it('default: every must and the shoulds the gate selected; a choice keeps the run’s list order', () => {
    const s = completedFixed({}, ['r2']).state
    expect(chosenFindings(s, undefined)).toEqual(['r1', 'r2'])
    expect(chosenFindings(s, ['r3', 'r1'])).toEqual(['r1', 'r3'])
  })

  it('an unknown id or an empty choice is VALIDATION', () => {
    const s = cancelledAtGate().state
    expect(() => chosenFindings(s, ['r9'])).toThrow(/has no finding r9/)
    try {
      chosenFindings(s, [])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DimFactoryError)
      expect((err as DimFactoryError).code).toBe('VALIDATION')
      expect((err as DimFactoryError).message).toBe(RERUN_TEXT.noneChosen)
    }
  })
})

describe('runs.rerun request (handlers-rerun.ts)', () => {
  it('validates runId, from and findingIds (fix only)', () => {
    expect(rerunRequestOf({ runId: 'a', from: 'start' })).toEqual({ runId: 'a', from: 'start' })
    expect(rerunRequestOf({ runId: 'a', from: 'fix', findingIds: ['F1'] })).toEqual({
      runId: 'a',
      from: 'fix',
      findingIds: ['F1'],
    })
    for (const bad of [
      null,
      {},
      { runId: '', from: 'start' },
      { runId: 'a', from: 'plan' },
      { runId: 'a', from: 'fix', findingIds: 'F1' },
      { runId: 'a', from: 'fix', findingIds: [''] },
      { runId: 'a', from: 'start', findingIds: ['F1'] },
    ]) {
      expect(() => rerunRequestOf(bad), JSON.stringify(bad)).toThrow(DimFactoryError)
    }
  })

  it('read-only cores refuse it; a core without the re-run answers UNSUPPORTED; else it goes to the core', async () => {
    const req = { runId: 'a', from: 'start' as const }
    await expect(rerunHandlers({ readOnly: true })['runs.rerun']?.(req)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(rerunHandlers({ readOnly: false })['runs.rerun']?.(req)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
    const seen: unknown[] = []
    const r = await rerunHandlers({
      readOnly: false,
      rerun: (x) => {
        seen.push(x)
        return Promise.resolve({ runId: 'b', displayNo: 2 })
      },
    })['runs.rerun']?.(req)
    expect(r).toEqual({ runId: 'b', displayNo: 2 })
    expect(seen).toEqual([req])
  })
})

describe('the CLI’s line for Re-run from Fix (dimf show / rerun)', () => {
  it('words fresh, reuse and not available like the app, without an em dash', () => {
    const lines = [
      rerunFromFixLine({ available: true, fresh: false, findingIds: ['F1', 'F2'] }),
      rerunFromFixLine({ available: true, fresh: true, reason: 'vendor-differs', findingIds: ['F1'] }),
      rerunFromFixLine({ available: false, fresh: true, unavailable: RERUN_TEXT.noFindings }),
    ]
    expect(lines).toEqual([
      'Fix would continue the Implement session; by default it gets 2 findings (F1, F2)',
      'Fix would start a fresh session (Fix vendor differs); by default it gets 1 finding (F1)',
      `not available: ${RERUN_TEXT.noFindings}`,
    ])
    for (const l of lines) expect(l).not.toContain(EM_DASH)
  })
})
