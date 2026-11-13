// One wording for a fresh Fix session (the PassCard's session line, the composer's Fix row, the Runs
// history's Re-run from Fix, whose tooltip says fresh or why): the composer's Fix row words core's fixSession reason with the
// card's own line component, and Re-run from Fix (menu item and tooltip) uses the card's reason words and Why.
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { ComposerSuggestions, ResolvedWithProvenance } from '@shared/ipc.ts'
import type { FreshReason, RunSnapshot } from '@shared/run.ts'
import { FRESH_REASONS } from '@shared/run.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { PassCard } from '@renderer/components/run/PassCard.tsx'
import { RunHeader, rerunFromFixWhy } from '@renderer/components/run/RunHeader.tsx'
import { freshReasonWhy } from '@renderer/components/run/SessionLine.tsx'
import { FRESH_REASON_TEXT } from '@renderer/components/run/text.ts'
import { FixSessionSelect } from '@renderer/pages/dashboard/composer/FixRow.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'
import { RUN, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'runs.events': () => ({ events: [], lastSeq: 0, more: false }),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'no output')
      },
    },
  })
  upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
})

afterEach(() => tearDown(mock))

const textOf = (id: string): string | null => screen.getByTestId(id).textContent

/** A finished run whose Fix started fresh for `reason`: Fix on `fixVendor`, Implement on Claude. */
function freshRun(reason: FreshReason, fixVendor = 'codex'): RunSnapshot {
  return snapWith({
    summary: { status: 'completed', phase: 'done', outcome: 'fixed' },
    steps: {
      implement: { status: 'done', attempt: 1, vendor: 'claude', activeMs: 60_000 },
      fix: {
        status: 'done',
        attempt: 1,
        vendor: fixVendor,
        activeMs: 30_000,
        sessionNote: `fresh session: ${FRESH_REASON_TEXT[reason]}`,
      },
    },
    extra: { rerunFromFix: { available: true, fresh: true, reason } },
  })
}

/** The Fix card's line words and Why sentence for a snapshot. */
async function cardWording(snap: RunSnapshot): Promise<{ line: string; why: string }> {
  const view = render(
    <Providers>
      <PassCard runId={RUN} snap={snap} view={snap.steps.fix} />
    </Providers>,
  )
  await settle()
  fireEvent.click(screen.getByTestId('session-why-fix-toggle'))
  const out = { line: textOf('fix-session-line') ?? '', why: textOf('session-why-fix') ?? '' }
  view.unmount()
  return out
}

describe('the composer words core’s Fix session reason as the card does', () => {
  it.each(FRESH_REASONS.map((r) => [r]))(
    '%s: same line words, the Why for a run not started yet',
    (reason) => {
      render(
        <Providers>
          <FixSessionSelect
            value="fresh"
            otherVendor="Codex"
            resumeCheck={null}
            reason={reason}
            fixVendor="Codex"
            implementVendor="Claude"
            onChange={() => undefined}
          />
        </Providers>,
      )
      const line = screen.getByTestId('fix-session-reason')
      expect(line.getAttribute('data-reason')).toBe(reason)
      expect(textOf('fix-session-reason-text')).toBe(`Fresh session: ${FRESH_REASON_TEXT[reason]}`)
      const toggle = screen.getByTestId('fix-session-reason-why-toggle')
      expect(toggle.getAttribute('aria-label')).toBe('Why Fix starts a fresh session')
      fireEvent.click(toggle)
      expect(textOf('fix-session-reason-why')).toBe(
        freshReasonWhy(reason, { vendor: 'Codex', implementVendor: 'Claude', planned: true }),
      )
    },
  )

  it('has no reason line when Fix reuses the session', () => {
    render(
      <Providers>
        <FixSessionSelect value="reuse" otherVendor={null} resumeCheck={null} onChange={() => undefined} />
      </Providers>,
    )
    expect(screen.queryByTestId('fix-session-reason')).toBeNull()
  })

  it('in the composer: a Fix vendor override reads exactly like the card line, Why in the future tense', async () => {
    const suggestions: ComposerSuggestions = {
      criticSwap: null,
      fixSession: { choice: 'fresh-other', reason: 'vendor-differs' },
      otherFixVendor: 'codex',
    }
    mock.on(
      'config.resolve',
      (req: { folder?: string; overrides?: RunOverrides }): ResolvedWithProvenance => ({
        ...fakeResolve({ config: (c) => void (c.passes.fix.vendor = 'codex') })(req),
        suggestions,
      }),
    )
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('composer-passes-toggle'))
    await settle()
    fireEvent.click(screen.getByTestId('pass-row-toggle-fix'))
    await settle()
    const row = within(screen.getByTestId('pass-row-fix'))
    expect(row.getByTestId('fix-session-reason-text').textContent).toBe('Fresh session: Fix vendor differs')
    fireEvent.click(row.getByTestId('fix-session-reason-why-toggle'))
    expect(row.getByTestId('fix-session-reason-why').textContent).toBe(
      'Fix runs on Codex, Implement runs on Claude; a session cannot move between vendors.',
    )
  })

  it('in the composer: no reason line while core says Fix reuses the session', async () => {
    await mountComposer()
    await settle(300)
    fireEvent.click(screen.getByTestId('composer-passes-toggle'))
    await settle()
    fireEvent.click(screen.getByTestId('pass-row-toggle-fix'))
    await settle()
    expect(screen.getByTestId('pass-row-fix')).toBeTruthy()
    expect(screen.queryByTestId('fix-session-reason')).toBeNull()
  })
})

