// Settings pure helpers (built-in profiles, schema bounds and semantic rules; prompt templates;
// Settings General / Profiles / Prompts): the renderer's mirrors of core's tables stay equal to them, the timeout
// rules match the schema's, and each Profiles action builds the config.patch ops core expects.
import { describe, expect, it } from 'vitest'
import { DimFactoryConfigZ, validateSemantics } from '@shared/config-schema.ts'
import type { DimFactoryConfig } from '@shared/config-schema.ts'
import {
  BUILTIN_PROFILE_NAMES as CORE_NAMES,
  BUILTIN_PROFILES as CORE_PROFILES,
  PASS_BASE as CORE_BASE,
} from '@core/config/defaults.ts'
import { inverseOps, pointer, valueAt } from '@renderer/pages/settings/general/configWrite.ts'
import {
  formatMinutes,
  parseCount,
  parseMinutes,
  STORAGE_LIMITS,
  TIMEOUT_LIMITS,
  timeoutOrderError,
} from '@renderer/pages/settings/general/limits.ts'
import {
  BUILTIN_PROFILE_NAMES,
  BUILTIN_PROFILES,
  PASS_BASE,
} from '@renderer/pages/settings/profiles/builtins.ts'
import {
  copyName,
  deleteBlocked,
  fileModes,
  inheritOps,
  nameError,
  passView,
  profileEntries,
  projectDefaultBlocked,
  renameOps,
  userDefaultBlocked,
  vendorOps,
} from '@renderer/pages/settings/profiles/model.ts'
import type { ProfileFacts } from '@renderer/pages/settings/profiles/model.ts'
import {
  insertAt,
  issueText,
  issuesFromError,
  offsetOf,
  overWordLimit,
  previousText,
  sourceExplanation,
  wordCount,
} from '@renderer/pages/settings/prompts/model.ts'
import type { PromptView } from '@shared/ipc.ts'

const EM_DASH = '\u2014'

describe('mirrors of core', () => {
  it('the built-in profiles and the per-pass base values equal core’s', () => {
    expect([...BUILTIN_PROFILE_NAMES]).toEqual([...CORE_NAMES])
    expect(JSON.parse(JSON.stringify(BUILTIN_PROFILES))).toEqual(JSON.parse(JSON.stringify(CORE_PROFILES)))
    expect(JSON.parse(JSON.stringify(PASS_BASE))).toEqual(JSON.parse(JSON.stringify(CORE_BASE)))
  })

  const parses = (cfg: DimFactoryConfig): boolean => DimFactoryConfigZ.safeParse(cfg).success

  it.each(Object.entries(TIMEOUT_LIMITS))('timeouts.%s bounds equal the schema’s', (key, { min, max }) => {
    expect(parses({ timeouts: { [key]: min } })).toBe(true)
    expect(parses({ timeouts: { [key]: min - 1 } })).toBe(false)
    expect(parses({ timeouts: { [key]: max } })).toBe(true)
    expect(parses({ timeouts: { [key]: max + 1 } })).toBe(false)
  })

  it.each(Object.entries(STORAGE_LIMITS))('storage.%s bounds equal the schema’s', (key, { min, max }) => {
    expect(parses({ storage: { [key]: min } })).toBe(true)
    expect(parses({ storage: { [key]: min - 1 } })).toBe(false)
    expect(parses({ storage: { [key]: max } })).toBe(true)
    expect(parses({ storage: { [key]: max + 1 } })).toBe(false)
  })

  it('the stall-before-hard-stop rule agrees with core’s semantic check', () => {
    const base = { stallMs: 300_000, hardKillMs: 1_200_000, toolStallMs: 900_000, askMs: 600_000 }
    for (const [key, value] of [
      ['stallMs', 1_200_000],
      ['toolStallMs', 1_300_000],
      ['hardKillMs', 600_000],
      ['hardKillMs', 2_000_000],
      ['stallMs', 60_000],
    ] as const) {
      const next = { ...base, [key]: value }
      const core = validateSemantics({ timeouts: next }, { scope: 'user' }).some(
        (i) => i.code === 'timeout-order',
      )
      expect(timeoutOrderError(key, next) !== null, `${key}=${value}`).toBe(core)
    }
  })
})

