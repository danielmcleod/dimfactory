// The rules held before a tool runs: private files, no writes outside the folder and no network. Each is checked here
// with the same functions the Claude hook and the Codex approval relay call, and each says where it cannot hold.
import { describe, expect, it } from 'vitest'
import {
  GUARDRAIL_INFO,
  GuardrailRuleZ,
  checkRunPlan,
  commandWords,
  guardrailWarnings,
  isInside,
  programsIn,
  refuseCommand,
  refuseEdit,
  refuseOutsideWrite,
  refuseRead,
  refuseWeb,
  strengthAtLeast,
  strengthOf,
  suggestGuardrails,
  testRules,
} from '../../../src/shared/guardrails.ts'
import type { GuardrailRule, RunPlanFacts, ToolPolicy } from '../../../src/shared/guardrails.ts'

const CWD = 'C:\\work\\app'
const policy = (...rules: GuardrailRule[]): ToolPolicy => ({ rules, allowAgentSettings: false })
const PRIVATE: GuardrailRule = { kind: 'privateFiles', paths: ['.env*', 'secrets/**'] }
const OUTSIDE: GuardrailRule = { kind: 'noWritesOutside' }
const NETWORK: GuardrailRule = { kind: 'network', allow: false }

const facts = (o: Partial<RunPlanFacts> = {}): RunPlanFacts => ({
  vendors: ['claude'],
  fullAccess: false,
  isolated: false,
  extensionsInUse: [],
  ...o,
})

describe('private files', () => {
  it('refuses a read tool that names one, in the folder or by its full path', () => {
    expect(refuseRead(policy(PRIVATE), 'C:\\work\\app\\.env', CWD)?.kind).toBe('privateFiles')
    expect(refuseRead(policy(PRIVATE), '.env.local', CWD)?.detail).toBe('This file is private.')
    expect(refuseRead(policy(PRIVATE), 'C:\\Work\\App\\secrets\\key.pem', CWD)).toBeDefined()
    expect(refuseRead(policy(PRIVATE), '**/.env*', CWD)).toBeDefined()
  })

  it('lets other reads through', () => {
    expect(refuseRead(policy(PRIVATE), 'C:\\work\\app\\src\\env.ts', CWD)).toBeUndefined()
    expect(refuseRead(policy(PRIVATE), '**/*.ts', CWD)).toBeUndefined()
    expect(refuseRead(policy(), '.env', CWD)).toBeUndefined()
  })

  it('refuses a shell command whose text names one', () => {
    for (const cmd of [
      'cat .env',
      'Get-Content C:\\work\\app\\.env',
      'type "secrets/key.pem"',
      'node --env-file=.env server.js',
      'grep KEY < .env',
      'x=$(cat ./.env.local)',
    ]) {
      expect(refuseCommand(policy(PRIVATE), cmd, CWD)?.kind, cmd).toBe('privateFiles')
    }
    expect(refuseCommand(policy(PRIVATE), 'npm test', CWD)).toBeUndefined()
    expect(refuseCommand(policy(PRIVATE), 'cat src/env.ts', CWD)).toBeUndefined()
  })

  it('reads a command line into the words that could be paths', () => {
    expect(commandWords('node --env-file=.env "a b.js" && cat x')).toEqual([
      'node',
      '.env',
      'a b.js',
      'cat',
      'x',
    ])
  })

  it('is suggested when the folder has an environment file, from its name alone', () => {
    const got = suggestGuardrails(['.env', 'src/a.ts'])
    expect(got[0]?.rule).toEqual({ kind: 'privateFiles', paths: ['.env*'] })
    expect(suggestGuardrails(['config/.env.production'])[0]?.rule.kind).toBe('privateFiles')
    expect(suggestGuardrails(['src/environment.ts'])).toEqual([])
  })

  it('is tested for free without reading the file', () => {
    const [r] = testRules([PRIVATE], { path: '.env' })
    expect(r).toMatchObject({ applies: true, strength: 'none' })
    expect(r?.outcome).toMatch(/Refused on Claude\. Other AI tools cannot keep this rule\./)
    expect(testRules([PRIVATE], { path: '.env' }, 'claude')[0]?.outcome).toMatch(/Refused before it runs/)
    expect(testRules([PRIVATE], { command: 'cat .env' })[0]?.applies).toBe(true)
    expect(testRules([PRIVATE], { path: 'src/a.ts' })[0]?.applies).toBe(false)
  })
})

