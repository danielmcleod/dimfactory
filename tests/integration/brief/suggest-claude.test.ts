// "Suggest choices" end to end on Claude: the real Claude adapter spawns the fake CLI on the read-only route the
// self-healer uses. The fake log shows the read-only argv (the read-only pass flags plus Bash, PowerShell, WebFetch
// and WebSearch disallowed, no session persistence), a Dim Factory-owned folder under the temp home as cwd (removed
// afterwards), and a prompt that carries the task and the pack's group ids. The answer is validated against the pack;
// an answer that is not JSON is refused.
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BriefFact, BriefInput, Pack } from '../../../src/shared/brief.ts'
import { AdapterRegistry } from '../../../src/core/adapters/registry.ts'
import type { SuggestDeps, SuggestRequest } from '../../../src/core/brief/suggest.ts'
import { SUGGEST_INVALID_JSON, suggestChoices } from '../../../src/core/brief/suggest.ts'
import { DimFactoryError } from '../../../src/core/errors.ts'
import { homePaths } from '../../../src/core/home.ts'
import { readBuiltinPacks } from '../../../src/core/packs/load.ts'
import { LOCAL, STDIO, fakeAdapter, fakeSetup, flagValue } from '../adapters/helpers.ts'

const HERE = fileURLToPath(new URL('./fixtures/', import.meta.url))

interface LogEntry {
  pid: number
  kind: string
  argv?: string[]
  cwd?: string
  line?: string
}

function scenario(suggestScript: string): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'suggest-scenario-'))
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
      {
        match: { argvIncludes: ['auth', 'status'] },
        script: join(LOCAL, 'auth-status.script.jsonl'),
        repeat: true,
      },
      // Only the read-only route passes --permission-prompts (the probe handshake uses --permission-prompt-tool).
      { match: { argvIncludes: ['--permission-prompts'] }, script: join(HERE, suggestScript), repeat: true },
      {
        match: { argvIncludes: ['-p'] },
        script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
        repeat: true,
      },
    ]),
  )
  return { dir, log: join(dir, 'fake.log.jsonl') }
}

const readLog = (file: string): LogEntry[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LogEntry)

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()

const software = readBuiltinPacks().find((v) => v.pack.id === 'software')?.pack as Pack

const TASK = 'SUGGESTTASKMARKER: build a small command line tool in Go that renames photos by date'

function setup(script: string): Promise<{ deps: SuggestDeps; log: string; home: string }> {
  return fakeSetup().then((fs) => {
    const s = scenario(script)
    const adapter = fakeAdapter(fs, { vendorEnv: { FAKE_CLI_SCRIPT: s.dir, FAKE_CLI_LOG: s.log } })
    const registry = new AdapterRegistry()
    registry.register(adapter)
    const home = process.env['DIM_FACTORY_HOME'] ?? mkdtempSync(join(tmpdir(), 'suggest-home-'))
    return { deps: { home, registry, isReady: () => Promise.resolve(true) }, log: s.log, home }
  })
}

function request(): SuggestRequest {
  const brief: BriefInput = {
    category: 'software',
    fields: { styling: { choices: ['plain-css'], source: 'user' } },
  }
  const facts: BriefFact[] = [{ group: 'data', option: 'sqlite', label: 'SQLite', evidence: 'app.db' }]
  return { task: TASK, pack: software, brief, facts, vendor: 'claude', model: 'sonnet' }
}

describe('Suggest choices on Claude (fake CLI)', () => {
  it('answers through a read-only, ephemeral Claude in a Dim Factory-owned folder and validates the answer', async () => {
    const { deps, log: logFile, home } = await setup('suggest-answer.script.jsonl')
    const out = await suggestChoices(deps, request())
    expect(out).toEqual({
      category: 'software',
      vendor: 'claude',
      model: 'sonnet',
      suggestions: [
        { group: 'projectType', choices: ['cli'], reason: 'The task asks for a command line tool.' },
        // "cobol" is not an option of the language group; "styling" is the user's own choice.
        { group: 'language', choices: ['go'], reason: 'Go is named in the task.' },
      ],
    })

    const log = readLog(logFile)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    expect(start).toBeDefined()
    const argv = start?.argv ?? []
    expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(argv, '--permission-prompts')).toBe('none')
    expect(flagValue(argv, '--settings')).toBe('{"disableAllHooks":true}')
    expect(flagValue(argv, '--model')).toBe('sonnet')
    expect(argv).toContain('--no-session-persistence')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).not.toContain('--permission-prompt-tool')
    expect(argv.some((a) => a.startsWith('--session-id') || a.startsWith('--resume'))).toBe(false)
    expect((flagValue(argv, '--disallowedTools') ?? '').split(',').sort()).toEqual(
      [
        'AskUserQuestion',
        'Bash',
        'Edit',
        'Monitor',
        'NotebookEdit',
        'PowerShell',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    )
    expect(argv).not.toContain('--allowedTools')

    // The cwd: a folder of its own under the temp home's tmp/brief-suggest, never the project, removed afterwards.
    const cwd = start?.cwd ?? ''
    const owned = norm(join(realpathSync.native(homePaths(home).tmpDir), 'brief-suggest'))
    expect(norm(cwd).startsWith(`${owned}/`)).toBe(true)
    expect(norm(cwd).startsWith(norm(process.cwd()))).toBe(false)
    expect(existsSync(cwd)).toBe(false)

    // What the model was told: the task, the pack's groups and option ids, the locked fact and the user's choice.
    const user = log
      .filter((e) => e.pid === start?.pid && e.kind === 'stdin')
      .map(
        (e) => JSON.parse(e.line ?? '{}') as { type?: string; message?: { content?: { text?: string }[] } },
      )
      .find((f) => f.type === 'user')
    const prompt = user?.message?.content?.[0]?.text ?? ''
    expect(prompt).toContain('You are helping a user fill in a project brief')
    expect(prompt).toContain(TASK)
    for (const g of software.groups) expect(prompt).toContain(`- ${g.id} (`)
    expect(prompt).toContain('cli = ')
    expect(prompt).toContain('- data: SQLite (app.db)')
    expect(prompt).toContain('- styling: plain-css')
  })

  it('refuses an answer that is not valid JSON', async () => {
    const { deps } = await setup('suggest-invalid.script.jsonl')
    const err = await suggestChoices(deps, request()).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DimFactoryError)
    const ce = err as DimFactoryError
    expect(ce.code).toBe('VALIDATION')
    expect(ce.message.startsWith(SUGGEST_INVALID_JSON)).toBe(true)
    expect(ce.message).toContain('The answer began: ```json')
  })

  it('needs a ready Claude or Codex', async () => {
    const { deps } = await setup('suggest-answer.script.jsonl')
    const err = await suggestChoices({ ...deps, isReady: () => Promise.resolve(false) }, request()).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('UNSUPPORTED')
    expect((err as DimFactoryError).message).toBe('Suggest choices needs Claude or Codex signed in.')
  })
})
