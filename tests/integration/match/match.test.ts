// A Head to head through a real core (the fake Claude for the passes): one task, two builders, each side an ordinary
// isolated run whose copy is written from one snapshot of the folder as it is.
//   - both sides are checked before anything is made; nothing is made when a side cannot start
//   - a folder that is not a repository works, and uncommitted and untracked files are in both copies
//   - every pass runs in its own side's copy; the folder is untouched until a side is applied
//   - the sides take turns at Verify (a command that fails when two of it run at once passes on both sides)
//   - the record, the runs' `matchOf`, the match's view, and the starting ref dropped once both copies exist
//   - the two results put against each other, one kept (applied to the folder) and the pick taken back
//   - Clarify asked once: side A asks, side B starts when it is answered, and both plan from the same answers
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { grantTrust } from '../../../src/core/config/trust.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import { listRunRefs } from '../../../src/core/git/shadow.ts'
import { matchFile } from '../../../src/core/match/store.ts'
import { samePath } from '../../../src/core/real-path.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunOverrides } from '../../../src/shared/config-schema.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { MATCH_TEXT, splitCompare } from '../../../src/shared/match.ts'
import type { MatchStarted } from '../../../src/shared/match.ts'
import type { CardView } from '../../../src/shared/run.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { FakeLogEntry } from '../../fake-cli/harness.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario, stdinByScript } from '../run/scenario.ts'
import type { Scenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

const VERSION = 'export const version = "1.0.0"\n'
const write = { path: 'src/version.ts', content: VERSION }
// The second build to start writes one more line, so the two results differ in that file.
const SECOND = `${VERSION}export const built = "second"\n`
const writeSecond = { path: 'src/version.ts', content: SECOND }

const QUESTIONS = {
  questions: [
    {
      question: 'Which output format should --version print?',
      options: ['Just the number', 'Name and number'],
    },
    { question: 'Should it also accept -v?', options: ['Yes', 'No'] },
  ],
}
const FENCED = `Two choices change the plan.\n\n\`\`\`json\n${JSON.stringify(QUESTIONS)}\n\`\`\``

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

/** Passes when the run wrote the version; fails when another copy of it is running (the sides must take turns). */
const turnScript = (marker: string): string =>
  [
    "import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
    `const marker = ${JSON.stringify(marker)}`,
    "if (existsSync(marker)) { console.error('two checks ran at once'); process.exit(1) }",
    'writeFileSync(marker, String(process.pid))',
    'await new Promise((r) => setTimeout(r, 700))',
    'rmSync(marker, { force: true })',
    "const ok = existsSync('src/version.ts') && readFileSync('src/version.ts', 'utf8').includes('1.0.0')",
    "if (!ok) { console.error('version not written'); process.exit(1) }",
    "console.log('check: ok')",
  ].join('\n')

const TURN = { name: 'turn', run: ['node', 'turn.mjs'] }

interface World {
  sc: Scenario
  home: string
  folder: string
  core: Core
}

async function world(o: { git: boolean; clarify?: boolean }): Promise<World> {
  const sc = await makeScenario({
    ...(o.clarify === true ? { clarify: [{ recording: 'C02-review-shape', text: FENCED }] } : {}),
    plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
    implement: [
      { recording: 'C08a-session-id-implement', write },
      { recording: 'C08a-session-id-implement', write: writeSecond },
    ],
  })
  const { home } = await makeHome(sc)
  const folder = makeSandbox({ git: o.git })
  const marker = join(mkdtempSync(join(tmpdir(), 'dim-match-marker-')), 'running')
  dirs.push(home, sc.dir, folder, marker)
  // Neither committed nor added: a snapshot of the folder as it is carries them.
  writeFileSync(join(folder, 'turn.mjs'), turnScript(marker))
  writeFileSync(join(folder, 'notes-not-committed.txt'), 'in the folder, not in git\n')
  await grantTrust(
    folder,
    { kind: 'command', command: { kind: 'verify', argv: TURN.run, cwdRel: '.' } },
    { home },
  )
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return { sc, home, folder, core }
}

const overrides: RunOverrides = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  isolation: { worktree: { install: 'never' } },
  verify: { enabled: true, baseline: false, commands: [TURN] },
}

const SIDES = [{ vendor: 'claude' }, { vendor: 'claude', model: 'opus' }] as const

const hasCard =
  (kind: CardView['kind']) =>
  (s: RunState): boolean =>
    s.cards.some((c) => c.view.kind === kind)

