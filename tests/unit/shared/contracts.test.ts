// Small runtime helpers and constant sets in vendors / preflight / estimates / catalog.
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CATALOG_DIFF_FLAGS, PRICE_FIELDS } from '@shared/catalog.ts'
import type { CatalogEventState, PriceEntry, CATALOG_JOB_STATES } from '@shared/catalog.ts'
import { COST_BASES, STATS_RANGES } from '@shared/estimates.ts'
import type { AttentionItem, CostBasis, Estimate, ATTENTION_KINDS } from '@shared/estimates.ts'
import {
  CHECK_SCOPES,
  VENDOR_CHECKS,
  passCheckId,
  readinessCheckId,
  vendorCheckId,
} from '@shared/preflight.ts'
import type { CheckResult } from '@shared/preflight.ts'
import {
  KNOWN_VENDORS,
  ROUTES,
  TRANSPORTS,
  TRANSPORT_ROUTE,
  VENDOR_ID_PATTERN,
  isKnownVendor,
  localPresetIdOf,
} from '@shared/vendors.ts'
import type { Mode } from '@shared/run.ts'
import type { Capabilities, Support } from '@shared/vendors.ts'

describe('vendors', () => {
  it('knows the planned vendors and keeps ids open', () => {
    expect(KNOWN_VENDORS).toEqual(['claude', 'codex', 'gemini', 'grok', 'muse'])
    expect(isKnownVendor('codex')).toBe(true)
    expect(isKnownVendor('cursor')).toBe(false)
    for (const id of [...KNOWN_VENDORS, 'local-ollama', 'cursor', 'open-code'])
      expect(id).toMatch(VENDOR_ID_PATTERN)
    for (const id of ['Claude', 'x', '1abc', 'a_b']) expect(id).not.toMatch(VENDOR_ID_PATTERN)
  })

  it('maps local-<preset> vendors to preset ids', () => {
    expect(localPresetIdOf('local-ollama')).toBe('ollama')
    expect(localPresetIdOf('local-')).toBeNull()
    expect(localPresetIdOf('codex')).toBeNull()
  })

  it('maps every transport to a route', () => {
    expect(Object.keys(TRANSPORT_ROUTE).sort()).toEqual([...TRANSPORTS].sort())
    for (const r of Object.values(TRANSPORT_ROUTE)) expect(ROUTES).toContain(r)
  })

  it('keys mode support by every mode', () => {
    expectTypeOf<keyof Capabilities['modes']>().toEqualTypeOf<Mode>()
    expectTypeOf<Capabilities['modes']['full']>().toEqualTypeOf<Support>()
  })
})

describe('preflight', () => {
  it('builds check ids as <scope>.<subject>.<check>', () => {
    expect(vendorCheckId('codex', 'winSandbox')).toBe('vendor.codex.winSandbox')
    expect(passCheckId('review', 'mode')).toBe('pass.review.mode')
    expect(readinessCheckId('implement', 'trust')).toBe('pass.implement.readiness.trust')
    expect(VENDOR_CHECKS).toEqual(['bin', 'version', 'auth', 'protocol', 'plan', 'winSandbox', 'env'])
    expect(CHECK_SCOPES).toEqual(['app', 'vendor', 'folder', 'run', 'pass'])
  })

  it('carries recovery actions on every check result', () => {
    const r: CheckResult = {
      id: 'vendor.claude.auth',
      scope: 'vendor',
      status: 'fail',
      blocking: true,
      category: 'auth_required',
      title: 'Claude is not logged in',
      detail: 'claude auth status exited 1',
      recovery: [
        {
          id: 'login',
          label: 'Copy login command',
          kind: 'shell_copy',
          command: 'claude auth login',
          shell: 'powershell',
          reason: 'Sign in to Claude Code',
          recheck: 'vendor.claude.auth',
        },
      ],
      at: 0,
      ttlMs: 600_000,
    }
    expect(r.recovery[0]?.kind).toBe('shell_copy')
  })
})

describe('estimates and catalog', () => {
  it('declares the single CostBasis spelling', () => {
    expectTypeOf<CostBasis>().toEqualTypeOf<'vendor' | 'catalog' | 'none'>()
    expect(COST_BASES).toEqual(['vendor', 'catalog', 'none'])
    expectTypeOf<Estimate['durationMs']>().toEqualTypeOf<{ p50: number; p80: number }>()
    expectTypeOf<Estimate['costUsd']>().toEqualTypeOf<{ p50: number; p80: number } | null>()
    expect(STATS_RANGES).toContain('7d')
  })

  it('narrows attention items by kind', () => {
    expectTypeOf<AttentionItem['kind']>().toEqualTypeOf<(typeof ATTENTION_KINDS)[number]>()
    const item: AttentionItem = {
      id: 'a',
      runId: 'r',
      displayNo: 3,
      title: 't',
      folder: 'C:\\x',
      since: 0,
      kind: 'failed',
      step: 'implement',
      category: 'quota_exceeded',
    }
    expect(item.kind === 'failed' ? item.category : null).toBe('quota_exceeded')
  })

  it('flags catalog diff rows with the planned flags', () => {
    for (const f of [
      'suspicious',
      'unofficial',
      'notReportedByCli',
      'userEdited',
      'bigChange',
      'deprecated',
    ] as const) {
      expect(CATALOG_DIFF_FLAGS).toContain(f)
    }
    expect(PRICE_FIELDS).toEqual(['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'])
    expectTypeOf<CatalogEventState>().toEqualTypeOf<'due' | (typeof CATALOG_JOB_STATES)[number]>()
    expectTypeOf<PriceEntry['confidence']>().toEqualTypeOf<'verified' | 'unverified' | 'user'>()
  })
})
