// Coverage: "Diagnose with AI" for a vendor or app check, outside any run (self-heal and
// the `heal` executor; Settings → Vendors and the setup card). The check's own words are the failure the healer
// sees (never a prompt or a log), only the healer's safe suggestions are offered, each under a fresh id that the
// next `recovery.execute` can find (and a later diagnosis never takes over). The healer and the core are stubs.
import { describe, expect, it, vi } from 'vitest'
import { createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { RecoveryHost } from '@core/handlers-recovery.ts'
import type { HealOutcome, HealRequest } from '@core/heal/healer.ts'
import { RecoveryActionStore } from '@core/recovery/store.ts'
import type { RecoveryAction } from '@shared/failure.ts'
import type { CheckResult } from '@shared/preflight.ts'

const HEAL_ID = 'vendor.claude.auth:heal'

const authCheck: CheckResult = {
  id: 'vendor.claude.auth',
  scope: 'vendor',
  status: 'fail',
  blocking: true,
  category: 'auth_required',
  title: 'Claude is signed out',
  detail: 'Claude Code reported loggedIn false.',
  recovery: [{ id: HEAL_ID, label: 'Diagnose with AI', kind: 'heal' }],
  at: 0,
  ttlMs: 0,
}

const SUGGESTED: RecoveryAction[] = [
  {
    id: 'x1',
    label: 'Sign in to Claude',
    kind: 'shell_copy',
    command: 'claude auth login',
    shell: 'sh',
    reason: 'Claude is signed out.',
    recheck: 'vendor.claude.auth',
  },
  {
    id: 'x2',
    label: 'Open the Claude settings',
    kind: 'settings_link',
    route: 'settings/vendors',
    pointer: '',
  },
  // Never offered: a shell line outside the families a heal may suggest, a link out of Settings, a run action.
  { id: 'x3', label: 'Wipe', kind: 'shell_copy', command: 'rm -rf ~', shell: 'sh', reason: '', recheck: '' },
  { id: 'x4', label: 'Bad link', kind: 'settings_link', route: '../etc', pointer: '' },
  { id: 'x5', label: 'Close', kind: 'close_run' },
]

function core(
  o: { outcome?: HealOutcome; heal?: false; version?: string | null; appCheck?: CheckResult } = {},
) {
  const requests: HealRequest[] = []
  const fallback: HealOutcome = {
    status: 'ok',
    diagnosis: '  Claude needs a fresh sign-in.  ',
    actions: SUGGESTED,
    hidden: 1,
    at: 5,
  }
  const diagnose = vi.fn((req: HealRequest): Promise<HealOutcome> => {
    requests.push(req)
    return Promise.resolve(o.outcome ?? fallback)
  })
  const awaitRecheck = vi.fn()
  const actions = new RecoveryActionStore()
  if (o.appCheck !== undefined) actions.recordApp([o.appCheck])
  const recovery: Partial<RecoveryHost> = {
    actions,
    env: {},
    ...(o.heal === false ? {} : { heal: { diagnose } }),
    ...(o.version !== undefined ? { vendorVersion: () => o.version ?? null } : {}),
  }
  const ctx = {
    kind: 'app',
    readOnly: false,
    adapters: {
      list: () => [{ id: 'claude', built: true, adapter: { displayName: 'Claude' } }],
      resolveId: (id: string) => id,
    },
    preflight: {
      cache: {
        vendor: (id: string) => (id === 'claude' ? { checks: [authCheck] } : undefined),
        awaitRecheck,
      },
    },
    config: { managedFlags: () => ({ claude: ['--permission-mode'] }) },
    recovery,
    now: () => 10,
  } as unknown as HandlerContext
  return { h: createHandlers(ctx), diagnose, requests, awaitRecheck }
}

async function execute(h: ReturnType<typeof createHandlers>, actionId: string) {
  return dispatch(h, 'recovery.execute', { actionId })
}

describe('Diagnose with AI on a vendor check', () => {
  it("sends the check's own words as the failure, nothing else", async () => {
    const c = core({ version: '2.1.289' })
    const r = await execute(c.h, HEAL_ID)
    expect(r.ok).toBe(true)
    expect(c.requests).toEqual([
      {
        step: 'probe',
        trigger: 'user',
        vendor: 'claude',
        vendorVersion: '2.1.289',
        passArgv: [],
        tail: [],
        failure: {
          category: 'auth_required',
          message: 'Claude is signed out: Claude Code reported loggedIn false.',
          raw: 'Claude Code reported loggedIn false.',
          classifiedBy: 'app',
        },
      },
    ])
  })

  it('offers only the safe suggestions, under fresh ids, with the diagnosis as the message', async () => {
    const c = core()
    const r = await execute(c.h, HEAL_ID)
    if (!r.ok) throw new Error(r.error.message)
    const v = r.value as {
      kind: string
      message: string
      heal: { actions: RecoveryAction[]; hidden: number; diagnosis: string }
    }
    expect(v.kind).toBe('heal')
    expect(v.message).toBe('Claude needs a fresh sign-in.')
    expect(v.heal.diagnosis).toBe('Claude needs a fresh sign-in.')
    expect(v.heal.actions.map((a) => [a.kind, a.label])).toEqual([
      ['shell_copy', 'Sign in to Claude'],
      ['settings_link', 'Open the Claude settings'],
    ])
    // The healer's own hidden count, plus the three Dim Factory refused here.
    expect(v.heal.hidden).toBe(4)
    for (const a of v.heal.actions) expect(a.id).toMatch(/^probe:heal-[0-9a-f]{8}-\d$/)
    // Without a launch probe's version the request says so.
    expect(c.requests[0]?.vendorVersion).toBeNull()
  })

  it('a suggested fix can be run from where the check was; a later diagnosis never takes over its id', async () => {
    const c = core()
    const first = await execute(c.h, HEAL_ID)
    const second = await execute(c.h, HEAL_ID)
    if (!first.ok || !second.ok) throw new Error('diagnosis failed')
    const a1 = (first.value as { heal: { actions: RecoveryAction[] } }).heal.actions
    const a2 = (second.value as { heal: { actions: RecoveryAction[] } }).heal.actions
    expect(a1.map((a) => a.id)).not.toEqual(a2.map((a) => a.id))
    const signIn = a1.find((a) => a.kind === 'shell_copy')
    expect(signIn).toBeDefined()
    expect(await execute(c.h, signIn?.id ?? '')).toEqual({
      ok: true,
      value: {
        kind: 'shell_copy',
        copied: 'claude auth login',
        message: 'Copied. Run it in a terminal, then re-check.',
      },
    })
    expect(c.awaitRecheck).toHaveBeenCalledWith('vendor.claude.auth', 10)
  })

  it('a healer that failed with nothing to offer: the setup guide, and the message says so', async () => {
    const c = core({
      outcome: { status: 'failed', actions: [], hidden: 0, at: 5, error: 'the healer timed out' },
    })
    const r = await execute(c.h, HEAL_ID)
    if (!r.ok) throw new Error(r.error.message)
    const v = r.value as {
      message: string
      heal: { status: string; error: string; actions: RecoveryAction[] }
    }
    expect(v.message).toBe('The AI diagnosis failed.')
    expect(v.heal).toMatchObject({ status: 'failed', error: 'the healer timed out' })
    expect(v.heal.actions).toEqual([
      expect.objectContaining({
        kind: 'open_docs',
        label: 'Open the setup guide',
        url: expect.stringMatching(/^https:\/\//) as string,
      }),
    ])
  })

  it('self-heal turned off is said plainly', async () => {
    const c = core({ outcome: { status: 'disabled', actions: [], hidden: 0, at: 5 } })
    const r = await execute(c.h, HEAL_ID)
    expect(r).toMatchObject({ ok: true, value: { message: 'Self-heal is turned off in Settings.' } })
  })

  it('a core without a healer answers UNSUPPORTED; nothing is diagnosed', async () => {
    const c = core({ heal: false })
    expect(await execute(c.h, HEAL_ID)).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'Self-heal is not available here.' },
    })
    expect(c.diagnose).not.toHaveBeenCalled()
  })

  it('an id no check offers is stale (NOT_FOUND), never another action', async () => {
    const c = core()
    const r = await execute(c.h, 'vendor.claude.auth:heal-other')
    expect(r.ok ? null : r.error.code).toBe('NOT_FOUND')
    expect(c.diagnose).not.toHaveBeenCalled()
  })
})

describe('Diagnose with AI on an app check', () => {
  it('diagnoses with the default healer vendor, and its fixes are kept with the app checks', async () => {
    const appCheck: CheckResult = {
      id: 'app.home',
      scope: 'app',
      status: 'fail',
      blocking: true,
      category: 'disk_full',
      title: 'The Dim Factory folder cannot be written',
      detail: 'ENOSPC',
      recovery: [{ id: 'app.home:heal', label: 'Diagnose with AI', kind: 'heal' }],
      at: 0,
      ttlMs: 0,
    }
    const c = core({ appCheck })
    const r = await execute(c.h, 'app.home:heal')
    if (!r.ok) throw new Error(r.error.message)
    expect(c.requests[0]).toMatchObject({ vendor: 'claude', failure: { category: 'disk_full' } })
    const offered = (r.value as { heal: { actions: RecoveryAction[] } }).heal.actions
    const link = offered.find((a) => a.kind === 'settings_link')
    expect(await execute(c.h, link?.id ?? '')).toMatchObject({ ok: true, value: { kind: 'settings_link' } })
  })
})