describe('General number fields', () => {
  it('reads minutes and checks the bounds', () => {
    expect(parseMinutes('5', 'stallMs')).toEqual({ ok: true, value: 300_000 })
    expect(parseMinutes('0.5', 'stallMs')).toEqual({ ok: true, value: 30_000 })
    expect(parseMinutes('2,5', 'askMs')).toEqual({ ok: true, value: 150_000 })
    expect(parseMinutes('0.25', 'stallMs')).toEqual({ ok: false, message: 'At least 0.5 min.' })
    expect(parseMinutes('61', 'stallMs')).toEqual({ ok: false, message: 'At most 60 min.' })
    expect(parseMinutes('abc', 'stallMs')).toEqual({ ok: false, message: 'Enter a number of minutes.' })
    expect(parseMinutes('-1', 'stallMs').ok).toBe(false)
    expect(formatMinutes(300_000)).toBe('5')
    expect(formatMinutes(30_000)).toBe('0.5')
  })

  it('reads whole counts and checks the bounds', () => {
    expect(parseCount('300', 'keepRuns')).toEqual({ ok: true, value: 300 })
    expect(parseCount('0', 'rawLogDays')).toEqual({ ok: true, value: 0 })
    expect(parseCount('0', 'keepDays')).toEqual({ ok: false, message: 'At least 1.' })
    expect(parseCount('100001', 'keepRuns')).toEqual({ ok: false, message: 'At most 100,000.' })
    expect(parseCount('1.5', 'keepRuns')).toEqual({ ok: false, message: 'Enter a whole number.' })
  })

  it('words the timeout order rule for the field being changed', () => {
    const t = { stallMs: 300_000, hardKillMs: 1_200_000, toolStallMs: 900_000, askMs: 600_000 }
    expect(timeoutOrderError('stallMs', { ...t, stallMs: 1_200_000 })).toBe(
      'Must be shorter than the hard stop (20 min).',
    )
    expect(timeoutOrderError('hardKillMs', { ...t, hardKillMs: 600_000 })).toBe(
      'Must be longer than the tool limit (15 min).',
    )
    expect(timeoutOrderError('hardKillMs', { ...t, hardKillMs: 240_000 })).toBe(
      'Must be longer than the stall warning (5 min) and the tool limit (15 min).',
    )
    expect(timeoutOrderError('askMs', { ...t, askMs: 3_600_000 })).toBeNull()
  })
})

describe('config pointers and undo ops', () => {
  it('escapes pointer segments and reads values', () => {
    expect(pointer('profiles', 'a/b', 'x~y')).toBe('/profiles/a~1b/x~0y')
    expect(valueAt({ profiles: { 'a/b': { x: 1 } } }, '/profiles/a~1b/x')).toBe(1)
    expect(valueAt({}, '/profiles/mine')).toBeUndefined()
  })

  it('puts back what the ops replaced, in reverse', () => {
    const before = { profile: 'old', profiles: { old: { plan: {} } } }
    expect(inverseOps(before, renameOps('old', 'new', { plan: {} }, 'old'))).toEqual([
      { op: 'replace', path: '/profile', value: 'old' },
      { op: 'replace', path: '/profiles/old', value: { plan: {} } },
      { op: 'remove', path: '/profiles/new' },
    ])
  })
})

