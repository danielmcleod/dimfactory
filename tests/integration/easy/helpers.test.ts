// Easy's beginner helpers that ask a model, end to end on Claude (the real adapter spawning the fake CLI), each only on
// the user's click: one round of "Help me think it through" (a Dim Factory-owned folder, removed afterwards, answered in
// Clarify's shape) and "Ask about it" (the read-only route in the project's own folder: no edit, shell or web tools,
// nothing kept, and the folder left exactly as it was). The prompt check's "Sharpen it" takes the same route as the
// first: its own folder, never the project's.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AdapterRegistry } from '../../../src/core/adapters/registry.ts'
import { readOnlyAnswer } from '../../../src/core/brief/suggest.ts'
import type { SuggestDeps } from '../../../src/core/brief/suggest.ts'
import { ASK_LABEL, ASK_NO_VENDOR, askAnswerText, askPrompt } from '../../../src/core/easy/ask.ts'
import { THINK_LABEL, THINK_NO_VENDOR, parseThinkAnswer, thinkPrompt } from '../../../src/core/easy/think.ts'
import { DimFactoryError } from '../../../src/core/errors.ts'
import {
  SHARPEN_LABEL,
  SHARPEN_NO_VENDOR,
  parseSharpenAnswer,
  sharpenPrompt,
} from '../../../src/core/prompt-check/sharpen.ts'
import { checkPrompt } from '../../../src/shared/prompt-check.ts'
import { homePaths } from '../../../src/core/home.ts'
import { LOCAL, STDIO, fakeAdapter, fakeSetup, flagValue } from '../adapters/helpers.ts'

const HERE = fileURLToPath(new URL('./fixtures/', import.meta.url))

interface LogEntry {
  pid: number
  kind: string
  argv?: string[]
  cwd?: string
  line?: string
}

function scenario(script: string): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'easy-helpers-scenario-'))
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
      {
        match: { argvIncludes: ['auth', 'status'] },
        script: join(LOCAL, 'auth-status.script.jsonl'),
        repeat: true,
      },
      { match: { argvIncludes: ['--permission-prompts'] }, script: join(HERE, script), repeat: true },
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

async function setup(script: string): Promise<{ deps: SuggestDeps; log: string; home: string }> {
  const fs = await fakeSetup()
  const s = scenario(script)
  const adapter = fakeAdapter(fs, { vendorEnv: { FAKE_CLI_SCRIPT: s.dir, FAKE_CLI_LOG: s.log } })
  const registry = new AdapterRegistry()
  registry.register(adapter)
  const home = mkdtempSync(join(tmpdir(), 'easy-helpers-home-'))
  return { deps: { home, registry, isReady: () => Promise.resolve(true) }, log: s.log, home }
}

function promptOf(log: LogEntry[], pid: number | undefined): string {
  const frame = log
    .filter((e) => e.pid === pid && e.kind === 'stdin')
    .map((e) => JSON.parse(e.line ?? '{}') as { type?: string; message?: { content?: { text?: string }[] } })
    .find((f) => f.type === 'user')
  return frame?.message?.content?.[0]?.text ?? ''
}

describe('Help me think it through on Claude (fake CLI)', () => {
  it('one round: read-only in its own folder, the idea and answers in the prompt, a question with directions', async () => {
    const { deps, log: logFile, home } = await setup('think-answer.script.jsonl')
    const idea = 'THINKMARKER something for my bakery'
    const turns = [{ question: 'Who is it for?', options: ['Regulars', 'Tourists'], answer: 'Regulars' }]
    const r = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: null,
      prompt: thinkPrompt(idea, turns, false),
      area: 'easy-think',
      label: THINK_LABEL,
      noVendor: THINK_NO_VENDOR,
    })
    expect(parseThinkAnswer(r.text, { idea, turns, last: false })).toEqual({
      step: 'ask',
      question: 'How should people find out what you bake?',
      options: [
        "One page with today's bread: quick to make, but no ordering",
        'A page with an order form: more work, but people can order ahead',
      ],
    })
    const log = readLog(logFile)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    expect(flagValue(start?.argv ?? [], '--permission-mode')).toBe('dontAsk')
    const cwd = start?.cwd ?? ''
    const owned = norm(join(realpathSync.native(homePaths(home).tmpDir), 'easy-think'))
    expect(norm(cwd).startsWith(`${owned}/`)).toBe(true)
    expect(existsSync(cwd)).toBe(false)
    const prompt = promptOf(log, start?.pid)
    expect(prompt).toContain(idea)
    expect(prompt).toContain('They said: Regulars')
  })
})

