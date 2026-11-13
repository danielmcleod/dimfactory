// Verify cards (Cards: "trust: Command + body (diff when changed) · [Trust for this project] [Skip]",
// "verifyEnv: [Retry] [Skip verify]"; gate:beforeFix with findings from a failing verify command, `source:'verify'`).
// Core builds the card (src/core/supervisor/cards.ts); the renderer shows the command, where it runs, its script or
// what changed in it, the commands the environment could not run with their excerpt, and sends core's choice ids.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import type { CardView as CardData } from '@shared/run.ts'
import { PREEXISTING_LABEL, VERIFY_SOURCE_LABEL } from '@renderer/components/cards/BeforeFixBody.tsx'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { TRUST_CHOICE, VERIFY_ENV_CHOICE, trustOf, verifyEnvOf } from '@renderer/components/cards/payload.ts'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { envWhy } from '@renderer/components/cards/VerifyEnvBody.tsx'
import { scriptDiff, whereText } from '@renderer/components/cards/TrustBody.tsx'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import coreCards from '../../../src/core/supervisor/cards.ts?raw'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'
import { trustCard, verifyEnvCard } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  resetRecoveryForTests()
  resetLaterChoicesForTests()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: { 'cards.resolve': () => undefined, 'runs.get': () => snapWith() },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  setMacForTests(null)
  resetBridgeForTests()
})

function mount(card: CardData): void {
  renderUi(<CardView runId={RUN} card={card} folder="C:\\work\\repo" />)
}

async function choose(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`card-choice-${id}`))
    await settle()
  })
}

/** `key: 'value'` pairs of an `export const <name> = {…}` block in a source file. */
function constBlock(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`const ${name}`)
  expect(start).toBeGreaterThan(-1)
  const open = src.indexOf('{', start)
  const close = src.indexOf('}', open)
  const out: Record<string, string> = {}
  for (const m of src.slice(open, close).matchAll(/^\s*'?([\w-]+)'?:\s*'([^']*)',?\s*$/gm)) {
    out[m[1] as string] = m[2] as string
  }
  return out
}

describe('trust card', () => {
  it('a command never trusted: the command, where it runs and its script; Trust for this project or Skip', async () => {
    mount(trustCard())
    const card = screen.getByTestId('card-trust')
    expect(within(card).getByRole('heading', { name: 'Trust the test check?' })).toBeTruthy()
    expect(screen.getByTestId('trust-command').textContent).toBe('pnpm run test')
    expect(screen.getByTestId('trust-where').textContent).toBe('In the project folder')
    expect(screen.getByTestId('trust-script').textContent).toBe('vitest run --reporter=dot')
    expect(screen.queryByTestId('trust-diff')).toBeNull()
    // Core's lead and closing words; its list of the script is not repeated.
    expect(card.textContent).toContain('Dim Factory runs only the commands you trust for this project.')
    expect(card.textContent).toContain('or skip it this round.')
    expect(card.textContent).not.toContain('Script: vitest')
    expect(screen.getByTestId('card-choice-trust').textContent).toBe('Trust for this project')
    await choose('trust')
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: 'trust-1', choiceId: 'trust' }])
  })

  it('a changed script: what changed, line by line (core’s diff), and Skip sends skip', async () => {
    mount(trustCard({ changed: true }))
    expect(
      within(screen.getByTestId('card-trust')).getByRole('heading', {
        name: 'The test check changed since you trusted it',
      }),
    ).toBeTruthy()
    const diff = screen.getByTestId('trust-diff')
    expect(diff.getAttribute('aria-label')).toBe('Script changes: 1 added, 1 removed')
    const lines = [...diff.querySelectorAll('[data-op]')].map((l) => [
      l.getAttribute('data-op'),
      l.textContent,
    ])
    expect(lines).toEqual([
      ['del', '−Removed: vitest run'],
      ['add', '+Added: vitest run --reporter=dot'],
    ])
    expect(screen.queryByTestId('trust-script')).toBeNull()
    expect(screen.getByTestId('card-trust').textContent).not.toContain('Changes:')
    await choose('skip')
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: 'trust-1', choiceId: 'skip' }])
  })

  it('a changed script without core’s diff: the renderer’s line diff of the two bodies', () => {
    mount(trustCard({ changed: true, withDiff: false }))
    const ops = [...screen.getByTestId('trust-diff').querySelectorAll('[data-op]')].map((l) =>
      l.getAttribute('data-op'),
    )
    expect(ops.sort()).toEqual(['add', 'del'])
    expect(scriptDiff([], 'a\nb', 'a\nc').map((l) => `${l.op}:${l.text}`)).toEqual([
      'same:a',
      'del:b',
      'add:c',
    ])
  })

  it('reads the payload defensively', () => {
    expect(trustOf({ ...trustCard(), payload: null })).toEqual({
      name: '',
      command: '',
      argv: [],
      cwdRel: '.',
      body: null,
      trust: 'untrusted',
      grantedBody: null,
      diff: [],
    })
    expect(whereText('packages/cli')).toBe('In packages/cli')
  })
})

