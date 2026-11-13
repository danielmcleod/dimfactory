// Head to head in the composer: one line that is always there (a switch and a note), the two sides opening under it on
// the switch, and Run starting a match (the same request for both sides, plus who builds each) and opening its page.
import '../helpers/rtl.ts'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MATCH_TEXT } from '@shared/match.ts'
import { PROMPT_HINT_TEXT } from '@shared/prompt-check.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import {
  BLIND_LABEL,
  HEAD_TO_HEAD_OFF,
  HEAD_TO_HEAD_STATUS,
  defaultSides,
  headToHeadNote,
} from '@renderer/pages/dashboard/composer/HeadToHeadRow.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

const MATCH = '20261110T120000Z-ab12'
let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
      'task.check': (req: { task: string }) =>
        /better/.test(req.task)
          ? { hints: [{ kind: 'no-target', ...PROMPT_HINT_TEXT.noTarget }], sharpen: null }
          : { hints: [], sharpen: null },
      'matches.start': () => ({
        matchId: MATCH,
        sides: [
          { side: 'a', runId: '20261110T120001Z-aaaa', displayNo: 1 },
          { side: 'b', runId: '20261110T120002Z-bbbb', displayNo: 2 },
        ],
      }),
      'runs.start': () => ({ runId: 'r9', displayNo: 9 }),
    },
  })
})

afterEach(() => tearDown(mock))

const note = (): string => screen.getByTestId('composer-h2h-note').textContent
const type = async (task: string): Promise<void> => {
  fireEvent.change(screen.getByTestId('composer-task'), { target: { value: task } })
  await settle(500)
}
const turnOn = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId('composer-h2h-switch'))
  await settle()
}

describe('the Head to head row', () => {
  it('is one line of one height, off, saying what it does; nothing else is shown until it is switched on', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    await mountComposer()
    const row = screen.getByTestId('composer-h2h')
    expect(row.getAttribute('data-on')).toBe('false')
    expect(row.firstElementChild?.className).toContain('h-7')
    expect(note()).toBe(HEAD_TO_HEAD_OFF)
    expect(screen.queryByTestId('composer-h2h-sides')).toBeNull()
    // Run is an ordinary run.
    await type('Add a --version flag')
    fireEvent.click(screen.getByTestId('composer-run'))
    await settle()
    expect(mock.callsOf('runs.start')).toHaveLength(1)
    expect(mock.callsOf('matches.start')).toEqual([])
  })

  it('switched on: side A builds as the run would, side B is the other ready vendor, and Run starts the match', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    await mountComposer()
    await type('Add a --version flag')
    await turnOn()
    expect(screen.getByTestId('composer-h2h-sides')).toBeTruthy()
    expect(screen.getByTestId('composer-h2h-vendor-a').textContent).toContain('Claude')
    expect(screen.getByTestId('composer-h2h-vendor-b').textContent).toContain('Codex')
    expect(note()).toBe(MATCH_TEXT.twoBuilds)
    expect(screen.getByTestId('composer-run-status').textContent).toBe(HEAD_TO_HEAD_STATUS)
    // The Run button keeps its label.
    expect(screen.getByTestId('composer-run').textContent).toContain('Run')

    fireEvent.click(screen.getByTestId('composer-run'))
    await settle()
    expect(mock.callsOf('runs.start')).toEqual([])
    const sent = mock.callsOf('matches.start')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ folder: FOLDER, task: 'Add a --version flag' })
    expect(sent[0]?.sides[0]).toMatchObject({ vendor: 'claude' })
    expect(sent[0]?.sides[1]).toEqual({ vendor: 'codex' })
    expect(sent[0]?.blind).toBeUndefined()
    expect(window.location.hash).toBe(`#/matches/${MATCH}`)
  })

  it('hiding the names goes with the request', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    await mountComposer()
    await type('Add a --version flag')
    await turnOn()
    expect(screen.getByText(BLIND_LABEL)).toBeTruthy()
    fireEvent.click(screen.getByTestId('composer-h2h-blind'))
    await settle()
    fireEvent.click(screen.getByTestId('composer-run'))
    await settle()
    expect(mock.callsOf('matches.start')[0]?.blind).toBe(true)
  })

  it('with one vendor ready both sides are the same, and the row says what that shows', async () => {
    upsertProbes([probe('claude', 'ready')])
    await mountComposer()
    await turnOn()
    expect(screen.getByTestId('composer-h2h-vendor-b').textContent).toContain('Claude')
    expect(note()).toBe(MATCH_TEXT.sameSides)
  })

  it('a task the prompt check has a hint for: the two results would differ mostly by guesswork', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    await mountComposer()
    await turnOn()
    await type('Make it better')
    expect(note()).toBe(MATCH_TEXT.openTask)
    await type('Rename getUser to fetchUser in src/api.ts')
    expect(note()).toBe(MATCH_TEXT.twoBuilds)
  })

  it('switching it off and on again keeps the sides that were chosen', async () => {
    upsertProbes([probe('claude', 'ready'), probe('codex', 'ready')])
    await mountComposer()
    await turnOn()
    fireEvent.click(screen.getByTestId('composer-h2h-switch'))
    await settle()
    expect(screen.queryByTestId('composer-h2h-sides')).toBeNull()
    expect(note()).toBe(HEAD_TO_HEAD_OFF)
    await turnOn()
    expect(screen.getByTestId('composer-h2h-vendor-b').textContent).toContain('Codex')
  })
})

describe('the row’s words (pure)', () => {
  const sides = (b: string): [{ vendor: string }, { vendor: string }] => [{ vendor: 'claude' }, { vendor: b }]
  it('says the most useful thing: an open task first, then two tries, then the cost', () => {
    expect(headToHeadNote({ on: false, sides: sides('codex'), blind: false }, true)).toBe(HEAD_TO_HEAD_OFF)
    expect(headToHeadNote({ on: true, sides: sides('claude'), blind: false }, true)).toBe(MATCH_TEXT.openTask)
    expect(headToHeadNote({ on: true, sides: sides('claude'), blind: false }, false)).toBe(
      MATCH_TEXT.sameSides,
    )
    expect(headToHeadNote({ on: true, sides: sides('codex'), blind: false }, false)).toBe(
      MATCH_TEXT.twoBuilds,
    )
  })

  it('side A carries the run’s model and effort; a vendor that is not ready is never offered as side B', () => {
    const probes = [probe('claude', 'ready'), probe('codex', 'not-installed')]
    expect(defaultSides({ vendor: 'claude', model: 'opus', effort: 'high' }, probes, [])).toEqual([
      { vendor: 'claude', model: 'opus', effort: 'high' },
      { vendor: 'claude', model: 'opus', effort: 'high' },
    ])
    expect(
      defaultSides({ vendor: 'codex', model: null, effort: null }, [probe('claude', 'ready')], [])[1],
    ).toEqual({ vendor: 'claude' })
  })
})