describe('Profiles model', () => {
  const user = { profile: 'mine', profiles: { mine: { implement: { vendor: 'claude', mode: 'autoedit' } } } }
  const project = { profiles: { team: { plan: { vendor: 'claude', model: 'opus' } } } }

  it('lists built-ins, then yours, then the project’s, each with its scope', () => {
    const entries = profileEntries(user, project)
    expect(entries.map((e) => [e.name, e.scope])).toEqual([
      ['balanced', 'builtin'],
      ['claude-only', 'builtin'],
      ['codex-only', 'builtin'],
      ['fast', 'builtin'],
      ['thorough', 'builtin'],
      ['mine', 'user'],
      ['team', 'project'],
    ])
    expect(profileEntries(user, null).some((e) => e.name === 'team')).toBe(false)
    expect(entries.find((e) => e.name === 'mine')?.own).toEqual(user.profiles.mine)
    expect(entries.find((e) => e.name === 'balanced')?.own).toBeNull()
  })

  it('reads a pass with the base values, and Fix as Implement’s while it inherits', () => {
    expect(passView(BUILTIN_PROFILES.fast, 'plan')).toEqual({
      vendor: 'claude',
      model: 'sonnet',
      effort: null,
      extensions: 'none',
      mode: 'readonly',
      enabled: false,
    })
    const fix = passView(BUILTIN_PROFILES.balanced, 'fix')
    expect(fix).toMatchObject({ vendor: 'codex', model: null, mode: 'autoedit', sameAsImplement: true })
    expect(passView(BUILTIN_PROFILES.thorough, 'fix').reuseSession).toBe(false)
    const own = passView({ implement: { vendor: 'codex', model: 'gpt' }, fix: { vendor: 'claude' } }, 'fix')
    expect(own).toMatchObject({ vendor: 'claude', model: null, sameAsImplement: false })
  })

  it('offers only the modes a file may hold', () => {
    expect(fileModes('review')).toEqual(['readonly'])
    expect(fileModes('implement')).toEqual(['readonly', 'autoedit'])
  })

  it('checks new names and finds a free copy name', () => {
    expect(nameError('My Profile', [])).toMatch(/lowercase letters/)
    expect(nameError('balanced', ['balanced'])).toBe('A profile called balanced already exists.')
    expect(nameError('mine', ['mine'], 'mine')).toBeNull()
    expect(nameError('', [])).toBe('Enter a name.')
    expect(copyName('balanced', ['balanced', 'balanced-copy'])).toBe('balanced-copy-2')
    const long = 'a'.repeat(32)
    expect(copyName(long, [long]).length).toBeLessThanOrEqual(32)
    expect(nameError(copyName(long, [long]), [long])).toBeNull()
  })

  it('builds the vendor and inherit ops', () => {
    expect(vendorOps('mine', 'plan', 'codex')).toEqual([
      { op: 'replace', path: '/profiles/mine/plan/vendor', value: 'codex' },
      { op: 'replace', path: '/profiles/mine/plan/model', value: null },
      { op: 'replace', path: '/profiles/mine/plan/effort', value: null },
    ])
    expect(inheritOps('mine', true, passView({}, 'fix'))).toEqual([
      { op: 'replace', path: '/profiles/mine/fix/inherit', value: 'implement' },
      { op: 'remove', path: '/profiles/mine/fix/vendor' },
      { op: 'remove', path: '/profiles/mine/fix/model' },
      { op: 'remove', path: '/profiles/mine/fix/effort' },
      { op: 'remove', path: '/profiles/mine/fix/mode' },
      { op: 'remove', path: '/profiles/mine/fix/extensions' },
    ])
    const current = passView(BUILTIN_PROFILES['claude-only'], 'fix')
    expect(inheritOps('mine', false, current)).toEqual([
      { op: 'replace', path: '/profiles/mine/fix/inherit', value: null },
      { op: 'replace', path: '/profiles/mine/fix/vendor', value: 'claude' },
      { op: 'replace', path: '/profiles/mine/fix/model', value: null },
      { op: 'replace', path: '/profiles/mine/fix/effort', value: null },
      { op: 'replace', path: '/profiles/mine/fix/mode', value: 'autoedit' },
      { op: 'replace', path: '/profiles/mine/fix/extensions', value: 'passthrough' },
    ])
  })

  it('says why an action is not available', () => {
    const entries = profileEntries(user, project)
    const facts = (name: string, folder: string | null = 'C:\\p'): ProfileFacts => ({
      entry: entries.find((e) => e.name === name) as ProfileFacts['entry'],
      userDefault: 'mine',
      userFileDefault: 'mine',
      projectDefault: 'team',
      folder,
    })
    expect(deleteBlocked(facts('balanced'))).toMatch(/Built-in profiles cannot be deleted/)
    expect(deleteBlocked(facts('mine'))).toMatch(/your default profile/)
    expect(deleteBlocked(facts('team'))).toMatch(/this project's default/)
    expect(userDefaultBlocked(facts('team'))).toMatch(/other folders do not have it/)
    expect(userDefaultBlocked(facts('balanced'))).toBeNull()
    expect(projectDefaultBlocked(facts('mine'))).toMatch(/Teammates do not have your own profiles/)
    expect(projectDefaultBlocked(facts('balanced', null))).toBe('Choose a project first.')
    expect(projectDefaultBlocked(facts('balanced'))).toBeNull()
    for (const f of [deleteBlocked, userDefaultBlocked, projectDefaultBlocked])
      for (const n of ['balanced', 'mine', 'team']) expect(f(facts(n)) ?? '').not.toContain(EM_DASH)
  })
})

describe('Prompts model', () => {
  const view = (over: Partial<PromptView> = {}): PromptView => ({
    name: 'implement',
    text: 'Do {{task}}',
    source: 'builtin',
    path: null,
    defaultText: 'Do {{task}}',
    allowed: ['task', 'plan'],
    required: ['task', 'plan'],
    wordCount: 2,
    editable: true,
    ...over,
  })

  it('counts words as core does and warns on Implement only', () => {
    expect(wordCount('  a  b\n\tc ')).toBe(3)
    expect(overWordLimit('implement', 201)).toBe(true)
    expect(overWordLimit('implement', 200)).toBe(false)
    expect(overWordLimit('plan', 500)).toBe(false)
  })

  it('inserts at the cursor and finds a line', () => {
    expect(insertAt('ab', 1, 1, '{{task}}')).toEqual({ text: 'a{{task}}b', caret: 9 })
    expect(insertAt('abc', 0, 3, 'x')).toEqual({ text: 'x', caret: 1 })
    expect(offsetOf('one\ntwo\nthree', 3, 2)).toBe(9)
  })

  it('words issues with their line and reads core’s refusal details', () => {
    expect(issueText({ line: 3, col: 5, message: 'Unknown placeholder {{tsk}}' })).toBe(
      'Line 3, column 5: Unknown placeholder {{tsk}}',
    )
    expect(issueText({ message: 'Whole text' })).toBe('Whole text')
    const details = [
      { code: 'unknown-placeholder', severity: 'error', message: 'Bad', line: 2, col: 1, file: 'x' },
    ]
    expect(issuesFromError(details, 'm')).toEqual([
      { code: 'unknown-placeholder', severity: 'error', message: 'Bad', line: 2, col: 1 },
    ])
    expect(issuesFromError(undefined, 'Refused')).toEqual([
      { code: 'invalid', severity: 'error', message: 'Refused' },
    ])
  })

  it('undoes to what the scope held before', () => {
    expect(previousText(view(), view({ previous: { scope: 'project', text: 'old' } }), 'project')).toBe('old')
    expect(previousText(view({ source: 'user', text: 'mine' }), view(), 'user')).toBe('mine')
    expect(previousText(view({ source: 'user', text: 'mine' }), view(), 'project')).toBeNull()
  })

  it('explains which template a scope uses, without em dashes', () => {
    const texts = [
      sourceExplanation(view(), 'user', 'app'),
      sourceExplanation(view({ source: 'user', path: 'C:\\h\\prompts\\implement.md' }), 'user', 'app'),
      sourceExplanation(
        view({ source: 'project', path: 'C:\\app\\.dimfactory\\prompts\\implement.md' }),
        'project',
        'app',
      ),
      sourceExplanation(view({ source: 'user', path: 'C:\\h\\prompts\\implement.md' }), 'project', 'app'),
      sourceExplanation(view(), 'project', 'app'),
    ]
    expect(texts[2]).toContain('Runs in app use it instead of yours and the built-in one')
    expect(texts[4]).toContain('app has no template of its own yet: it uses the built-in one')
    for (const t of texts) expect(t).not.toContain(EM_DASH)
  })
})
