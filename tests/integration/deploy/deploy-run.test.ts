// The Deploy helper through a real core and the fake Claude (no network, no real gh, no real remote):
//   - the Deploy step at the end of a run: planned from the folder (an Express app, target Fly.io), a fresh
//     `acceptEdits` spawn whose prompt names the target and the missing files, the config it wrote reviewed as the
//     Deploy diff segment, deploy.md, and the run still completes clean
//   - Commit to run branch (opt-in per project): only the run's files go into the commit on the run branch, the user's
//     unrelated staged change stays staged; off for a project that did not turn it on
//   - Create PR: a confirmation that does not match the repository or branch is refused with nothing pushed; with the
//     matching one, the branch is pushed (to a local bare repository standing in for the remote) and the fake gh opens
//     the pull request
//   - `dimf deploy <folder>`: the class, the options with the caveats, the checklist and the steps to copy; exit 1
//     when a committed .env file is found; --json; a bad --class is a usage error
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { Core } from '../../../src/core/app-core.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario, stdinByScript } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'
import { settled, value } from '../verify/helpers.ts'

const FAKE_GH = fileURLToPath(new URL('../../fixtures/fake-gh/gh.mjs', import.meta.url))

const cores: Core[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

const SERVER = "const express = require('express')\nconst app = express()\napp.listen(process.env.PORT)\n"
const SERVER_V2 = `${SERVER}app.get('/health', (_req, res) => res.send('ok'))\n`

/** An Express app in a git repo on `main` (the project config, when given, committed with it). */
function expressApp(project?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'dim-run-deploy-'))
  const dir = join(root, 'shop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'shop',
      version: '1.0.0',
      dependencies: { express: '4' },
      scripts: { start: 'node server.js' },
    }),
  )
  writeFileSync(join(dir, 'server.js'), SERVER)
  writeFileSync(join(dir, 'README.md'), 'shop\n')
  if (project !== undefined) {
    mkdirSync(join(dir, '.dimfactory'), { recursive: true })
    writeFileSync(join(dir, '.dimfactory', 'dimfactory.json'), JSON.stringify(project))
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test User')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  dirs.push(dir)
  return dir
}

const FLY_TOML =
  "app = 'shop' # set your app name\nprimary_region = 'ams'\n\n[http_service]\n  internal_port = 3000\n"

const spec: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: { path: 'server.js', content: SERVER_V2 } }],
  deploy: [{ recording: 'C08a-session-id-implement', write: { path: 'fly.toml', content: FLY_TOML } }],
}

const overrides = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  passes: { implement: { deploy: true, deployTarget: 'fly' } },
  ...extra,
})

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

async function boot(home: string, extra: Record<string, string> = {}): Promise<Core> {
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv(extra) })
  cores.push(core)
  return core
}

async function runToEnd(
  core: Core,
  folder: string,
  o: Record<string, unknown>,
): Promise<{ runId: string; status: string; outcome: string | undefined; notes: string[] }> {
  const { runId } = value(
    await core.invoke('runs.start', { folder, task: 'add a health check endpoint', overrides: o }),
  )
  const c = core.controller(runId)
  if (c === undefined) throw new Error('no controller')
  const done = await c.waitFor(settled, 150_000)
  await c.settle(15_000)
  return { runId, status: done.status, outcome: done.outcome, notes: done.notes }
}