describe('Sharpen it on Claude (fake CLI)', () => {
  it('one call: read-only in its own folder, the task and the hints in the prompt, the rewrite with blanks back', async () => {
    const { deps, log: logFile, home } = await setup('sharpen-answer.script.jsonl')
    const task = 'SHARPMARKER fix the export'
    const hints = checkPrompt({ task, folder: 'project', recipe: 'bug-fix' })
    const r = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: 'haiku',
      prompt: sharpenPrompt(task, hints),
      area: 'task-sharpen',
      label: SHARPEN_LABEL,
      noVendor: SHARPEN_NO_VENDOR,
    })
    const sharpened = parseSharpenAnswer(r.text)
    expect(sharpened).toBe(
      'SHARPMARKER fix the export on the [which page?] page. It should [what should happen instead?].',
    )
    expect(checkPrompt({ task: sharpened ?? '', folder: 'project' })[0]?.kind).toBe('blanks')
    const log = readLog(logFile)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    const argv = start?.argv ?? []
    expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(argv, '--model')).toBe('haiku')
    expect(argv).toContain('--no-session-persistence')
    const cwd = start?.cwd ?? ''
    const owned = norm(join(realpathSync.native(homePaths(home).tmpDir), 'task-sharpen'))
    expect(norm(cwd).startsWith(`${owned}/`)).toBe(true)
    expect(existsSync(cwd)).toBe(false)
    const prompt = promptOf(log, start?.pid)
    expect(prompt).toContain(task)
    expect(prompt).toContain('What a check noticed about it:')
  })
})

describe('Ask about it on Claude (fake CLI)', () => {
  it("reads the project's own folder on the read-only route, keeps nothing and leaves the folder as it was", async () => {
    const { deps, log: logFile } = await setup('ask-answer.script.jsonl')
    const project = mkdtempSync(join(tmpdir(), 'easy-helpers-project-'))
    writeFileSync(join(project, 'index.html'), '<!doctype html><title>Bakery</title>')
    writeFileSync(join(project, 'styles.css'), ':root { --accent: tan }')
    const before = readdirSync(project).sort()
    const r = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: 'haiku',
      prompt: askPrompt('ASKMARKER how do I change the colours?'),
      area: 'easy-ask',
      folder: project,
      label: ASK_LABEL,
      noVendor: ASK_NO_VENDOR,
    })
    expect(askAnswerText(r.text)).toBe(
      'The colours are set at the top of **styles.css**: change the line that says `--accent`.',
    )
    const log = readLog(logFile)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    const argv = start?.argv ?? []
    expect(norm(realpathSync.native(start?.cwd ?? ''))).toBe(norm(realpathSync.native(project)))
    expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(argv, '--model')).toBe('haiku')
    expect(argv).toContain('--no-session-persistence')
    const cut = (flagValue(argv, '--disallowedTools') ?? '').split(',')
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'])
      expect(cut).toContain(tool)
    expect(promptOf(log, start?.pid)).toContain('ASKMARKER how do I change the colours?')
    // The project folder is never removed or added to.
    expect(existsSync(project)).toBe(true)
    expect(readdirSync(project).sort()).toEqual(before)
  })

  it('a call that reads a project folder takes no pictures', async () => {
    const { deps } = await setup('ask-answer.script.jsonl')
    const err = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: null,
      prompt: 'x',
      area: 'easy-ask',
      folder: tmpdir(),
      images: [fileURLToPath(import.meta.url)],
      label: ASK_LABEL,
      noVendor: ASK_NO_VENDOR,
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('INTERNAL')
  })
})
