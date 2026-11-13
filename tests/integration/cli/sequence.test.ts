// `dimf run` through the whole Claude-only sequence against fake Claude scenarios (C06 plan → C03/C08a Implement →
// C02-shaped Review ∥ Critic → C08b-shaped Fix): the gate before Fix (--gates approve and the TTY checklist), the
// emptyFindings card (non-TTY stop, then --cards default), the footer, and --json byte-identity with events.jsonl.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import {
  CLI_ENTRY,
  REVIEW_WITH_FINDINGS,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
  stdinByScript,
} from '../run/scenario.ts'
import type { ScenarioSpec } from '../run/scenario.ts'

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function cli(args: string[], o: { input?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: hermeticEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dimf ${args[0]} timed out\n${stdout}\n${stderr}`))
    }, o.timeoutMs ?? 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(o.input ?? '')
  })
}

function onlyRun(home: string): { id: string; dir: string } {
  const runs = join(home, 'runs')
  const ids = readdirSync(runs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  expect(ids).toHaveLength(1)
  return { id: ids[0] ?? '', dir: join(runs, ids[0] ?? '') }
}

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}

const versionWrite = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }
const fixWrite = { path: 'src/version.test.ts', content: 'import "./version"\n' }

const fixedFlow: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C03-accept-edits', write: versionWrite }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  resume: [
    {
      recording: 'C08b-resume-fix',
      write: fixWrite,
      text:
        'Done.\n\nF1 fixed\nF2 fixed\nF3 skipped: not worth the churn\n\n## Summary\n' +
        '`--version` now prints the version. Run `node src/cli.ts --version` to see it. I added a test for it.',
    },
  ],
}

async function setup(spec: ScenarioSpec): Promise<{
  home: string
  folder: string
  sc: Awaited<ReturnType<typeof makeScenario>>
}> {
  const sc = await makeScenario(spec)
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  return { home, folder, sc }
}

describe('dimf run: the full sequence (subprocess, non-TTY)', () => {
  it('--gates approve: Review ∥ Critic → gate before Fix approved with every finding → resumed Fix → exit 0 (Fixed)', async () => {
    const { home, folder, sc } = await setup(fixedFlow)
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--gates',
      'approve',
      '--asks',
      'allow',
      '--set',
      'gates.beforeFix=true',
      '--home',
      home,
    ])
    const out = r.stdout
    expect(r.code, out + r.stderr).toBe(0)
    // Pass headers: who runs, how; Review and Critic stream line by line with their label.
    expect(out).toMatch(/== Review · claude · sonnet · read-only/)
    expect(out).toMatch(/== Critic · claude · opus · read-only/)
    expect(out).toMatch(/^ {2}Review \| - \[must\] `src\/cli\.ts:12`/m)
    expect(out).toMatch(/^ {2}Critic \| NO FINDINGS$/m)
    expect(out).toContain('-- Review done: 2 must · 1 should')
    expect(out).toContain('-- Critic done: no findings')
    // The gate: what Fix receives, then the Fix header with its session line.
    expect(out).toContain('> Before Fix: continue with 3 findings (2 must · 1 should; --gates approve)')
    expect(out).toContain('    - [should] F3 (review) `src/cli.ts:3`: Unused import of `greet`. Remove it.')
    expect(out).toMatch(/== Fix · claude · default model · edits files \(reused the Implement session\)/)
    expect(out).toContain('The run changed 2 files (+2 -0) in total')
    // Footer.
    expect(out).toMatch(/Run #1 completed \(Fixed\) in \d+s · 2 must · 1 should/)
    expect(out).toMatch(/ {2}Review {5}done {6}claude · sonnet · read-only · .* · 2 must · 1 should/)
    expect(out).toMatch(/ {2}Critic {5}done {6}claude · opus · read-only · .* · no findings/)
    expect(out).toMatch(/ {2}Fix {8}done {6}.* · reused the Implement session/)
    expect(out).toContain('-- Fix done: F1 fixed · F2 fixed · F3 skipped')
    expect(out).toContain('  Findings: 2 must · 1 should · Fix got 3 of 3 (F1 fixed · F2 fixed · F3 skipped)')
    expect(out).toContain('  Files changed: 2 (+2 -0)')
    // The last thing printed is Fix's summary for the person, never its report lines.
    expect(out.trimEnd()).toMatch(
      /\nSummary:\n {2}`--version` now prints the version\. Run `node src\/cli\.ts --version` to see it\. I added a test for it\.$/,
    )
    expect(out).toMatch(
      /Tokens: [\d.]+k · Cost: \$\d+\.\d\d \(reported by the CLI; what the tokens would cost on the API, your subscription covers it\)/,
    )
    const fixUser = (stdinByScript(sc.entries()).get('resume-1.script.jsonl') ?? [])
      .map(userText)
      .find((t) => t !== '')
    expect(fixUser).toContain('- [should] F3 (review)')
  }, 150_000)

  it('--json prints envelopes byte-identical to events.jsonl through Review, Critic and Fix', async () => {
    const { home, folder } = await setup(fixedFlow)
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--gates',
      'approve',
      '--asks',
      'allow',
      '--json',
      '--home',
      home,
    ])
    expect(r.code, r.stderr).toBe(0)
    const printed = r.stdout.split('\n').filter((l) => l.trim() !== '')
    const file = readFileSync(join(onlyRun(home).dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(1)
    expect(printed).toEqual(file)
    const bodies = printed.map(
      (l) => (JSON.parse(l) as { body: { t: string; step?: string; file?: string } }).body,
    )
    expect(bodies.some((b) => b.t === 'output' && b.file === 'findings')).toBe(true)
    expect(bodies.some((b) => b.t === 'usage' && b.step === 'fix')).toBe(true)
    expect(r.stderr).toMatch(/Run #1 completed \(Fixed\)/)
  }, 150_000)

  it('an empty Review twice: exit 5 on the emptyFindings card, then `resume --cards default` treats it as none (exit 0)', async () => {
    const { home, folder } = await setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
      review: [
        { recording: 'C02-review-shape', text: '' },
        { recording: 'C02-review-shape', text: '' },
      ],
    })
    const first = await cli(['run', folder, 'add a --version flag', '--gates', 'approve', '--home', home])
    expect(first.code, first.stdout + first.stderr).toBe(5)
    expect(first.stdout).toContain(
      '== Review (attempt 2) · claude · sonnet · read-only · retrying after an empty output',
    )
    expect(first.stdout).toContain('? Review returned nothing')
    expect(first.stdout).toContain('Choices: Retry Review · Treat as no findings')
    expect(first.stdout).toMatch(
      /Waiting on "Review returned nothing"\. Choose "Treat as no findings" with: node \S*dimf\.ts resume \S+ --cards default/,
    )
    const run = onlyRun(home)
    const second = await cli(['resume', run.id, '--cards', 'default', '--home', home])
    expect(second.code, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('> Review returned nothing: Treat as no findings (default)')
    expect(second.stdout).toMatch(/Run #1 completed \(Clean\) in .* · no findings/)
    expect(second.stdout).toMatch(/ {2}Review {5}done .* · no output \(treated as no findings\)/)
  }, 150_000)

  it('Review and Critic both failed: one `resume` retries both (exit 1, then exit 0 Clean)', async () => {
    const { home, folder, sc } = await setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
      review: [{ recording: 'C09b-logged-out' }],
      critic: [{ recording: 'C09b-logged-out' }],
    })
    const first = await cli(['run', folder, 'add a --version flag', '--gates', 'approve', '--home', home])
    expect(first.code, first.stdout + first.stderr).toBe(1)
    const run = onlyRun(home)
    const second = await cli(['resume', run.id, '--gates', 'approve', '--home', home])
    expect(second.code, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('Retrying Review, Critic…')
    expect(second.stdout).toMatch(/Run #1 completed \(Clean\) in .* · no findings/)
    // Each reviewer spawned twice: the failed attempt, then the one retry.
    const reviewers = passArgvs(sc.entries()).filter((a) => a.includes('dontAsk'))
    expect(reviewers.filter((a) => a.includes('sonnet'))).toHaveLength(2)
    expect(reviewers.filter((a) => a.includes('opus'))).toHaveLength(2)
  }, 150_000)
})

// ---- TTY: the checklist at the gate before Fix ---------------------------------------------------------------------

function fakeIo(o: { env: Record<string, string | undefined>; stdin: NodeJS.ReadableStream }): {
  io: Partial<CliIo>
  out: string[]
} {
  const out: string[] = []
  return {
    out,
    io: {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      stdin: o.stdin,
      isTTY: true,
      env: o.env,
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    },
  }
}

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('dimf run (in-process TTY)', () => {
  it('the gate before Fix is a checklist: "3" unticks F3, Enter continues; Fix gets F1 and F2 only', async () => {
    const { home, folder, sc } = await setup({
      ...fixedFlow,
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const stdin = new PassThrough()
    const f = fakeIo({ env: hermeticEnv(), stdin })
    const running = main(
      ['run', folder, 'add a --version flag', '--set', 'gates.beforeFix=true', '--home', home],
      f.io,
    )
    // The plan gate first (numbered prompt): approve.
    await until(() => f.out.some((l) => l.startsWith('Choose 1-')))
    stdin.write('1\n')
    await until(() => f.out.some((l) => l.startsWith('Press Enter to continue with 3 findings')))
    const gate = f.out.join('\n')
    expect(gate).toContain('? 3 findings before Fix: 2 must, 1 should')
    expect(gate).toContain('  [x]  1. [must] (review) `src/cli.ts:12`: --version prints nothing.')
    expect(gate).toContain('  [x]  3. [should] (review) `src/cli.ts:3`: Unused import of `greet`. Remove it.')
    expect(gate).toContain('Fix will receive 2 must · 1 should.')
    expect(gate).toMatch(/a = all, n = none, s = skip Fix, c = cancel the run\./)
    stdin.write('9\n')
    await until(() => f.out.some((l) => l.includes('"9" is not a finding number')))
    stdin.write('3\n')
    await until(() => f.out.some((l) => l.startsWith('Press Enter to continue with 2 findings')))
    expect(f.out.join('\n')).toContain('  [ ]  3. [should] (review)')
    expect(f.out.join('\n')).toContain('Fix will receive 2 must · 0 should.')
    stdin.write('\n')
    const code = await running
    expect(code, f.out.join('\n')).toBe(0)
    const fixUser = (stdinByScript(sc.entries()).get('resume-1.script.jsonl') ?? [])
      .map(userText)
      .find((t) => t !== '')
    expect(fixUser).toContain('- [must] F1 (review)')
    expect(fixUser).toContain('- [must] F2 (review)')
    expect(fixUser).not.toContain('Unused import')
    const findings = JSON.parse(readFileSync(join(onlyRun(home).dir, 'findings.json'), 'utf8')) as {
      selected: Record<string, boolean>
    }
    expect(Object.values(findings.selected)).toEqual([true, true, false])
    expect(f.out.join('\n')).toMatch(/Findings: 2 must · 1 should · Fix got 2 of 3/)
  }, 150_000)
})
