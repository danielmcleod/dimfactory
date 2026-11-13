// Verify cards and views (cards "trust: Command + body (diff when changed) · [Trust for this project]
// [Skip]", "verifyEnv: [Retry] [Skip verify]"; UI standards: no em dashes in core strings that reach the app), the
// script-body diff, the command line as shown, StepView.verify and the round's output as runs.output serves it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CardView } from '@shared/run.ts'
import {
  VERIFY_ENV_CHOICE,
  bodyDiff,
  commandLine,
  trustCard,
  trustPayloadOf,
  verifyEnvCard,
  verifyEnvStepOf,
} from '@core/supervisor/cards.ts'
import { verifyStepView } from '@core/supervisor/derive.ts'
import { VERIFY_OUTPUT_SERVE_BYTES, readVerifyOutput } from '@core/supervisor/verify-output.ts'

const texts = (c: CardView): string[] => [c.title, c.body, ...c.choices.map((x) => x.label)]

describe('trust card', () => {
  it('untrusted: the command, where and when it runs, its script; no default (never trusted on its own)', () => {
    const c = trustCard('trust-3', {
      step: 'verify:1',
      name: 'test',
      argv: ['pnpm', 'run', 'test'],
      cwdRel: 'packages/app',
      body: 'vitest run',
      trust: 'untrusted',
    })
    expect(c).toMatchObject({ id: 'trust-3', kind: 'trust', blocking: true, title: 'Trust the test check?' })
    expect(c.defaultChoice).toBeUndefined()
    expect(c.body).toBe(
      'Verify wants to run `pnpm run test` in packages/app after Implement. Dim Factory runs only the commands you trust for this project.\n' +
        '\n' +
        'Script: vitest run\n' +
        '\n' +
        'Trust it to run it now and in later runs until its script changes, or skip it this round.',
    )
    expect(trustPayloadOf(c)).toEqual({
      step: 'verify:1',
      name: 'test',
      argv: ['pnpm', 'run', 'test'],
      cwdRel: 'packages/app',
      command: 'pnpm run test',
      body: 'vitest run',
      trust: 'untrusted',
    })
  })

  it('a program run directly (no script) shows no Script line; verify:2 runs after Fix', () => {
    const c = trustCard('trust-1', {
      step: 'verify:2',
      name: 'cargo test',
      argv: ['cargo', 'test'],
      cwdRel: '.',
      body: null,
      trust: 'untrusted',
    })
    expect(c.body).toContain('`cargo test` in the project folder after Fix.')
    expect(c.body).not.toContain('Script:')
  })

  it('changed: the diff against the granted body (payload and body)', () => {
    const c = trustCard('trust-2', {
      step: 'verify:1',
      name: 'lint',
      argv: ['npm', 'run', 'lint'],
      cwdRel: '.',
      body: 'eslint .\necho done',
      trust: 'changed',
      grantedBody: 'eslint src\necho done',
    })
    expect(c.title).toBe('The lint check changed since you trusted it')
    expect((c.payload as { diff: unknown }).diff).toEqual([
      { op: 'del', text: 'eslint src' },
      { op: 'add', text: 'eslint .' },
      { op: 'same', text: 'echo done' },
    ])
    expect(c.body).toContain('Changes:\n- eslint src\n+ eslint .\n')
  })

  it('no em dash in any trust or verifyEnv text', () => {
    const cards = [
      trustCard('a', {
        step: 'verify:1',
        name: 'x',
        argv: ['x'],
        cwdRel: '.',
        body: 'y',
        trust: 'untrusted',
      }),
      trustCard('b', {
        step: 'verify:2',
        name: 'x',
        argv: ['x'],
        cwdRel: 'a/b',
        body: 'y',
        trust: 'changed',
        grantedBody: 'z',
      }),
      verifyEnvCard('c', { step: 'verify:1', commands: [{ name: 'x', argv: ['x'], exitCode: 127 }] }),
      verifyEnvCard('d', { step: 'verify:1', commands: [], failure: 'boom' }),
    ]
    for (const c of cards) for (const t of texts(c)) expect(t).not.toContain('—')
  })
})

