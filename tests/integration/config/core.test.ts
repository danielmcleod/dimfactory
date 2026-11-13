// The config resolver wired into the core (the config tests), against the fake Claude:
//   - user + project + run layering through `config.resolve`, with provenance file:line
//   - an invalid user file blocks every run (app.config.user, file:line:col + "did you mean") and spawns nothing;
//     Restore last good puts the last valid text back
//   - an invalid project file blocks that folder only (folder.project.config)
//   - a project file that sets auto:true needs the projectAuto grant (folder.trust.projectAuto); an edit voids it
//   - resolved.json carries config, provenance, layer hashes, pricingRef, preflight warnings
//   - the watcher emits `config-changed`; config.save writes a minimal diff with an undo; prompts.save; first launch
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { AppEvent } from '../../../src/shared/ipc.ts'
import type { PreflightReport } from '../../../src/shared/preflight.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { Scenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  await cleanupSettled(dirs.splice(0))
})

/**
 * cleanup(), retried while Windows still holds a folder: a live preflight check that hit its 2 s budget leaves its
 * git child running in the sandbox until it exits on its own.
 */
async function cleanupSettled(list: string[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      cleanup(...list)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 60 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw err
      await delay(250)
    }
  }
}

async function boot(home: string): Promise<Core> {
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return core
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** A home whose dimfactory.json points `vendors.claude` at the fake; returns its `vendors` JSON for rewrites. */
async function setup(): Promise<{ sc: Scenario; home: string; userFile: string; vendorsJson: string }> {
  const sc = await makeScenario({})
  // These tests are about the files themselves: the user file holds only the vendors (no pipeline keys).
  const { home } = await makeHome(sc, undefined, { pipeline: 'defaults' })
  dirs.push(home, sc.dir)
  const userFile = join(home, 'dimfactory.json')
  const vendors = (JSON.parse(readFileSync(userFile, 'utf8')) as { vendors: unknown }).vendors
  return { sc, home, userFile, vendorsJson: JSON.stringify(vendors) }
}

function sandbox(): string {
  const folder = makeSandbox()
  dirs.push(folder)
  return folder
}

function writeProject(folder: string, lines: string[]): string {
  mkdirSync(join(folder, '.dimfactory'), { recursive: true })
  const file = join(folder, '.dimfactory', 'dimfactory.json')
  writeFileSync(file, lines.join('\n'))
  return file
}

const runDirs = (home: string): string[] => {
  const runs = join(home, 'runs')
  return existsSync(runs)
    ? readdirSync(runs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : []
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await delay(25)
  }
}

const ids = (r: PreflightReport, part: 'blocking' | 'warnings' | 'info'): string[] => r[part].map((c) => c.id)

describe('config.resolve: builtin → user → project → run', () => {
  it('layers merge in order and every value says where it came from (file:line)', async () => {
    const { home, userFile, vendorsJson } = await setup()
    const userText = [
      '{',
      '  // my settings',
      `  "vendors": ${vendorsJson},`,
      '  "profile": "claude-only",',
      '  "passes": { "review": { "model": "opus" } },',
      '  "timeouts": { "askMs": 120000 },',
      '}',
    ].join('\n')
    writeFileSync(userFile, userText)
    const folder = sandbox()
    const projectFile = writeProject(folder, [
      '{',
      '  "passes": {',
      '    "review": { "model": "sonnet" },',
      '    "critic": { "enabled": false }',
      '  },',
      '  "gates": { "beforeFix": true }',
      '}',
    ])
    const core = await boot(home)
    const r = await core.invoke('config.resolve', {
      folder,
      overrides: { passes: { plan: { model: 'haiku' } } },
    })
    if (!r.ok) throw new Error(r.error.message)
    const { config, provenance, layers } = r.value
    expect(config.profile).toBe('claude-only')
    expect(provenance['/profile']).toEqual({ source: 'user', file: userFile, line: 4 })
    // The project beats the user; the run beats both.
    expect(config.passes.review.model).toBe('sonnet')
    expect(provenance['/passes/review/model']).toEqual({
      source: 'project',
      file: projectFile,
      line: 3,
      via: 'passes',
    })
    expect(config.passes.critic.enabled).toBe(false)
    expect(config.passes.plan.model).toBe('haiku')
    expect(provenance['/passes/plan/model']).toEqual({ source: 'run', via: 'passes' })
    expect(config.timeouts.askMs).toBe(120000)
    expect(provenance['/timeouts/askMs']).toEqual({ source: 'user', file: userFile, line: 6 })
    expect(config.gates.beforeFix).toBe(true)
    expect(provenance['/gates/beforeFix']).toEqual({ source: 'project', file: projectFile, line: 6 })
    // Fix follows Implement; a null model is left to the CLI.
    expect(provenance['/passes/fix/vendor']).toEqual({ source: 'inherit', via: 'inherit:implement' })
    expect(provenance['/passes/implement/model']?.source).toBe('cli')
    // The vendors section is the user's (the fake Claude).
    expect(config.vendors['claude']?.path).toMatch(/claude/)
    expect(layers.user).toEqual({
      scope: 'user',
      path: userFile,
      exists: true,
      sha256: sha256(userText),
      valid: true,
    })
    expect(layers.project).toMatchObject({ scope: 'project', path: projectFile, exists: true, valid: true })
    expect(r.value.issues).toEqual([])
    expect(r.value.folderKey).toMatch(/^[0-9a-f]{16}$/)
  }, 60_000)

  it('a resolve failure (unknown profile) answers VALIDATION with the file and line', async () => {
    const { home, userFile, vendorsJson } = await setup()
    writeFileSync(userFile, ['{', `  "vendors": ${vendorsJson},`, '  "profile": "thorogh"', '}'].join('\n'))
    const core = await boot(home)
    const r = await core.invoke('config.resolve', {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('VALIDATION')
    expect(r.error.message).toContain('did you mean "thorough"?')
    expect((r.error.details as { issues: unknown[] }).issues).toEqual([
      expect.objectContaining({ pointer: '/profile', source: 'user', file: userFile, line: 3 }),
    ])
    // The same failure blocks a run through run.profile (nothing is created).
    const folder = sandbox()
    const run = await core.invoke('runs.start', { folder, task: 'x' })
    expect(run.ok === false && run.error.code).toBe('PREFLIGHT_BLOCKED')
    const report = (run.ok ? undefined : run.error.details) as PreflightReport
    const profile = report.blocking.find((b) => b.id === 'run.profile')
    expect(profile?.title).toBe('Unknown profile "thorogh"')
    expect(profile?.detail).toContain(`Selected in ${userFile}:3.`)
    expect(runDirs(home)).toEqual([])
  }, 60_000)
})

describe('invalid config files', () => {
  it('an invalid user file blocks every run with file:line:col and "did you mean"; nothing is spawned; Restore last good', async () => {
    const { sc, home, userFile } = await setup()
    const good = readFileSync(userFile, 'utf8')
    const core = await boot(home)
    // Boot loaded the valid file: it is the last-good copy now.
    expect(readFileSync(homePaths(home).lastGoodUserConfig, 'utf8')).toBe(good)
    const typo = '  "passes": { "review": { "modle": "opus" } },'
    const bad = good.replace(/^\{\n/, `{\n${typo}\n`)
    writeFileSync(userFile, bad)
    const col = typo.indexOf('"modle"') + 1
    const folder = sandbox()
    const r = await core.invoke('runs.start', { folder, task: 'add a --version flag' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
    const report = r.error.details as PreflightReport
    const user = report.blocking.find((b) => b.id === 'app.config.user')
    expect(user).toMatchObject({ category: 'config_invalid', title: 'Your dimfactory.json has an error' })
    expect(user?.detail.split('\n')[0]).toBe(
      `${userFile}:2:${col} Unknown key "modle" (did you mean "model"?)`,
    )
    expect(user?.recovery.map((a) => a.id)).toEqual(['app.config.user.open', 'app.config.user.restore'])
    // No vendor or pass check (and no probe) while the file that names the binaries is broken; no run folder.
    const all = [...ids(report, 'blocking'), ...ids(report, 'warnings'), ...ids(report, 'info')]
    expect(all.filter((id) => id.startsWith('vendor.') || id.startsWith('pass.'))).toEqual([])
    expect(report.blocking.map((b) => b.id)).toEqual(['app.config.user'])
    expect(sc.entries().filter((e) => e.kind === 'start')).toEqual([])
    expect(runDirs(home)).toEqual([])
    // The live preflight says the same.
    const live = await core.invoke('preflight.run', { folder })
    expect(live.ok && ids(live.value, 'blocking')).toContain('app.config.user')

    const restored = await core.invoke('config.restoreBackup', { scope: 'user', backupId: 'last-good' })
    if (!restored.ok) throw new Error(restored.error.message)
    expect(restored.value).toMatchObject({ path: userFile, changed: true })
    expect(restored.value.backupId).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{4}$/)
    expect(readFileSync(userFile, 'utf8')).toBe(good)
    const after = await core.invoke('preflight.run', { folder })
    expect(after.ok && ids(after.value, 'blocking')).not.toContain('app.config.user')
    // The broken text is a backup the user can still restore.
    const read = await core.invoke('config.read', { scope: 'user' })
    expect(read.ok && read.value.backups.map((b) => b.kind)).toEqual(['write', 'last-good'])
  }, 60_000)

  it('an invalid project file blocks its folder only', async () => {
    const { home } = await setup()
    const broken = sandbox()
    const line = '  "gates": { "afterPlan": "yes" }'
    const file = writeProject(broken, ['{', line, '}'])
    const fine = sandbox()
    const core = await boot(home)
    const a = await core.invoke('preflight.run', { folder: broken })
    if (!a.ok) throw new Error(a.error.message)
    const block = a.value.blocking.find((b) => b.id === 'folder.project.config')
    expect(block?.category).toBe('config_invalid')
    expect(block?.title).toBe("The project's dimfactory.json has an error")
    expect(block?.detail.startsWith(`${file}:2:${line.indexOf('"yes"') + 1} `)).toBe(true)
    expect(ids(a.value, 'blocking')).not.toContain('app.config.user')
    const b = await core.invoke('preflight.run', { folder: fine })
    expect(b.ok && ids(b.value, 'blocking')).toEqual([])
  }, 60_000)
})

describe('trust: projectAuto', () => {
  it('a project file that turns Auto on needs the grant; editing the file voids it', async () => {
    const { home } = await setup()
    const folder = sandbox()
    const file = writeProject(folder, ['{ "auto": true }'])
    const core = await boot(home)
    const before = await core.invoke('preflight.run', { folder })
    if (!before.ok) throw new Error(before.error.message)
    const check = before.value.blocking.find((b) => b.id === 'folder.trust.projectAuto')
    expect(check).toMatchObject({ category: 'trust_required', title: 'This project turns on Auto mode' })
    expect(check?.recovery.map((a) => a.kind)).toEqual(['grant', 'config_patch'])
    // The grant action carries the version of the file the check showed.
    const shownSha = sha256(readFileSync(file, 'utf8'))
    expect(check?.recovery[0]).toMatchObject({ kind: 'grant', grant: 'projectAuto', projectSha: shownSha })
    const run = await core.invoke('runs.start', { folder, task: 'x' })
    expect(run.ok === false && run.error.code).toBe('PREFLIGHT_BLOCKED')
    // The run layer deciding Auto (either way) needs no grant.
    const off = await core.invoke('preflight.run', { folder, overrides: { auto: false } })
    expect(off.ok && [...ids(off.value, 'blocking'), ...ids(off.value, 'info')]).not.toContain(
      'folder.trust.projectAuto',
    )

    const granted = await core.invoke('trust.set', {
      folder,
      grant: { kind: 'projectAuto', projectSha: shownSha },
      trusted: true,
    })
    if (!granted.ok) throw new Error(granted.error.message)
    expect(granted.value.grants.projectAuto?.projectSha).toBe(sha256(readFileSync(file, 'utf8')))
    const after = await core.invoke('preflight.run', { folder })
    expect(after.ok && ids(after.value, 'blocking')).not.toContain('folder.trust.projectAuto')
    expect(after.ok && ids(after.value, 'info')).toContain('folder.trust.projectAuto')
    const got = await core.invoke('trust.get', { folder })
    expect(got.ok && got.value.grants.projectAuto).toBeDefined()

    writeFileSync(file, '{ "auto": true, "gates": {} }')
    const edited = await core.invoke('preflight.run', { folder })
    const again = edited.ok
      ? edited.value.blocking.find((b) => b.id === 'folder.trust.projectAuto')
      : undefined
    expect(again?.detail).toContain('The file changed since you allowed it')
    const voided = await core.invoke('trust.get', { folder })
    expect(voided.ok && voided.value.grants.projectAuto).toBeUndefined()
    // Allowing the version that was shown no longer works once the file changed.
    const stale = await core.invoke('trust.set', {
      folder,
      grant: { kind: 'projectAuto', projectSha: shownSha },
      trusted: true,
    })
    expect(stale.ok === false && stale.error.code).toBe('CONFLICT')
    const bad = await core.invoke('trust.set', {
      folder,
      grant: { kind: 'projectAuto', projectSha: 'nope' },
      trusted: true,
    })
    expect(bad.ok === false && bad.error.code).toBe('VALIDATION')
  }, 60_000)
})

describe('runs.start writes resolved.json', () => {
  it('config, provenance, layer hashes, pricingRef and the preflight warnings', async () => {
    // The run stops at the plan gate (nothing left running): resolved.json is written before the first spawn.
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host' } })
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const userFile = join(home, 'dimfactory.json')
    const vendors = (JSON.parse(readFileSync(userFile, 'utf8')) as { vendors: unknown }).vendors
    // Thorough, so the run stops at the plan gate (a small task would be Quick by default).
    const userText = `{\n  "vendors": ${JSON.stringify(vendors)},\n  "timeouts": { "askMs": 120000 },\n  "depth": "full"\n}\n`
    writeFileSync(userFile, userText)
    const folder = sandbox()
    const projectText = '{\n  "passes": { "review": { "model": "sonnet" } }\n}\n'
    const projectFile = writeProject(folder, [projectText])
    const core = await boot(home)
    const overrides = { gates: { beforeFix: false } }
    const r = await core.invoke('runs.start', { folder, task: 'add a --version flag', overrides })
    if (!r.ok) throw new Error(r.error.message)
    const c = core.controller(r.value.runId)
    if (c === undefined) throw new Error('no controller')
    const atGate = await c.waitFor((s: RunState) => s.status !== 'running' && s.status !== 'queued', 60_000)
    expect(atGate.status).toBe('waiting')
    const resolved = JSON.parse(readFileSync(homePaths(home).run(r.value.runId).resolvedJson, 'utf8')) as {
      config: { timeouts: { askMs: number }; profile: string }
      provenance: Record<string, { source: string; file?: string; line?: number }>
      layerHashes: { user: string; project: string }
      layers: { run: unknown; project: { path: string } }
      pricingRef: unknown
      preflightWarnings: unknown[]
      estimate: unknown
      patches: unknown[]
      folderKey: string
    }
    expect(resolved.config.timeouts.askMs).toBe(120000)
    expect(resolved.config.profile).toBe('claude-only')
    expect(resolved.provenance['/timeouts/askMs']).toEqual({ source: 'user', file: userFile, line: 3 })
    expect(resolved.provenance['/passes/review/model']).toMatchObject({
      source: 'project',
      file: projectFile,
      line: 2,
    })
    expect(resolved.provenance['/profile']).toEqual({ source: 'default' })
    expect(resolved.layerHashes).toEqual({ user: sha256(userText), project: sha256(projectText) })
    expect(resolved.layers.run).toEqual(overrides)
    expect(resolved.layers.project.path).toBe(projectFile)
    expect(resolved.pricingRef).not.toBeUndefined()
    expect(Array.isArray(resolved.preflightWarnings)).toBe(true)
    expect(resolved.estimate).toBeNull()
    expect(resolved.patches).toEqual([])
    expect(resolved.folderKey).toMatch(/^[0-9a-f]{16}$/)
  }, 120_000)
})

describe('watching, saving, prompts and first launch', () => {
  it('a changed user or project file emits config-changed', async () => {
    const { home, userFile } = await setup()
    const folder = sandbox()
    const projectFile = writeProject(folder, ['{}'])
    const core = await boot(home)
    const events: AppEvent[] = []
    core.bus.attach({ name: 't', global: (g) => events.push(g) })
    // Resolving a folder starts watching its project file.
    expect((await core.invoke('config.resolve', { folder })).ok).toBe(true)
    writeFileSync(userFile, `${readFileSync(userFile, 'utf8')}\n// edited\n`)
    await waitFor(() => events.some((e) => e.kind === 'config-changed' && e.scope === 'user'))
    writeFileSync(projectFile, '{ "gates": { "beforeFix": true } }')
    await waitFor(() =>
      events.some((e) => e.kind === 'config-changed' && e.scope === 'project' && e.folder === folder),
    )
  }, 60_000)

  it('config.save writes a minimal diff to the project file (comments kept) and restoreBackup undoes it', async () => {
    const { home } = await setup()
    const folder = sandbox()
    const original = ['{', '  // team settings', '  "gates": { "beforeFix": true }', '}', ''].join('\r\n')
    const file = writeProject(folder, [original])
    const core = await boot(home)
    const r = await core.invoke('config.save', {
      scope: 'project',
      folder,
      mode: 'row',
      pass: 'review',
      // vendor equals what the layers already give: pruned; model is new: written.
      overrides: { passes: { review: { vendor: 'claude', model: 'opus' } } },
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.changed).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('// team settings')
    expect(text).toContain('\r\n')
    expect(text).not.toMatch(/(^|[^\r])\n/)
    const value = JSON.parse(text.replace(/^\s*\/\/.*$/m, '')) as Record<string, unknown>
    expect(value).toEqual({ gates: { beforeFix: true }, passes: { review: { model: 'opus' } } })
    expect(r.value.diff).toContain('+')
    const resolved = await core.invoke('config.resolve', { folder })
    expect(resolved.ok && resolved.value.provenance['/passes/review/model']?.source).toBe('project')

    // Undo toast: restore the backup of the previous text.
    expect(r.value.backupId).not.toBeNull()
    const undo = await core.invoke('config.restoreBackup', {
      scope: 'project',
      folder,
      backupId: r.value.backupId ?? '',
    })
    expect(undo.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(original)
  }, 60_000)

  it('"Save as project default" writes the chosen profile (new or replacing one), prunes against it, keeps comments', async () => {
    const { home, userFile, vendorsJson } = await setup()
    const folder = sandbox()
    const file = writeProject(folder, ['{ // team default', '  "profile": "fast"', '}', ''])
    const core = await boot(home)
    const r = await core.invoke('config.save', {
      scope: 'project',
      folder,
      mode: 'projectDefault',
      // thorough's review model is opus: redundant under the profile this save writes.
      overrides: { profile: 'thorough', passes: { review: { model: 'opus' } } },
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.diff).toContain('-  "profile": "fast"')
    expect(r.value.diff).toContain('+  "profile": "thorough"')
    expect(readFileSync(file, 'utf8')).toBe('{ // team default\n  "profile": "thorough"\n}\n')
    const resolved = await core.invoke('config.resolve', { folder })
    expect(resolved.ok && resolved.value.config.profile).toBe('thorough')
    expect(resolved.ok && resolved.value.config.passes.review.model).toBe('opus')

    // No project file yet: the profile is written with the rest.
    const fresh = sandbox()
    const created = await core.invoke('config.save', {
      scope: 'project',
      folder: fresh,
      mode: 'projectDefault',
      overrides: { profile: 'thorough', gates: { afterPlan: false } },
    })
    if (!created.ok) throw new Error(created.error.message)
    expect(JSON.parse(readFileSync(join(fresh, '.dimfactory', 'dimfactory.json'), 'utf8'))).toEqual({
      profile: 'thorough',
      gates: { afterPlan: false },
    })

    // The user file: first launch's profile is replaced, not removed.
    writeFileSync(userFile, `{\n  "vendors": ${vendorsJson},\n  "profile": "fast"\n}\n`)
    const user = await core.invoke('config.save', {
      scope: 'user',
      mode: 'projectDefault',
      overrides: { profile: 'claude-only' },
    })
    if (!user.ok) throw new Error(user.error.message)
    expect((JSON.parse(readFileSync(userFile, 'utf8')) as { profile?: string }).profile).toBe('claude-only')
  }, 60_000)

  it("a project save never prunes a team setting for matching the saver's own user file", async () => {
    const { home, userFile, vendorsJson } = await setup()
    writeFileSync(
      userFile,
      `{\n  "vendors": ${vendorsJson},\n  "passes": { "review": { "model": "opus" } }\n}\n`,
    )
    const folder = sandbox()
    const text = [
      '{',
      '  // team: review on opus',
      '  "passes": { "review": { "model": "opus" } }',
      '}',
      '',
    ].join('\n')
    const file = writeProject(folder, [text])
    const core = await boot(home)
    const r = await core.invoke('config.save', {
      scope: 'project',
      folder,
      mode: 'row',
      pass: 'review',
      overrides: { passes: { review: { vendor: 'claude', model: 'opus' } } },
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.changed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(text)
    // And a value only the user file has is written to the project (teammates do not have it).
    const other = sandbox()
    const w = await core.invoke('config.save', {
      scope: 'project',
      folder: other,
      mode: 'row',
      pass: 'review',
      overrides: { passes: { review: { model: 'opus' } } },
    })
    if (!w.ok) throw new Error(w.error.message)
    expect(JSON.parse(readFileSync(join(other, '.dimfactory', 'dimfactory.json'), 'utf8'))).toEqual({
      passes: { review: { model: 'opus' } },
    })
  }, 60_000)

  it('Restore last good twice: the second one reports "already matches" and keeps the good file', async () => {
    const { home, userFile } = await setup()
    const good = readFileSync(userFile, 'utf8')
    const core = await boot(home)
    writeFileSync(userFile, good.replace(/^\{\n/, '{\n  "timeouts": { "stalMs": 1 },\n'))
    const first = await core.invoke('config.restoreBackup', { scope: 'user', backupId: 'last-good' })
    expect(first.ok && first.value.changed).toBe(true)
    expect((await core.invoke('config.resolve', {})).ok).toBe(true)
    const second = await core.invoke('config.restoreBackup', { scope: 'user', backupId: 'last-good' })
    if (!second.ok) throw new Error(second.error.message)
    expect(second.value).toMatchObject({ changed: false, diff: '' })
    expect(readFileSync(userFile, 'utf8')).toBe(good)
  }, 60_000)

  it('two packages of one repo keep their own backups and last-good (Restore last good never crosses)', async () => {
    const { home } = await setup()
    const repo = sandbox()
    const a = join(repo, 'packages', 'a')
    const b = join(repo, 'packages', 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const aText = '{\n  // package A\n  "gates": { "beforeFix": true }\n}\n'
    const bText = '{\n  // package B\n  "isolation": { "branch": "runBranch" }\n}\n'
    const aFile = writeProject(a, [aText])
    writeProject(b, [bText])
    const core = await boot(home)
    const ra = await core.invoke('config.resolve', { folder: a })
    const rb = await core.invoke('config.resolve', { folder: b })
    expect(ra.ok && rb.ok && ra.value.folderKey === rb.value.folderKey).toBe(true)
    // A breaks; restoring it brings back A's own text, not B's.
    writeFileSync(aFile, aText.replace('"beforeFix"', '"beforeFx"'))
    const restored = await core.invoke('config.restoreBackup', {
      scope: 'project',
      folder: a,
      backupId: 'last-good',
    })
    if (!restored.ok) throw new Error(restored.error.message)
    expect(restored.value.changed).toBe(true)
    expect(readFileSync(aFile, 'utf8')).toBe(aText)
    // Backups are per file: B lists none, A lists the broken text it replaced.
    const readA = await core.invoke('config.read', { scope: 'project', folder: a })
    const readB = await core.invoke('config.read', { scope: 'project', folder: b })
    expect(readA.ok && readA.value.backups.map((x) => x.kind)).toEqual(['write', 'last-good'])
    expect(readB.ok && readB.value.backups.map((x) => x.kind)).toEqual(['last-good'])
  }, 60_000)

  it('prompts.save writes a project override (validated, backed up); the resolver uses it', async () => {
    const { home } = await setup()
    const folder = sandbox()
    const core = await boot(home)
    const bad = await core.invoke('prompts.save', {
      name: 'plan',
      scope: 'project',
      folder,
      text: 'Plan it.\n{{tsk}}\n',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.code).toBe('VALIDATION')
      expect(bad.error.message).toContain('2:1: Unknown placeholder {{tsk}}')
      expect(bad.error.message).toContain('did you mean {{task}}?')
    }
    const saved = await core.invoke('prompts.save', {
      name: 'plan',
      scope: 'project',
      folder,
      text: 'Plan this carefully:\n{{task}}\n',
    })
    if (!saved.ok) throw new Error(saved.error.message)
    expect(saved.value).toMatchObject({ name: 'plan', source: 'project', editable: true })
    expect(saved.value.path).toBe(join(folder, '.dimfactory', 'prompts', 'plan.md'))
    const resolved = await core.invoke('config.resolve', { folder })
    expect(resolved.ok && resolved.value.config.passes.plan.promptTemplate.layer).toBe('project')
    const second = await core.invoke('prompts.save', { name: 'plan', scope: 'project', folder, text: null })
    expect(second.ok && second.value.source).toBe('builtin')
    const got = await core.invoke('prompts.get', { name: 'plan', folder })
    expect(got.ok && got.value.source).toBe('builtin')
    const heal = await core.invoke('prompts.get', { name: 'heal' })
    expect(heal.ok === false && heal.error.code).toBe('UNSUPPORTED')
  }, 60_000)

  it('first launch picks claude-only (Codex not ready), writes it once and never overwrites', async () => {
    const { home, userFile } = await setup()
    const core = await boot(home)
    // Boot wrote the editor schema dimfactory.json files can reference with "$schema".
    const schema = JSON.parse(readFileSync(homePaths(home).schemaFile, 'utf8')) as Record<string, unknown>
    expect(schema['allowComments']).toBe(true)
    const out = await core.firstLaunch()
    expect(out).toMatchObject({
      status: 'completed',
      wroteProfile: true,
      selection: { profile: 'claude-only', claudeReady: true, codexReady: false, runnable: true },
    })
    const after = JSON.parse(readFileSync(userFile, 'utf8')) as { profile?: string; vendors?: unknown }
    expect(after.profile).toBe('claude-only')
    expect(after.vendors).toBeDefined()
    const state = JSON.parse(readFileSync(homePaths(home).state, 'utf8')) as {
      firstLaunchCompletedAt: unknown
    }
    expect(typeof state.firstLaunchCompletedAt).toBe('number')
    expect(await core.firstLaunch()).toMatchObject({ status: 'already-done' })
  }, 60_000)
})