describe('Re-run from Fix uses the card’s words', () => {
  it.each(FRESH_REASONS.map((r) => [r]))(
    '%s: the menu item and its Why match the Fix card',
    async (reason) => {
      const snap = freshRun(
        reason,
        reason === 'vendor-differs' || reason === 'override-other-vendor' ? 'codex' : 'claude',
      )
      const card = await cardWording(snap)
      expect(card.line).toBe(`Fresh session: ${FRESH_REASON_TEXT[reason]}`)
      expect(rerunFromFixWhy(snap)).toBe(card.why)

      render(
        <Providers>
          <RunHeader snap={snap} onStop={() => undefined} stopping={false} />
        </Providers>,
      )
      fireEvent.pointerDown(screen.getByTestId('rerun-menu'), {
        button: 0,
        ctrlKey: false,
        pointerType: 'mouse',
      })
      await settle()
      const item = screen.getByTestId('rerun-from-fix')
      expect(item.textContent).toContain(`Fix would start a fresh session: ${FRESH_REASON_TEXT[reason]}`)
      expect(within(item).getByTestId('rerun-from-fix-why').textContent).toBe(card.why)
    },
  )

  it('the Re-run tooltip says fresh and why in the same words', async () => {
    const snap = freshRun('vendor-differs')
    render(
      <Providers>
        <RunHeader snap={snap} onStop={() => undefined} stopping={false} />
      </Providers>,
    )
    fireEvent.focus(screen.getByTestId('rerun-menu'))
    await settle(400)
    const tip = screen.getByRole('tooltip')
    // Re-run is live, so the tooltip no longer starts with "Available in a later version."
    expect(tip.textContent).toBe(
      'Fix would start a fresh session: Fix vendor differs. ' +
        'Fix runs on Codex, Implement ran on Claude; a session cannot move between vendors.',
    )
  })

  it('no Why when Re-run from Fix would continue the session or is not possible', () => {
    const reuse = snapWith({ extra: { rerunFromFix: { available: true, fresh: false } } })
    expect(rerunFromFixWhy(reuse)).toBeNull()
    const none = snapWith({
      extra: { rerunFromFix: { available: false, fresh: true, reason: 'no-session' } },
    })
    expect(rerunFromFixWhy(none)).toBeNull()
    render(
      <Providers>
        <RunHeader snap={reuse} onStop={() => undefined} stopping={false} />
      </Providers>,
    )
    expect(screen.queryByTestId('rerun-from-fix-why')).toBeNull()
  })
})