describe('the Deploy step (core + fake Claude)', () => {
  it('writes the missing config for the target, reviewed as the Deploy segment; nothing is deployed', async () => {
    const sc = await makeScenario(spec)
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const folder = expressApp()
    const core = await boot(home)
    const r = await runToEnd(core, folder, overrides())
    expect(r.status, JSON.stringify(r.notes)).toBe('completed')

    const snap = value(await core.invoke('runs.get', { runId: r.runId }))
    expect(r.outcome).toBe('clean')
    expect(snap.steps.deploy.status).toBe('done')
    expect(snap.steps.deploy.deploy).toMatchObject({
      phase: 'done',
      target: { id: 'fly', label: 'Fly.io' },
      written: ['fly.toml'],
    })
    expect(snap.steps.deploy.deploy?.cls?.id).toBe('server-app')
    expect(snap.steps.deploy.deploy?.env).toEqual(['PORT'])

    // The prompt: the target, the deliverable, the files to write (fly.toml, Dockerfile, .env.example) and the rules.
    const prompt = sent(sc, 'deploy-1.script.jsonl')
    expect(prompt).toContain('deployed to Fly.io (fly)')
    expect(prompt).toContain('- fly.toml:')
    expect(prompt).toContain('- Dockerfile:')
    expect(prompt).toContain('- .env.example:')
    expect(prompt).toContain('Do not run deploy, login, publish or release commands')
    expect(prompt).toContain('add a health check endpoint')

    // The Deploy segment holds only the config; Implement's holds only the code; Combined holds both.
    const seg = value(await core.invoke('diff.files', { runId: r.runId, seg: 'deploy' }))
    expect(seg.files.map((f) => f.path)).toEqual(['fly.toml'])
    expect(seg.available).toContain('deploy')
    const impl = value(await core.invoke('diff.files', { runId: r.runId, seg: 'implement' }))
    expect(impl.files.map((f) => f.path)).toEqual(['server.js'])
    const all = value(await core.invoke('diff.files', { runId: r.runId, seg: 'combined' }))
    expect(all.files.map((f) => f.path).sort()).toEqual(['fly.toml', 'server.js'])
    expect(
      value(await core.invoke('runs.output', { runId: r.runId, file: 'deploy' })).text.length,
    ).toBeGreaterThan(0)

    // The on-demand report for the folder now finds fly.toml there, and the commit is off (not opted in).
    const report = value(await core.invoke('deploy.inspect', { runId: r.runId }))
    expect(
      report.options.find((o) => o.id === 'fly')?.configs.find((c) => c.path === 'fly.toml')?.present,
    ).toBe(true)
    const preview = value(await core.invoke('git.commitPreview', { runId: r.runId }))
    expect(preview.enabled).toBe(false)
    expect(preview.blocked).toMatch(/Commit is off for this project/)
    expect((await core.invoke('git.commit', { runId: r.runId })).ok).toBe(false)
    // HEAD did not move.
    expect(git(folder, 'log', '--format=%s').trim()).toBe('init')
  }, 200_000)
})

