// The security advisor in the renderer:
//   - the composer's "Security review" switch: a run override of passes.security.enabled, its constant cost note,
//     on from the resolved config (thorough profile, a project setting);
//   - the timeline: Review ∥ Critic ∥ Security in one column, the scan before it and the re-check after verify:2, from
//     the start when core plans them; none of them in a run without the advisor (core settles them as not used);
//   - the Security pass's findings grouped by level, secrets only as core's masked prefix; the scan's rows (secrets,
//     audits, advisories, the count already there, notes); the re-check's facts;
//   - the gate before Fix: a security chip with the level on security findings;
//   - Settings → Isolation & Verify: the per-project Security review and re-check switches write the project file;
//   - the outcome text of a run whose security findings stayed open.
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { Finding } from '@shared/findings.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ScanView } from '@shared/run.ts'
import { FindingRow } from '@renderer/components/cards/BeforeFixBody.tsx'
import {
  RecheckFacts,
  ScanCard,
  ScanFacts,
  SecurityFindingsList,
  groupByLevel,
  recheckText,
  securityFindingsOf,
} from '@renderer/components/run/SecurityCard.tsx'
import { timelineColumns } from '@renderer/components/run/steps.ts'
import { outcomeText } from '@renderer/lib/format.ts'
import { SECURITY_COST_NOTE } from '@renderer/pages/dashboard/composer/model.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from '../composer/fixtures.tsx'
import { RUN, renderUi, snapWith } from '../run/helpers.tsx'

const EM_DASH = String.fromCodePoint(0x2014)

const finding = (over: Partial<Finding> & { id: string; n: number }): Finding => ({
  severity: 'must',
  source: 'security',
  title: 'A problem',
  body: '',
  flags: [],
  round: 1,
  ...over,
})

// ---- the composer ----------------------------------------------------------------------------------------------------

describe('the composer: Security review', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'preflight.run': () => report(),
        'estimates.get': () => runEstimate(),
      },
    })
    upsertProbes([probe('claude', 'ready')])
  })
  afterEach(() => tearDown(mock))

  it('is off by default, shows its cost note, and turning it on is a run override of the Security pass', async () => {
    await mountComposer()
    await settle(300)
    const sw = screen.getByTestId('composer-security')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    const note = screen.getByTestId('composer-security-note')
    expect(note.textContent).toBe(SECURITY_COST_NOTE)
    expect(note.textContent).not.toContain(EM_DASH)
    fireEvent.click(sw)
    await settle(300)
    const last = mock.callsOf('config.resolve').at(-1) as { overrides?: RunOverrides }
    expect(last.overrides).toEqual({ passes: { security: { enabled: true } } })
    expect(screen.getByTestId('composer-security').getAttribute('aria-checked')).toBe('true')
    // The note did not change: the row keeps its size whatever the switch says.
    expect(screen.getByTestId('composer-security-note').textContent).toBe(SECURITY_COST_NOTE)
    expect(screen.getByTestId('composer-passes').textContent).toContain('Security · Claude · opus')
  })

  it('reads on from the resolved config (the thorough profile or a project setting)', async () => {
    mock.on('config.resolve', fakeResolve({ config: (c) => void (c.passes.security.enabled = true) }))
    await mountComposer()
    await settle(300)
    expect(screen.getByTestId('composer-security').getAttribute('aria-checked')).toBe('true')
  })
})

// ---- the timeline ----------------------------------------------------------------------------------------------------

const keysOf = (cols: ReturnType<typeof timelineColumns>): string[] =>
  cols.map((c) => (c.kind === 'gate' ? 'gate' : c.steps.map((s) => s.key).join('‖')))

describe('the timeline with the security advisor', () => {
  it('joins Review, Critic and Security in one column, the scan before it and the re-check after verify:2', () => {
    const snap = snapWith({
      summary: { auto: true },
      steps: {
        scan: { status: 'queued', planned: true },
        security: { status: 'queued' },
        recheck: { status: 'queued', planned: true },
      },
    })
    expect(keysOf(timelineColumns(snap))).toEqual([
      'preflight',
      'plan',
      'implement',
      'scan',
      'review‖critic‖security',
      'fix',
      'recheck',
    ])
  })

  it('shows none of them in a run without the advisor (core settles them as not used)', () => {
    const snap = snapWith({ summary: { auto: true } })
    const keys = keysOf(timelineColumns(snap))
    expect(keys).toEqual(['preflight', 'plan', 'implement', 'review‖critic', 'fix'])
  })
})

// ---- the Run view's facts ----------------------------------------------------------------------------------------------