describe('no writes outside the folder', () => {
  it('refuses an edit outside the folder, whatever the case on Windows', () => {
    expect(refuseEdit(policy(OUTSIDE), 'C:\\Users\\me\\notes.txt', CWD)?.kind).toBe('noWritesOutside')
    expect(refuseEdit(policy(OUTSIDE), 'C:\\work\\app2\\a.ts', CWD)).toBeDefined()
    expect(refuseEdit(policy(OUTSIDE), '..\\other\\a.ts', CWD)).toBeDefined()
    expect(refuseEdit(policy(OUTSIDE), 'c:/WORK/APP/src/a.ts', CWD)).toBeUndefined()
    expect(refuseEdit(policy(OUTSIDE), 'src\\a.ts', CWD)).toBeUndefined()
  })

  it("lets the AI tool's own plan files through", () => {
    const plans = 'C:\\Users\\me\\.claude\\plans'
    const path = 'C:\\Users\\me\\.claude\\plans\\happy-plan.md'
    expect(refuseEdit(policy(OUTSIDE), path, CWD)).toBeDefined()
    expect(refuseEdit(policy(OUTSIDE), path, CWD, { writable: [plans] })).toBeUndefined()
  })

  it('compares case on other systems', () => {
    expect(isInside('/work/app/a.ts', '/work/app')).toBe(true)
    expect(isInside('/Work/app/a.ts', '/work/app')).toBe(false)
    expect(isInside('/work/app/../app2/a.ts', '/work/app')).toBe(false)
    expect(isInside('/work/app', '/work/app/')).toBe(true)
  })

  it('refuses a wider write grant', () => {
    expect(refuseOutsideWrite(policy(OUTSIDE), 'Write access: /tmp')?.kind).toBe('noWritesOutside')
    expect(refuseOutsideWrite(policy(), 'Write access: /tmp')).toBeUndefined()
  })
})

describe('no network', () => {
  it('refuses the named network programs, also inside a subcommand', () => {
    for (const cmd of [
      'curl https://example.com',
      'wget -q x',
      'Invoke-WebRequest https://x',
      'iwr x',
      '$r = (Invoke-RestMethod https://x)',
      'echo ok && curl.exe x',
      'x=$(curl -s x)',
    ]) {
      expect(refuseCommand(policy(NETWORK), cmd)?.kind, cmd).toBe('network')
    }
  })

  it('leaves package managers, git and words that only mention a program alone', () => {
    for (const cmd of ['npm install', 'git fetch', 'echo curl', 'pip install x']) {
      expect(refuseCommand(policy(NETWORK), cmd), cmd).toBeUndefined()
    }
    expect(programsIn('echo curl | (wget x)')).toEqual(['echo', 'wget'])
  })

  it('refuses web tools', () => {
    expect(refuseWeb(policy(NETWORK), 'https://x')?.detail).toBe('Network access is off for this run.')
    expect(refuseWeb(policy(), 'https://x')).toBeUndefined()
  })

  it('validates strictly', () => {
    expect(GuardrailRuleZ.safeParse({ kind: 'network', allow: false }).success).toBe(true)
    expect(GuardrailRuleZ.safeParse({ kind: 'network', allow: true }).success).toBe(false)
    expect(GuardrailRuleZ.safeParse({ kind: 'noWritesOutside', require: 'none' }).success).toBe(false)
  })
})

