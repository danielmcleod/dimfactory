// Easy's two one-off model calls end to end on Claude (the real adapter spawning the fake CLI), each only ever made on
// the user's click: "Help me choose" (a vague idea's kind) and "Look it over" (a picture of the page). Both go the read-
// only, ephemeral route Suggest choices uses, in a Dim Factory-owned folder that is removed afterwards. The look sends
// the picture as an image block before the prompt (the SDK's MessageParam content), and its findings join the run's
// preview check as `[should]` findings. A vendor whose adapter takes no pictures is never asked to look.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AdapterRegistry } from '../../../src/core/adapters/registry.ts'
import type { Adapter } from '../../../src/core/adapters/types.ts'
import { chooseSuggester, readOnlyAnswer } from '../../../src/core/brief/suggest.ts'
import type { SuggestDeps } from '../../../src/core/brief/suggest.ts'
import {
  INTENT_LABEL,
  INTENT_NO_VENDOR,
  intentPrompt,
  parseIntentAnswer,
} from '../../../src/core/easy/intent.ts'
import {
  VISUAL_LABEL,
  VISUAL_NO_VENDOR,
  VISUAL_TITLE_PREFIX,
  parseVisualAnswer,
  readVisual,
  recordVisual,
  visualPrompt,
} from '../../../src/core/easy/visual.ts'
import { DimFactoryError } from '../../../src/core/errors.ts'
import { homePaths } from '../../../src/core/home.ts'
import { runPreviewDir } from '../../../src/core/preview/smoke.ts'
import type { PreviewSmokeView } from '../../../src/shared/preview.ts'
import { LOCAL, STDIO, fakeAdapter, fakeSetup, flagValue } from '../adapters/helpers.ts'

const HERE = fileURLToPath(new URL('./fixtures/', import.meta.url))

interface LogEntry {
  pid: number
  kind: string
  argv?: string[]
  cwd?: string
  line?: string
}

interface UserFrame {
  type?: string
  message?: {
    content?: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[]
  }
}

function scenario(script: string): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'easy-calls-scenario-'))
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

async function setup(
  script: string,
  wrap: (a: Adapter) => Adapter = (a) => a,
): Promise<{ deps: SuggestDeps; log: string; home: string }> {
  const fs = await fakeSetup()
  const s = scenario(script)
  const adapter = wrap(fakeAdapter(fs, { vendorEnv: { FAKE_CLI_SCRIPT: s.dir, FAKE_CLI_LOG: s.log } }))
  const registry = new AdapterRegistry()
  registry.register(adapter)
  const home = mkdtempSync(join(tmpdir(), 'easy-calls-home-'))
  return { deps: { home, registry, isReady: () => Promise.resolve(true) }, log: s.log, home }
}

function userFrame(log: LogEntry[], pid: number | undefined): UserFrame | undefined {
  return log
    .filter((e) => e.pid === pid && e.kind === 'stdin')
    .map((e) => JSON.parse(e.line ?? '{}') as UserFrame)
    .find((f) => f.type === 'user')
}

describe('Help me choose on Claude (fake CLI)', () => {
  it('one read-only call in its own folder, the idea in the prompt, the answer read as one of the choices', async () => {
    const { deps, log: logFile, home } = await setup('intent-answer.script.jsonl')
    const idea = 'IDEAMARKER something nice for my bakery'
    const r = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: 'haiku',
      prompt: intentPrompt(idea, ['website', 'app']),
      area: 'easy-intent',
      label: INTENT_LABEL,
      noVendor: INTENT_NO_VENDOR,
    })
    expect(r.vendor).toBe('claude')
    expect(parseIntentAnswer(r.text, ['website', 'app'])).toEqual({
      kind: 'website',
      reason: 'It is about pages for the bakery that people visit.',
    })
    const log = readLog(logFile)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    const argv = start?.argv ?? []
    expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(argv, '--model')).toBe('haiku')
    expect(argv).toContain('--no-session-persistence')
    const cwd = start?.cwd ?? ''
    const owned = norm(join(realpathSync.native(homePaths(home).tmpDir), 'easy-intent'))
    expect(norm(cwd).startsWith(`${owned}/`)).toBe(true)
    expect(existsSync(cwd)).toBe(false)
    const content = userFrame(log, start?.pid)?.message?.content ?? []
    expect(content.map((c) => c.type)).toEqual(['text'])
    expect(content[0]?.text).toContain(idea)
  })

  it('nobody ready: refused with the plain reason, and no process starts', async () => {
    const { deps, log } = await setup('intent-answer.script.jsonl')
    const err = await readOnlyAnswer(
      { ...deps, isReady: () => Promise.resolve(false) },
      {
        vendor: 'claude',
        model: null,
        prompt: 'x',
        area: 'easy-intent',
        label: INTENT_LABEL,
        noVendor: INTENT_NO_VENDOR,
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).message).toBe(INTENT_NO_VENDOR)
    expect(
      existsSync(log) ? readLog(log).filter((e) => e.argv?.includes('--permission-prompts')) : [],
    ).toEqual([])
  })
})