describe('the security findings', () => {
  const list: Finding[] = [
    finding({ id: 'a', n: 1, level: 'high', title: '`src/db.ts:12`: SQL built from user input.' }),
    finding({
      id: 'b',
      n: 2,
      level: 'critical',
      source: 'scan',
      title: '`src/config.ts:3`: AWS access key ID committed in the code (AKIA… (20 chars)).',
    }),
    finding({ id: 'c', n: 3, level: 'low', severity: 'should', title: 'Cookie without SameSite.' }),
    finding({ id: 'd', n: 4, level: 'medium', severity: 'should', title: 'Verbose error leaks a path.' }),
  ]

  it('groups by level, critical first, and shows a secret only as core masked it', () => {
    expect(groupByLevel(list).map((g) => g.level)).toEqual(['critical', 'high', 'medium', 'low'])
    render(<SecurityFindingsList findings={list} />)
    const levels = [...screen.getByTestId('security-findings').querySelectorAll('section')].map((s) =>
      s.getAttribute('data-testid'),
    )
    expect(levels).toEqual([
      'security-level-critical',
      'security-level-high',
      'security-level-medium',
      'security-level-low',
    ])
    const critical = screen.getByTestId('security-level-critical')
    expect(critical.textContent).toContain('AKIA… (20 chars)')
    expect(within(critical).getByTestId('security-finding-b').textContent).toContain('scanner')
    expect(screen.getByTestId('security-findings').textContent).not.toContain(EM_DASH)
  })

  it('reads the security findings out of findings.json (other sources left out)', () => {
    const doc = {
      findings: [...list, finding({ id: 'r', n: 5, source: 'review', title: 'A bug' })],
    }
    expect(securityFindingsOf(JSON.stringify(doc))?.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(securityFindingsOf('not json')).toBeNull()
  })

  it('says when there is none', () => {
    render(<SecurityFindingsList findings={[]} />)
    expect(screen.getByTestId('security-findings-none').textContent).toBe('No security findings.')
  })
})

describe('the scan', () => {
  const scan: ScanView = {
    phase: 'done',
    secrets: [
      {
        file: 'src/config.ts',
        line: 3,
        label: 'AWS access key ID',
        masked: 'AKIA… (20 chars)',
        confidence: 'pattern',
        level: 'critical',
      },
    ],
    audits: [
      { name: 'npm audit', argv: ['npm', 'audit', '--json'], status: 'done', introduced: 1, existing: 2 },
      {
        name: 'pip-audit',
        argv: ['pip-audit'],
        status: 'env',
        reason: 'Dim Factory could not find pip-audit',
      },
    ],
    advisories: [
      {
        tool: 'npm',
        package: 'lodash',
        version: '4.17.15',
        id: 'GHSA-xxxx-yyyy-zzzz',
        title: 'Prototype pollution',
        level: 'high',
        levelKnown: true,
        fixedIn: '4.17.21',
      },
    ],
    existing: 2,
    notes: ['pip-audit could not run, so the dependencies this run changed were not audited.'],
  }

  it('lists the secrets (masked), each audit with its counts or reason, the advisories, what was already there and the notes', () => {
    render(<ScanFacts view={scan} />)
    const secret = screen.getByTestId('scan-secret-0')
    expect(secret.textContent).toContain('src/config.ts:3')
    expect(within(secret).getByTestId('scan-masked').textContent).toBe('AKIA… (20 chars)')
    const npm = screen.getByTestId('scan-audit-0')
    expect(npm.getAttribute('data-status')).toBe('done')
    expect(npm.textContent).toContain('1 from this run · 2 already there')
    const pip = screen.getByTestId('scan-audit-1')
    expect(pip.getAttribute('data-status')).toBe('env')
    expect(pip.textContent).toContain('Could not run')
    expect(pip.textContent).toContain('Dim Factory could not find pip-audit')
    const adv = screen.getByTestId('scan-advisory-0')
    expect(adv.textContent).toContain('lodash@4.17.15')
    expect(adv.textContent).toContain('fixed in 4.17.21')
    expect(screen.getByTestId('scan-existing').textContent).toContain('2 advisories were already there')
    expect(screen.getByTestId('scan-notes').textContent).toContain('pip-audit could not run')
    expect(screen.getByTestId('scan-facts').textContent).not.toContain(EM_DASH)
  })

  it('is a runner step card: its status, its summary line and the facts', () => {
    const snap = snapWith({ steps: { scan: { status: 'done', attempt: 1, activeMs: 4200, scan } } })
    renderUi(<ScanCard runId={RUN} snap={snap} view={snap.steps.scan} />)
    const card = screen.getByTestId('pass-card-scan')
    expect(card.getAttribute('data-status')).toBe('done')
    expect(within(card).getByTestId('scan-summary').textContent).toContain(
      '1 secret · 1 advisory from this run',
    )
    expect(within(card).getByTestId('scan-facts')).toBeTruthy()
  })

  it('says nothing was found, and no audit applied, for a clean change', () => {
    render(<ScanFacts view={{ ...scan, secrets: [], audits: [], advisories: [], existing: 0, notes: [] }} />)
    expect(screen.getByTestId('scan-secrets-none')).toBeTruthy()
    expect(screen.getByTestId('scan-audits-none').textContent).toBe('None applied to this change.')
  })
})

describe('the re-check after Fix', () => {
  it('says what it confirmed and what is still open', () => {
    render(
      <RecheckFacts
        view={{ status: 'open', resolved: [1], open: [{ n: 2, reason: 'the key is still in .env.example' }] }}
      />,
    )
    expect(screen.getByTestId('recheck-facts').getAttribute('data-status')).toBe('open')
    expect(screen.getByTestId('recheck-line').textContent).toBe('1 security finding is still open after Fix')
    expect(screen.getByTestId('recheck-open-2').textContent).toContain('the key is still in .env.example')
    expect(screen.getByTestId('recheck-resolved-1')).toBeTruthy()
  })

  it('words every state, and an unclear answer counts as open', () => {
    expect(recheckText(undefined)).toBe('Checks the security findings once Fix ends.')
    expect(recheckText({ status: 'checking', resolved: [], open: [] })).toContain('Checking')
    expect(recheckText({ status: 'resolved', resolved: [1, 2], open: [] })).toBe(
      'Fix resolved all 2 security findings',
    )
    expect(recheckText({ status: 'unclear', resolved: [], open: [{ n: 1 }] })).toContain('still open')
  })
})

// ---- the gate before Fix ------------------------------------------------------------------------------------------------

describe('the gate before Fix', () => {
  it('chips a security finding with its level, and not the others', () => {
    render(
      <ul>
        <FindingRow
          f={finding({ id: 's1', n: 1, level: 'critical', source: 'scan' })}
          checked
          onChange={() => undefined}
        />
        <FindingRow f={finding({ id: 'r1', n: 2, source: 'review' })} checked onChange={() => undefined} />
      </ul>,
    )
    const chip = screen.getByTestId('finding-security-s1')
    expect(chip.getAttribute('data-level')).toBe('critical')
    expect(chip.textContent).toBe('Security · Critical')
    expect(screen.getByTestId('finding-source-s1').textContent).toBe('from the security scan')
    expect(screen.queryByTestId('finding-security-r1')).toBeNull()
  })
})

// ---- Settings ------------------------------------------------------------------------------------------------------------

describe('Settings: the per-project Security review', () => {
  let mock: MockDimFactory
  beforeEach(() => {
    mock = setUp({
      handlers: {
        'config.resolve': fakeResolve(),
        'verify.detect': () => [],
        'folders.recent': () => [],
        'config.patch': () => ({
          path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
          changed: true,
          diff: '',
          backupId: 'b1',
        }),
        'config.restoreBackup': () => ({ path: '', changed: true, diff: '', backupId: null }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  it("writes passes.security.enabled and .recheck to the chosen project's file", async () => {
    window.location.hash = `#/settings/isolation?folder=${encodeURIComponent(FOLDER)}`
    render(
      <Providers>
        <SettingsPage section="isolation" />
      </Providers>,
    )
    await settle(SECTION_LOAD_DELAY_MS)
    await settle()
    const on = screen.getByTestId('security-setting-enabled')
    expect(on.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(on)
    await settle()
    const patches = mock.callsOf('config.patch') as { scope: string; folder?: string; ops: JsonPatchOp[] }[]
    expect(patches.at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/passes/security/enabled', value: true }],
    })
    const recheck = screen.getByTestId('security-setting-recheck')
    expect(recheck.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(recheck)
    await settle()
    expect((mock.callsOf('config.patch') as { ops: JsonPatchOp[] }[]).at(-1)?.ops).toEqual([
      { op: 'replace', path: '/passes/security/recheck', value: false },
    ])
  })
})

// ---- the outcome --------------------------------------------------------------------------------------------------------

describe('the outcome', () => {
  it('reads Completed with failures when security findings stayed open after Fix', () => {
    const text = outcomeText(makeSummary({ runId: 'r', status: 'completed', outcome: 'security-open' }))
    expect(text).toBe('Completed with failures · security findings open')
    expect(text).not.toContain(EM_DASH)
  })
})