describe('strength per vendor', () => {
  it('ranks sandboxed above blocked and none below caught', () => {
    expect(strengthAtLeast('sandboxed', 'blocked')).toBe(true)
    expect(strengthAtLeast('hard', 'sandboxed')).toBe(true)
    expect(strengthAtLeast('none', 'caught')).toBe(false)
  })

  it('claims only what each vendor measured', () => {
    expect(strengthOf('privateFiles', 'claude')).toBe('blocked')
    expect(strengthOf('privateFiles', 'codex')).toBe('none')
    expect(strengthOf('noWritesOutside', 'codex')).toBe('sandboxed')
    expect(strengthOf('noWritesOutside', 'codex', { fullAccess: true })).toBe('none')
    expect(strengthOf('noWritesOutside', 'claude', { fullAccess: true })).toBe('blocked')
    expect(strengthOf('network', 'gemini')).toBe('none')
  })

  it('warns when a vendor in the run cannot keep a rule', () => {
    const [w] = guardrailWarnings([PRIVATE], facts({ passes: [{ vendor: 'codex', fullAccess: false }] }))
    expect(w?.detail).toBe('Codex cannot keep this rule, so it does nothing there.')
    expect(guardrailWarnings([PRIVATE], facts({ passes: [{ vendor: 'claude', fullAccess: true }] }))).toEqual(
      [],
    )
  })

  it('names Approve everything when only that takes the rule away', () => {
    const [w] = guardrailWarnings([OUTSIDE], facts({ passes: [{ vendor: 'codex', fullAccess: true }] }))
    expect(w?.detail).toMatch(/while it approves everything/)
    expect(guardrailWarnings([OUTSIDE], facts({ passes: [{ vendor: 'codex', fullAccess: false }] }))).toEqual(
      [],
    )
  })

  it('blocks rather than warns when the rule requires a strength', () => {
    const rule: GuardrailRule = { ...PRIVATE, require: 'blocked' }
    const run = facts({ vendors: ['codex'], passes: [{ vendor: 'codex', fullAccess: false }] })
    expect(guardrailWarnings([rule], run)).toEqual([])
    expect(checkRunPlan([rule], run)[0]?.detail).toBe(
      'You required this to be blocked. Codex cannot keep it at all.',
    )
    const sandboxed: GuardrailRule = { kind: 'network', allow: false, require: 'sandboxed' }
    expect(
      checkRunPlan([sandboxed], facts({ passes: [{ vendor: 'claude', fullAccess: false }] })),
    ).toHaveLength(1)
  })

  it('states what each new rule cannot stop', () => {
    for (const kind of ['privateFiles', 'noWritesOutside', 'network'] as const) {
      expect(GUARDRAIL_INFO[kind].limit).toMatch(/cannot keep this rule/)
    }
  })
})

describe('the run folder by another spelling', () => {
  // A vendor's tool names the folder's real path (macOS /private/var for /var, a Windows long name for an 8.3 one).
  const short = 'C:\\Users\\RUNNER~1\\app'
  const long = 'C:\\Users\\runneradmin\\app'
  const both = (...rules: GuardrailRule[]): ToolPolicy => ({ ...policy(...rules), folderSpellings: [long] })

  it('a private file named by the real path is still private, for a read and a command', () => {
    expect(refuseRead(both(PRIVATE), `${long}\\.env`, short)?.kind).toBe('privateFiles')
    expect(
      refuseRead(
        { ...policy(PRIVATE), folderSpellings: ['/private/var/t/app'] },
        '/private/var/t/app/secrets/k',
        '/var/t/app',
      )?.kind,
    ).toBe('privateFiles')
    expect(refuseCommand(both(PRIVATE), `type ${long}\\.env.local`, short)?.kind).toBe('privateFiles')
  })

  it('an edit under the real path is inside the folder; one beside it is not', () => {
    expect(refuseEdit(both(OUTSIDE), `${long}\\src\\a.ts`, short)).toBeUndefined()
    expect(refuseEdit(both(OUTSIDE), `${long}-copy\\a.ts`, short)?.kind).toBe('noWritesOutside')
    expect(refuseEdit(policy(OUTSIDE), `${long}\\src\\a.ts`, short)?.kind).toBe('noWritesOutside')
  })
})
