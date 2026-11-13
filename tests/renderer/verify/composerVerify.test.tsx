// Composer: Verify (the composer's "Verify: N commands" box; the Verify step is opt-in;
// `verify.enabled`; the `run.verify` check). The box is a run override like New run branch: it shows the pending choice at
// once and core's value otherwise, with core's provenance badge; its label counts the commands core would run (the
// resolved list less those turned off) at one reserved width; the link beside it opens Settings → Isolation & Verify
// for the composer's folder; core's live checks and runs.start carry the override.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import {
  VERIFY_SETTINGS_LABEL,
  verifyLabel,
  verifyTooltip,
} from '@renderer/pages/dashboard/composer/IsolationControls.tsx'
import { setVerifyEnabled } from '@renderer/pages/dashboard/composer/overrides.ts'
import { verifyCommandCount } from '@renderer/pages/dashboard/composer/model.ts'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { parseHash } from '@renderer/lib/router.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  check,
  fakeResolve,
  FOLDER,
  mountComposer,
  probe,
  report,
  runEstimate,
} from '../composer/fixtures.tsx'

let mock: MockDimFactory

const COMMANDS = [
  { name: 'typecheck', run: ['pnpm', 'run', 'typecheck'] },
  { name: 'lint', run: 'pnpm run lint', enabled: false },
  { name: 'test', run: ['pnpm', 'run', 'test'] },
]

/** core's config.resolve for verify: the run override wins with run provenance, else the project's value. */
function resolveWithVerify(projectEnabled = false) {
  const base = fakeResolve()
  return (req: { folder?: string; overrides?: RunOverrides }) => {
    const r = base(req)
    r.config.verify = { ...r.config.verify, commands: [...COMMANDS], enabled: projectEnabled }
    const v = req.overrides?.verify?.enabled
    if (v !== undefined) r.config.verify.enabled = v
    r.provenance['/verify/enabled'] =
      v !== undefined ? { source: 'run' } : projectEnabled ? { source: 'project' } : { source: 'default' }
    return r
  }
}

beforeEach(() => {
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': resolveWithVerify(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

async function ready(): Promise<void> {
  await mountComposer()
  await settle(300)
  fireEvent.click(screen.getByTestId('composer-passes-toggle'))
  await settle()
}

const box = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('verify-enabled')
const lastOf = <T,>(list: T[]): T | undefined => list.at(-1)

async function toggle(): Promise<void> {
  fireEvent.click(box())
  await settle(300)
}

describe('Verify in the composer', () => {
  it('is a live box labelled with the commands core would run, with core provenance and a link to Settings', async () => {
    await ready()
    expect(box().disabled).toBe(false)
    expect(box().closest('[data-disabled-hint]')).toBeNull()
    expect(box().getAttribute('aria-checked')).toBe('false')
    // Three configured, one turned off: two run.
    expect(screen.getByTestId('verify-commands').textContent).toBe('Verify: 2 commands')
    expect(screen.getByTestId('verify-provenance').getAttribute('data-source')).toBe('default')
    const link = screen.getByTestId('verify-settings')
    expect(link.tagName).toBe('A')
    expect(link.textContent).toBe(VERIFY_SETTINGS_LABEL)
    expect(parseHash(link.getAttribute('href') ?? '')).toEqual({
      name: 'settings',
      section: 'isolation',
      subpath: [],
      query: { field: '/verify/commands', folder: FOLDER },
    })
  })

  it('writes the run override verify.enabled, which core resolves, checks and estimates with', async () => {
    await ready()
    await toggle()
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(lastOf(mock.callsOf('config.resolve'))).toEqual({
      folder: FOLDER,
      overrides: { verify: { enabled: true } },
    })
    expect(lastOf(mock.callsOf('preflight.run'))).toEqual({
      folder: FOLDER,
      overrides: { verify: { enabled: true } },
    })
    expect(lastOf(mock.callsOf('estimates.get'))).toEqual({
      folder: FOLDER,
      overrides: { verify: { enabled: true } },
    })
    const badge = screen.getByTestId('verify-provenance')
    expect(badge.getAttribute('data-source')).toBe('run')
    expect(screen.getByTestId('composer-override-count').textContent).toBe('1 run override')
    // Unticked again: an explicit `false` for this run.
    await toggle()
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(lastOf(mock.callsOf('config.resolve'))?.overrides).toEqual({ verify: { enabled: false } })
  })

  it("turns a project's verify off for one run, and starts the run with it", async () => {
    mock.on('config.resolve', resolveWithVerify(true))
    mock.on('runs.start', () => ({ runId: 'r1', displayNo: 1 }))
    await ready()
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('verify-provenance').getAttribute('data-source')).toBe('project')
    await toggle()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a --version flag' } })
    await settle(300)
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([
      { folder: FOLDER, task: 'Add a --version flag', overrides: { verify: { enabled: false } } },
    ])
  })

  it("shows core's run.verify check in the strip like any other check", async () => {
    mock.on('preflight.run', () =>
      report({
        blocking: [
          check('run.verify', {
            status: 'fail',
            title: 'Verify has no commands',
            detail: 'Turn on a detected command, or turn verify off.',
          }),
        ],
      }),
    )
    await ready()
    expect(screen.getByTestId('preflight-summary-text').textContent).toBe(
      '1 issue blocks the run: Verify has no commands',
    )
  })
})

describe('Verify words', () => {
  it('keeps one label per count and says what verify does', () => {
    expect(verifyLabel(0)).toBe('Verify: no commands')
    expect(verifyLabel(1)).toBe('Verify: 1 command')
    expect(verifyLabel(12)).toBe('Verify: 12 commands')
    expect(verifyTooltip(['implement', 'fix'], undefined)).toContain('after Implement and after Fix')
    expect(verifyTooltip(['fix'], undefined)).toContain('after Fix.')
    const withCheck = verifyTooltip(
      ['implement'],
      check('run.verify', { title: 'test is not trusted', detail: 'Trust it in Settings.' }),
    )
    expect(withCheck.split('\n')).toEqual([
      expect.stringContaining('after Implement'),
      'test is not trusted: Trust it in Settings.',
    ])
    for (const s of [verifyLabel(3), verifyTooltip(['implement', 'fix'], undefined)])
      expect(s).not.toContain('—')
  })

  it('counts the resolved commands less those turned off, and sets the override', () => {
    expect(verifyCommandCount({ profile: 'p', auto: false, passes: {} as never })).toBe(0)
    expect(
      verifyCommandCount({
        profile: 'p',
        auto: false,
        passes: {} as never,
        verify: { enabled: true, commands: COMMANDS, runAfter: ['fix'], failFast: false, baseline: false },
      }),
    ).toBe(2)
    expect(setVerifyEnabled({}, true)).toEqual({ verify: { enabled: true } })
    const o = setVerifyEnabled({ gates: { afterPlan: false } }, false)
    expect(o).toEqual({ gates: { afterPlan: false }, verify: { enabled: false } })
    expect(setVerifyEnabled(o, false)).toBe(o)
  })
})