const passStarts = (entries: FakeLogEntry[]): { cwd: string; argv: string[] }[] =>
  entries
    .filter((e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('-p'))
    .map((e) => ({ cwd: String(e['cwd']), argv: e['argv'] as string[] }))
    .filter((r) => !/probe-cwd[\\/]?$/.test(r.cwd))

async function finished(w: World, m: MatchStarted): Promise<[RunState, RunState]> {
  const wait = async (runId: string): Promise<RunState> => {
    const c = w.core.controller(runId)
    if (c === undefined) throw new Error(`no controller for ${runId}`)
    return c.waitFor(hasCard('finalize'), 45_000).catch(() => {
      // Where the side stands, for a failure that names the cause.
      const s = c.state
      const steps = Object.entries(s.steps)
        .filter(([, st]) => st.status !== 'queued' && st.status !== 'skipped')
        .map(([k, st]) => `${k}=${st.status}${st.failure !== undefined ? ` (${st.failure.message})` : ''}`)
      throw new Error(
        `side ${s.matchOf?.side ?? '?'} did not reach its finalize card: status ${s.status}, phase ${s.phase}, cards [${s.cards
          .map((x) => x.view.kind)
          .join(', ')}], steps ${steps.join('; ')}, notes ${JSON.stringify(s.notes)}`,
      )
    })
  }
  return Promise.all([wait(m.sides[0].runId), wait(m.sides[1].runId ?? '')])
}

describe('Head to head (core + fake Claude)', () => {
  it.each([
    ['a folder that is not a repository', false],
    ['a repository with uncommitted files', true],
  ])(
    '%s: two sides build in their own copies, take turns at Verify, and one is applied',
    async (_name, git) => {
      const w = await world({ git })
      const m = value(
        await w.core.invoke('matches.start', {
          folder: w.folder,
          task: 'add a --version flag',
          overrides,
          sides: [{ ...SIDES[0] }, { ...SIDES[1] }],
        }),
      )
      expect(m.sides.map((s) => s.side)).toEqual(['a', 'b'])
      expect(m.sides[0].runId).not.toBe(m.sides[1].runId)

      const [a, b] = await finished(w, m)
      const paths = homePaths(w.home)
      for (const [s, side] of [
        [a, m.sides[0]],
        [b, m.sides[1]],
      ] as const) {
        // An isolated run in a copy with no branch, made from the match's snapshot.
        expect(s.matchOf).toEqual({ matchId: m.matchId, side: side.side })
        const wt = s.isolation?.worktree
        expect(wt?.path).toBe(paths.worktree(side.runId ?? ''))
        expect(wt?.branch).toBe('')
        expect(existsSync(join(wt?.path ?? '', '.git'))).toBe(false)
        // The folder as it was: untracked and uncommitted files included.
        expect(readFileSync(join(wt?.path ?? '', 'notes-not-committed.txt'), 'utf8')).toContain('not in git')
        expect(existsSync(join(wt?.path ?? '', 'turn.mjs'))).toBe(true)
        // The side built in its copy, and its Verify passed: the two rounds never ran at once.
        expect(readFileSync(join(wt?.path ?? '', 'src', 'version.ts'), 'utf8')).toContain('1.0.0')
        expect(s.steps['verify:1'].status).toBe('done')
        expect(w.core.summary(side.runId ?? '')?.findings.must).toBe(0)
        expect(s.phase).toBe('ready-to-apply')
      }
      // The folder is untouched, and every pass ran in one of the two copies.
      expect(existsSync(join(w.folder, 'src', 'version.ts'))).toBe(false)
      const copies = [a.isolation?.worktree?.path ?? '', b.isolation?.worktree?.path ?? '']
      const starts = passStarts(w.sc.entries())
      expect(starts.length).toBeGreaterThanOrEqual(4)
      for (const r of starts)
        expect(
          copies.some((c) => samePath(r.cwd, c)),
          r.cwd,
        ).toBe(true)
      for (const c of copies) expect(starts.some((r) => samePath(r.cwd, c))).toBe(true)
      // Side B built with its own model.
      const bStarts = starts.filter((r) => samePath(r.cwd, copies[1] ?? ''))
      expect(bStarts.some((r) => r.argv.includes('acceptEdits') && r.argv.includes('opus'))).toBe(true)

      // The record and the view.
      expect(existsSync(matchFile(paths, m.matchId))).toBe(true)
      const view = value(await w.core.invoke('matches.get', { matchId: m.matchId }))
      expect(view).toMatchObject({ matchId: m.matchId, kind: 'headToHead', ready: true, ended: false })
      expect(view.sides.map((s) => [s.side, s.runId, s.contestant.vendor, s.notApplied])).toEqual([
        ['a', m.sides[0].runId, 'claude', true],
        ['b', m.sides[1].runId, 'claude', true],
      ])
      expect(view.sides[1].contestant.model).toBe('opus')
      expect(value(await w.core.invoke('matches.list')).map((v) => v.matchId)).toEqual([m.matchId])
      expect(w.core.summary(m.sides[0].runId)?.matchOf).toEqual({ matchId: m.matchId, side: 'a' })

      // The starting point is held by a ref named for the match until both copies exist; a retention pass drops it.
      const key = (await resolveScope(w.folder)).folderKey
      expect(view.folderKey).toBe(key)
      expect(await listRunRefs(w.home, key)).toContain(m.matchId)
      await w.core.history.retention()
      expect(await listRunRefs(w.home, key)).not.toContain(m.matchId)
      expect(value(await w.core.invoke('matches.get', { matchId: m.matchId })).cleanedAt).toBeTypeOf('number')

      // What each side built, for the comparison: its check, its lines, and that the match shared nothing.
      for (const s of view.sides) {
        expect(s.detail?.checks).toEqual({ passed: 1, failed: 0 })
        expect(s.detail?.lines?.added).toBeGreaterThanOrEqual(1)
        expect(s.detail?.buildMs).toBeGreaterThan(0)
        expect(s.detail?.sharedCostUsd).toBeUndefined()
      }
      expect(view.shared).toBeUndefined()

      // Where they differ: both wrote the same file, and ended with different content. Read from two object stores.
      const cmp = value(await w.core.invoke('matches.compare', { matchId: m.matchId }))
      expect(cmp.available).toEqual({ a: true, b: true, between: true })
      const split = splitCompare(cmp.files)
      expect(split.both.map((f) => f.path)).toEqual(['src/version.ts'])
      expect(split.onlyA).toEqual([])
      expect(split.onlyB).toEqual([])
      const fileA = readFileSync(join(copies[0] ?? '', 'src', 'version.ts'), 'utf8')
      const fileB = readFileSync(join(copies[1] ?? '', 'src', 'version.ts'), 'utf8')
      expect([fileA, fileB].sort()).toEqual([VERSION, SECOND].sort())
      const between = value(
        await w.core.invoke('matches.compareFile', { matchId: m.matchId, path: 'src/version.ts' }),
      )
      expect(between.truncated).toBe(false)
      // The old side is A's result and the new side is B's.
      expect(between.patch).toContain(`${fileA === SECOND ? '-' : '+'}export const built = "second"`)
      expect(between.patch).toContain(' export const version = "1.0.0"')
      const missing = await w.core.invoke('matches.compareFile', { matchId: m.matchId, path: 'nope.ts' })
      expect(missing.ok && missing.value.patch).toBe('')

      // Keeping side A: its changes reach the folder, side B is kept for later with its copy as it is.
      const picked = value(await w.core.invoke('matches.pick', { matchId: m.matchId, side: 'a' }))
      expect(picked.conflicts).toEqual([])
      expect(picked.match.kept).toBe('a')
      expect(picked.match.pick).toMatchObject({ side: 'a' })
      expect(picked.match.pick?.undoToken).toBeTypeOf('string')
      expect(readFileSync(join(w.folder, 'src', 'version.ts'), 'utf8')).toBe(fileA)
      expect(readFileSync(join(copies[1] ?? '', 'src', 'version.ts'), 'utf8')).toBe(fileB)
      const bCtl = w.core.controller(m.sides[1].runId ?? '')
      await bCtl?.waitFor((s) => s.isolation?.finalize?.state === 'kept', 30_000)
      expect(picked.match.sides[0].copyState).toBe('applied')
      const again = await w.core.invoke('matches.pick', { matchId: m.matchId, side: 'b' })
      expect(again.ok).toBe(false)
      if (!again.ok) expect(again.error.message).toBe(MATCH_TEXT.alreadyPicked)

      // Taking the pick back: the folder is as it was, and the other side can be kept instead.
      const undone = value(await w.core.invoke('matches.undoPick', { matchId: m.matchId }))
      expect(undone.pick).toBeUndefined()
      expect(undone.kept).toBeUndefined()
      expect(existsSync(join(w.folder, 'src', 'version.ts'))).toBe(false)
      const other = value(await w.core.invoke('matches.pick', { matchId: m.matchId, side: 'b' }))
      expect(other.match.kept).toBe('b')
      expect(readFileSync(join(w.folder, 'src', 'version.ts'), 'utf8')).toBe(fileB)
      void a
    },
    300_000,
  )

  it('asks once: side A asks, side B starts when it is answered, and both plan from the same answers', async () => {
    const w = await world({ git: false, clarify: true })
    const m = value(
      await w.core.invoke('matches.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: {
          ...overrides,
          verify: { enabled: false },
          passes: { plan: { clarify: true, clarifyQuestions: 3 } },
        },
        // Clarify runs on side A's Plan model, which is how the fake tells it from the other read-only passes.
        sides: [
          { vendor: 'claude', model: 'haiku' },
          { vendor: 'claude', model: 'opus' },
        ],
        blind: true,
      }),
    )
    expect(m.sides[1]).toEqual({ side: 'b' })
    const a = w.core.controller(m.sides[0].runId)
    const asking = await a?.waitFor(hasCard('clarify'), 120_000)
    const waiting = value(await w.core.invoke('matches.get', { matchId: m.matchId }))
    expect(waiting).toMatchObject({ waiting: true, ready: false })
    expect(waiting.blind?.revealedAt).toBeUndefined()
    expect(value(await w.core.invoke('runs.list', {})).items).toHaveLength(1)
    // The starting point is kept while side B has no copy yet, whatever tidying runs meanwhile.
    const key = (await resolveScope(w.folder)).folderKey
    await w.core.history.retention()
    expect(await listRunRefs(w.home, key)).toContain(m.matchId)

    const card = asking?.cards.find((c) => c.view.kind === 'clarify')?.view
    value(
      await w.core.invoke('cards.resolve', {
        runId: m.sides[0].runId,
        cardId: card?.id ?? '',
        choiceId: 'answer',
        input: ['Name and number', ''],
      }),
    )
    // Side B is made from the same snapshot, with side A's answers.
    let bId: string | undefined
    for (let i = 0; i < 300 && bId === undefined; i++) {
      bId = value(await w.core.invoke('matches.get', { matchId: m.matchId })).sides[1].runId
      if (bId === undefined) await new Promise((r) => setTimeout(r, 100))
    }
    expect(bId).toBeTypeOf('string')
    const [sa, sb] = await finished(w, {
      matchId: m.matchId,
      sides: [m.sides[0], { side: 'b', runId: bId ?? '', displayNo: 2 }],
    })
    expect(sb.steps.clarify).toMatchObject({ status: 'skipped', reason: MATCH_TEXT.sharedStep })
    expect(sb.clarify).toEqual(sa.clarify)
    expect(sb.brief).toBe(sa.brief)
    expect(sb.brief).toContain('Which output format should --version print?\n  Answer: Name and number')
    expect(sb.notes).toContain(MATCH_TEXT.sharedNote)
    expect(sb.isolation?.worktree?.branch).toBe('')
    expect(
      readFileSync(join(sb.isolation?.worktree?.path ?? '', 'notes-not-committed.txt'), 'utf8'),
    ).toContain('not in git')
    // Asked once, and both Plan prompts carry the answers.
    const scripts = stdinByScript(w.sc.entries())
    expect(scripts.has('clarify-1.script.jsonl')).toBe(true)
    expect(scripts.has('clarify-2.script.jsonl')).toBe(false)
    for (const plan of ['plan-1.script.jsonl', 'plan-2.script.jsonl']) {
      expect(sent(w.sc, plan)).toContain('Answers to the clarifying questions:')
      expect(sent(w.sc, plan)).toContain('Answer: Name and number')
    }
    expect(
      existsSync(
        homePaths(w.home)
          .run(bId ?? '')
          .output('clarify'),
      ),
    ).toBe(true)
    const view = value(await w.core.invoke('matches.get', { matchId: m.matchId }))
    expect(view).toMatchObject({ waiting: false, ready: true, shared: true })
    expect(view.sides[0].detail).toHaveProperty('sharedCostUsd')
    expect(view.sides[1].detail?.sharedCostUsd).toBeUndefined()

    // Keeping neither: both are kept for later, nothing reaches the folder, and the names are shown.
    const none = value(await w.core.invoke('matches.pick', { matchId: m.matchId, side: 'none' }))
    expect(none.match.pick).toMatchObject({ side: 'none' })
    expect(none.match.blind?.revealedAt).toBeTypeOf('number')
    expect(existsSync(join(w.folder, 'src', 'version.ts'))).toBe(false)
    for (const id of [m.sides[0].runId, bId ?? '']) {
      await w.core.controller(id)?.waitFor((s) => s.isolation?.finalize?.state === 'kept', 30_000)
    }
  }, 300_000)

  it('makes nothing when a side cannot start, and says which side', async () => {
    const w = await world({ git: false })
    const r = await w.core.invoke('matches.start', {
      folder: w.folder,
      task: 'add a --version flag',
      overrides,
      sides: [{ vendor: 'claude' }, { vendor: 'nobody' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION')
      expect(r.error.message).toBe('Side B: nobody is not a vendor Dim Factory knows.')
    }
    expect(value(await w.core.invoke('runs.list', {})).items).toEqual([])
    expect(value(await w.core.invoke('matches.list'))).toEqual([])
    const key = (await resolveScope(w.folder)).folderKey
    expect(await listRunRefs(w.home, key)).toEqual([])
  })
})