describe('verifyEnv card', () => {
  it('lists each command the environment could not run, with core’s reason and its excerpt; Retry and Skip verify', async () => {
    mount(verifyEnvCard())
    const card = screen.getByTestId('card-verifyEnv')
    expect(within(card).getByRole('heading', { name: 'The lint check could not run' })).toBeTruthy()
    const item = screen.getByTestId('verify-env-0')
    expect(item.textContent).toContain('lint')
    expect(item.textContent).toContain('exit 9009')
    expect(item.textContent).toContain('eslint .')
    expect(screen.getByTestId('verify-env-0-why').textContent).toBe('eslint was not found.')
    const excerpt = screen.getByTestId('verify-env-0-excerpt')
    expect(excerpt.textContent).toContain('is not recognized')
    expect(excerpt.getAttribute('data-scroll-region')).toBe('verify-output')
    // Core's lead line, not its list (shown above from the payload), and its closing words.
    expect(card.textContent).toContain('so they are not findings:')
    expect(card.textContent).not.toContain('- lint')
    expect(card.textContent).toContain('Fix the environment and retry')
    // Core's own primary (Retry); Skip verify is its default for Auto.
    expect(screen.getByTestId('card-choice-retry').className).toContain('bg-primary')
    await choose('retry')
    await choose('skip-verify')
    expect(mock.callsOf('cards.resolve').map((r) => r.choiceId)).toEqual(['retry', 'skip-verify'])
  })

  it('says why the round could not run at all', () => {
    mount(verifyEnvCard({ failure: 'the verify log folder could not be written' }))
    expect(screen.getByTestId('card-verifyEnv').textContent).toContain(
      'Verify could not run: the verify log folder could not be written',
    )
    expect(screen.queryByTestId('verify-env-commands')).toBeNull()
    expect(verifyEnvOf(verifyEnvCard({ failure: 'x' })).failure).toBe('x')
    expect(envWhy({ reason: null, exitCode: 127 })).toBe('It exited with code 127.')
    expect(envWhy({ reason: null, exitCode: null })).toBe('It did not start.')
  })

  it('uses core’s choice ids', () => {
    expect(constBlock(coreCards, 'TRUST_CHOICE')).toEqual({ ...TRUST_CHOICE })
    expect(constBlock(coreCards, 'VERIFY_ENV_CHOICE')).toEqual({ ...VERIFY_ENV_CHOICE })
  })
})

describe('the gate before Fix', () => {
  const finding = (over: Partial<Finding> & { id: string; n: number }): Finding => ({
    severity: 'must',
    source: 'review',
    title: 'A finding',
    body: '',
    flags: [],
    round: 1,
    ...over,
  })

  it('marks a failing verify command’s finding with a Verify chip, and one that failed before the run', () => {
    const findings = [
      finding({ id: 'v1', n: 1, source: 'verify', title: '`pnpm run test` failed (exit 1, 41s)' }),
      finding({ id: 'r1', n: 2, title: 'Missing --version handling' }),
      finding({
        id: 'v2',
        n: 3,
        source: 'verify',
        severity: 'should',
        title: '`pnpm run lint` failed (exit 1, 3s)',
        flags: ['preexisting'],
      }),
    ]
    mount({
      id: 'gate-1',
      kind: 'gate:beforeFix',
      title: 'Findings ready',
      body: '',
      payload: { findings, selected: ['v1', 'r1'] },
      blocking: true,
      choices: [
        { id: 'continue', label: 'Continue', primary: true, input: 'findings' },
        { id: 'skip-fix', label: 'Skip Fix' },
      ],
    })
    expect(screen.getByTestId('finding-source-v1').textContent).toBe(VERIFY_SOURCE_LABEL)
    expect(screen.getByTestId('finding-source-r1').textContent).toBe('from review')
    expect(screen.getByTestId('finding-v2').textContent).toContain(PREEXISTING_LABEL)
    expect(screen.getByTestId('finding-v1').textContent).not.toContain(PREEXISTING_LABEL)
    expect(screen.getByTestId('fix-receives').textContent).toBe('Fix will receive 2 must · 0 should')
  })
})