describe('Commit to run branch and Create PR (core, temp repos, fake gh)', () => {
  it("commits only the run's files on its branch, keeps the user's staged change, and opens the PR only when confirmed", async () => {
    const sc = await makeScenario(spec)
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const folder = expressApp({ git: { commit: true, pullRequest: true } })
    // The remote: a GitHub address for show, pushes go to a local bare repository.
    const bare = mkdtempSync(join(tmpdir(), 'dim-run-bare-'))
    dirs.push(join(bare, 'x'))
    git(bare, 'init', '-q', '--bare')
    git(folder, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git')
    git(folder, 'config', 'remote.origin.pushurl', bare)
    const ghLog = join(home, 'gh.log.jsonl')
    const core = await boot(home, { DIM_FACTORY_TEST_GH: FAKE_GH, FAKE_GH_LOG: ghLog })

    const r = await runToEnd(core, folder, overrides({ isolation: { branch: 'runBranch' } }))
    expect(r.status, JSON.stringify(r.notes)).toBe('completed')
    const branch = git(folder, 'symbolic-ref', '--short', 'HEAD').trim()
    expect(branch).not.toBe('main')

    // The user stages an unrelated change before committing.
    writeFileSync(join(folder, 'README.md'), 'shop, my notes\n')
    git(folder, 'add', 'README.md')

    const preview = value(await core.invoke('git.commitPreview', { runId: r.runId }))
    expect(preview).toMatchObject({ enabled: true, where: 'run-branch', branch })
    expect(preview.blocked).toBeUndefined()
    expect(preview.paths.sort()).toEqual(['fly.toml', 'server.js'])
    expect(preview.message.split('\n')[0]?.length).toBeLessThanOrEqual(72)

    // No PR before the commit, and gh is not asked to create anything.
    const early = value(await core.invoke('git.prPreview', { runId: r.runId }))
    expect(early.blocked).toMatch(/Commit the run's changes first/)

    const made = value(await core.invoke('git.commit', { runId: r.runId }))
    expect(made.branch).toBe(branch)
    expect(made.paths).toEqual(['fly.toml', 'server.js'])
    expect(git(folder, 'rev-parse', 'HEAD').trim()).toBe(made.sha)
    expect(git(folder, 'ls-tree', '-r', '--name-only', made.sha).split('\n')).toContain('fly.toml')
    expect(git(folder, 'show', `${made.sha}:README.md`)).toBe('shop\n')
    expect(git(folder, 'diff', '--cached', '--name-only').trim()).toBe('README.md')
    expect(git(folder, 'show', ':README.md')).toBe('shop, my notes\n')
    // Committed once only.
    expect(value(await core.invoke('git.commitPreview', { runId: r.runId })).committed?.sha).toBe(made.sha)
    expect((await core.invoke('git.commit', { runId: r.runId })).ok).toBe(false)

    const pr = value(await core.invoke('git.prPreview', { runId: r.runId }))
    expect(pr).toMatchObject({ enabled: true, remote: 'origin', repo: 'acme/shop', branch, base: 'main' })
    expect(pr.remoteUrl).toBe('https://github.com/acme/shop.git')
    expect(pr.blocked).toBeUndefined()
    expect(pr.gh).toMatchObject({ installed: true, authenticated: true, version: '2.99.0' })
    expect(pr.commands.map((c) => c.command)).toEqual([
      `git push -u origin ${branch}`,
      expect.stringMatching(
        new RegExp(`^gh pr create --base main --head ${branch.replace(/[.]/g, '\\.')} --title `),
      ),
    ])
    const logged = (): string[][] =>
      existsSync(ghLog)
        ? readFileSync(ghLog, 'utf8')
            .trim()
            .split('\n')
            .map((l) => (JSON.parse(l) as { argv: string[] }).argv)
        : []
    expect(logged().some((a) => a[0] === 'pr')).toBe(false)

    // A confirmation for another repository or branch: refused, nothing pushed, gh not asked.
    const wrong = await core.invoke('git.prCreate', {
      runId: r.runId,
      confirm: { remote: 'origin', repo: 'acme/other', branch },
    })
    expect(wrong.ok).toBe(false)
    expect(git(bare, 'for-each-ref', '--format=%(refname)').trim()).toBe('')
    expect(logged().some((a) => a[0] === 'pr')).toBe(false)

    const opened = value(
      await core.invoke('git.prCreate', {
        runId: r.runId,
        confirm: { remote: 'origin', repo: 'acme/shop', branch },
      }),
    )
    expect(opened).toMatchObject({ url: 'https://github.com/acme/shop/pull/7', pushed: true })
    expect(git(bare, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(made.sha)
    const create = logged().find((a) => a[0] === 'pr')
    expect(create?.slice(0, 2)).toEqual(['pr', 'create'])
    expect(create).toEqual(expect.arrayContaining(['--base', 'main', '--head', branch, '--title', pr.title]))
    expect(value(await core.invoke('git.prPreview', { runId: r.runId })).opened?.url).toBe(
      'https://github.com/acme/shop/pull/7',
    )
  }, 200_000)
})

describe('dimf deploy <folder>', () => {
  async function cli(args: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = []
    const home = mkdtempSync(join(tmpdir(), 'dim-run-home-'))
    dirs.push(join(home, 'x'))
    const io: Partial<CliIo> = {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      isTTY: false,
      env: hermeticEnv(),
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    const code = await main(['deploy', ...args, '--home', home], io)
    return { code, out: out.join('\n') }
  }

  it('prints the class, the options with the caveats, the checklist and the steps to copy; runs nothing', async () => {
    const folder = expressApp()
    const r = await cli([folder, '--target', 'fly'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Deliverable: Server app')
    expect(r.out).toContain("Check the provider's current pricing before you deploy")
    expect(r.out).toContain('Pre-flight checklist:')
    expect(r.out).toContain('not checked')
    expect(r.out).toContain('Steps for Fly.io')
    expect(r.out).toMatch(/\$ fly /)
    // Nothing written to the folder.
    expect(git(folder, 'status', '--porcelain').trim()).toBe('')

    const json = await cli([folder, '--json'])
    expect(json.code).toBe(0)
    const report = JSON.parse(json.out) as { cls: { id: string }; options: unknown[] }
    expect(report.cls.id).toBe('server-app')
    expect(report.options.length).toBeGreaterThan(0)
  }, 60_000)

  it('exits 1 when a .env file is committed, and 2 for a bad --class', async () => {
    const folder = expressApp()
    writeFileSync(join(folder, '.env'), 'DATABASE_URL=postgres://u:p@db/x\n')
    git(folder, 'add', '.env')
    git(folder, 'commit', '-q', '-m', 'env')
    const r = await cli([folder])
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('PROBLEM')
    const bad = await cli([folder, '--class', 'spaceship'])
    expect(bad.code).toBe(2)
  }, 60_000)
})