describe('verifyEnv card', () => {
  it('lists what could not run (reason, else the exit code); Retry / Skip verify; default Skip verify', () => {
    const c = verifyEnvCard('verifyEnv-4', {
      step: 'verify:2',
      commands: [
        {
          name: 'lint',
          argv: ['npm', 'run', 'lint'],
          exitCode: 127,
          reason: 'A program it runs was not found: eslint',
        },
        { name: 'test', argv: ['npm', 'test'], exitCode: 9009 },
      ],
    })
    expect(c).toMatchObject({
      kind: 'verifyEnv',
      blocking: true,
      title: '2 checks could not run',
      defaultChoice: VERIFY_ENV_CHOICE.skipVerify,
    })
    expect(c.choices.map((x) => [x.id, x.label])).toEqual([
      ['retry', 'Retry'],
      ['skip-verify', 'Skip verify'],
    ])
    expect(c.body).toContain('- lint (`npm run lint`): A program it runs was not found: eslint')
    expect(c.body).toContain('- test (`npm test`): exit 9009')
    expect(verifyEnvStepOf(c)).toBe('verify:2')
  })
})

describe('helpers', () => {
  it('commandLine quotes arguments with spaces or quotes', () => {
    expect(commandLine(['node', 'a b.mjs', 'say "hi"', ''])).toBe('node "a b.mjs" "say \\"hi\\"" ""')
  })

  it('bodyDiff: equal bodies are all `same`; null is an empty body', () => {
    expect(bodyDiff('a\nb', 'a\nb').every((d) => d.op === 'same')).toBe(true)
    expect(bodyDiff(null, 'x')).toEqual([{ op: 'add', text: 'x' }])
    expect(bodyDiff('x', null)).toEqual([{ op: 'del', text: 'x' }])
  })

  it('StepView.verify keeps the renderer fields only (no trust bookkeeping)', () => {
    const view = verifyStepView({
      phase: 'done',
      aborted: true,
      commands: [
        {
          name: 'test',
          argv: ['npm', 'test'],
          cwdRel: '.',
          body: 'vitest',
          trust: 'trusted',
          decision: 'run',
          status: 'fail',
          exitCode: 1,
          durationMs: 3000,
          excerpt: 'FAIL',
          logPath: 'C:/x.log',
          timedOut: true,
        },
      ],
    })
    expect(view).toEqual({
      aborted: true,
      commands: [
        {
          name: 'test',
          argv: ['npm', 'test'],
          status: 'fail',
          exitCode: 1,
          durationMs: 3000,
          excerpt: 'FAIL',
        },
      ],
    })
  })
})

describe('the round output runs.output serves', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the whole file when small; its last 256 KB from a line start, with a note, when large', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dim-factory-output-'))
    const round = join(dir, 'verify-1')
    mkdirSync(round, { recursive: true })
    const run = { verify: (step: string): string => join(dir, step.replace(':', '-')) }
    writeFileSync(join(round, 'output.log'), '$ node check.mjs\nok\n')
    expect((await readVerifyOutput(run, 'verify:1')).text).toBe('$ node check.mjs\nok\n')
    const line = `${'x'.repeat(99)}\n`
    writeFileSync(join(round, 'output.log'), line.repeat(5000) + 'last line\n')
    const { text } = await readVerifyOutput(run, 'verify:1')
    expect(text.startsWith('[Earlier output: ')).toBe(true)
    expect(text.endsWith('last line\n')).toBe(true)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(VERIFY_OUTPUT_SERVE_BYTES + 100)
    expect(text.split('\n')[1]).toBe('x'.repeat(99))
    await expect(readVerifyOutput(run, 'verify:2')).rejects.toThrow()
  })
})