describe('Look it over on Claude (fake CLI)', () => {
  it('sends the picture before the prompt, reads the findings, adds them to the preview check', async () => {
    const { deps, log: logFile, home } = await setup('visual-answer.script.jsonl')
    const runId = 'r-visual'
    const dir = runPreviewDir(homePaths(home), runId)
    mkdirSync(dir, { recursive: true })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    writeFileSync(join(dir, 'smoke.png'), png)
    const smoke = {
      sessionId: 's1',
      runId,
      at: 1,
      url: 'http://127.0.0.1/',
      loaded: true,
      consoleErrors: [],
      failedLoads: [],
      thumbnail: null,
      screenshotPath: join(dir, 'smoke.png'),
      findings: [
        {
          id: 'abc',
          n: 1,
          severity: 'should',
          source: 'preview',
          title: 'The preview page logged a console error: x',
          body: '',
          flags: [],
          round: 1,
        },
      ],
    }
    writeFileSync(join(dir, 'smoke.json'), JSON.stringify(smoke))

    const r = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: null,
      prompt: visualPrompt(),
      area: 'easy-visual',
      images: [join(dir, 'smoke.png')],
      label: VISUAL_LABEL,
      noVendor: VISUAL_NO_VENDOR,
    })
    const findings = parseVisualAnswer(r.text)
    expect(findings?.map((f) => f.title)).toEqual([
      'The grey text on the white hero is hard to read.',
      'The sign-up button is cut off on the right.',
    ])

    const log = readLog(logFile)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    const content = userFrame(log, start?.pid)?.message?.content ?? []
    expect(content.map((c) => c.type)).toEqual(['image', 'text'])
    expect(content[0]?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: png.toString('base64'),
    })
    expect(content[1]?.text).toContain('screenshot of a web page')
    // The picture was copied into the call's own folder, which is gone afterwards; the run's own picture stays.
    expect(existsSync(start?.cwd ?? '')).toBe(false)
    expect(existsSync(join(dir, 'smoke.png'))).toBe(true)

    const written = await recordVisual(homePaths(home), runId, {
      at: 5,
      vendor: r.vendor,
      findings: findings ?? [],
    })
    const after = JSON.parse(readFileSync(join(dir, 'smoke.json'), 'utf8')) as PreviewSmokeView
    // What it answers is what smoke.json now lists (the run's findings take it).
    expect(written).toEqual(after.findings)
    expect(
      after.findings.map((f) => [f.n, f.severity, f.source, f.title.startsWith(VISUAL_TITLE_PREFIX)]),
    ).toEqual([
      [1, 'should', 'preview', false],
      [2, 'should', 'preview', true],
      [3, 'should', 'preview', true],
    ])
    // A second look replaces the first one's findings, never the console errors'.
    await recordVisual(homePaths(home), runId, {
      at: 6,
      vendor: r.vendor,
      findings: (findings ?? []).slice(0, 1),
    })
    const again = JSON.parse(readFileSync(join(dir, 'smoke.json'), 'utf8')) as PreviewSmokeView
    expect(again.findings).toHaveLength(2)
    expect((await readVisual(homePaths(home), runId))?.findings).toHaveLength(1)
  })

  it('a vendor whose adapter takes no pictures is never asked to look: off, with the reason', async () => {
    const { deps } = await setup('visual-answer.script.jsonl', (a) => ({ ...a, acceptsImages: () => false }))
    expect(await chooseSuggester(deps, 'claude', null, { images: true })).toBeNull()
    expect(await chooseSuggester(deps, 'claude', null)).toEqual({ vendor: 'claude', model: null })
    const err = await readOnlyAnswer(deps, {
      vendor: 'claude',
      model: null,
      prompt: 'x',
      area: 'easy-visual',
      images: [fileURLToPath(import.meta.url)],
      label: VISUAL_LABEL,
      noVendor: VISUAL_NO_VENDOR,
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((err as DimFactoryError).code).toBe('UNSUPPORTED')
    expect((err as DimFactoryError).message).toBe(VISUAL_NO_VENDOR)
  })
})
