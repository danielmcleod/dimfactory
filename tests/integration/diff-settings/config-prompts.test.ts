// Settings → Prompts and Config file through a real core (prompt lookup, config errors and recovery, Settings; the
// flow "override a prompt for one project"):
//   - a project prompt override applies to that project only (prompts.get source and overrides, config.resolve's
//     template layer), and its reset answers the text it removed so the toast's Undo can save it back
//   - an unknown placeholder is refused with its line; a missing required one is saved with a warning
//   - config.read shows an invalid file's issues at file:line:col, says a last-good copy exists, and Restore last
//     good puts it back
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { cleanup, hermeticEnv, makeSandbox } from '../run/scenario.ts'
import { value } from '../run-branch/helpers.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  for (const d of dirs.splice(0)) {
    try {
      cleanup(d)
    } catch {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
})

async function boot(home?: string): Promise<{ core: Core; home: string }> {
  const h = home ?? mkdtempSync(join(tmpdir(), 'dim-factory-cfg-'))
  if (home === undefined) dirs.push(h)
  const core = await createCore({ home: h, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return { core, home: h }
}

function sandbox(): string {
  const f = makeSandbox()
  dirs.push(f)
  return f
}

describe('prompts and config file (real core)', () => {
  it('override a prompt for one project; reset answers the removed text; Undo saves it back', async () => {
    const { core } = await boot()
    const a = sandbox()
    const b = sandbox()
    const before = value(await core.invoke('prompts.get', { name: 'plan', folder: a }))
    expect(before).toMatchObject({
      source: 'builtin',
      overrides: { user: false, project: false },
      issues: [],
    })
    expect(before.placeholders).toContain('task')

    const refused = await core.invoke('prompts.save', {
      name: 'plan',
      scope: 'project',
      folder: a,
      text: 'Plan for this repo.\n{{tsk}}\n',
    })
    expect(refused.ok ? null : refused.error).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('2:1: Unknown placeholder {{tsk}}') as unknown,
    })

    const mine = 'Plan for this repo only. Keep it short.\n\n{{task}}\n'
    const saved = value(
      await core.invoke('prompts.save', { name: 'plan', scope: 'project', folder: a, text: mine }),
    )
    expect(saved).toMatchObject({
      source: 'project',
      text: mine,
      overrides: { user: false, project: true },
      previous: { scope: 'project', text: null },
      issues: [],
    })
    expect(saved.path).toBe(join(a, '.dimfactory', 'prompts', 'plan.md'))
    // The project that has it, and only that one.
    expect(value(await core.invoke('prompts.get', { name: 'plan', folder: a })).source).toBe('project')
    expect(value(await core.invoke('prompts.get', { name: 'plan', folder: b }))).toMatchObject({
      source: 'builtin',
      overrides: { user: false, project: false },
    })
    expect(value(await core.invoke('prompts.get', { name: 'plan' })).overrides).toEqual({
      user: false,
      project: null,
    })
    const resolvedA = value(await core.invoke('config.resolve', { folder: a }))
    const resolvedB = value(await core.invoke('config.resolve', { folder: b }))
    expect(resolvedA.config.passes.plan.promptTemplate.layer).toBe('project')
    expect(resolvedB.config.passes.plan.promptTemplate.layer).toBe('builtin')

    // Reset with undo.
    const reset = value(
      await core.invoke('prompts.save', { name: 'plan', scope: 'project', folder: a, text: null }),
    )
    expect(reset).toMatchObject({ source: 'builtin', previous: { scope: 'project', text: mine } })
    const undone = value(
      await core.invoke('prompts.save', {
        name: 'plan',
        scope: 'project',
        folder: a,
        text: reset.previous?.text ?? null,
      }),
    )
    expect(undone).toMatchObject({ source: 'project', text: mine })
    expect(readFileSync(join(a, '.dimfactory', 'prompts', 'plan.md'), 'utf8')).toBe(mine)

    // A required placeholder left out is a warning, not a refusal.
    const warned = value(
      await core.invoke('prompts.save', {
        name: 'review',
        scope: 'project',
        folder: b,
        text: 'Review it.\n',
      }),
    )
    expect(warned.issues).toEqual([
      expect.objectContaining({ code: 'missing-required', severity: 'warning', name: 'diff' }),
    ])
    expect(warned.source).toBe('project')
  }, 120_000)

  it('config.read: issues at file:line:col, a last-good copy, Restore last good', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dim-factory-cfg-'))
    dirs.push(home)
    const userFile = join(home, 'dimfactory.json')
    const good = '{\n  "gates": { "afterPlan": true }\n}\n'
    writeFileSync(userFile, good)
    const { core } = await boot(home)
    const ok = value(await core.invoke('config.read', { scope: 'user' }))
    expect(ok).toMatchObject({ path: userFile, exists: true, issues: [], lastGood: true, restorable: true })

    const bad = '{\n  "gates": { "afterPlan": "yes" }\n}\n'
    writeFileSync(userFile, bad)
    const read = value(await core.invoke('config.read', { scope: 'user' }))
    expect(read.text).toBe(bad)
    expect(read.lastGood).toBe(true)
    expect(read.issues).toHaveLength(1)
    expect(read.issues[0]).toMatchObject({ file: userFile, line: 2, severity: 'error' })
    expect(read.issues[0]?.col).toBeGreaterThan(1)

    const restored = value(
      await core.invoke('config.restoreBackup', { scope: 'user', backupId: 'last-good' }),
    )
    expect(restored.changed).toBe(true)
    expect(readFileSync(userFile, 'utf8')).toBe(good)
    expect(value(await core.invoke('config.read', { scope: 'user' })).issues).toEqual([])
  }, 120_000)

  it('config.read of a home with no user file: nothing to restore', async () => {
    const { core } = await boot()
    expect(value(await core.invoke('config.read', { scope: 'user' }))).toMatchObject({
      exists: false,
      lastGood: false,
      restorable: false,
    })
  }, 60_000)
})
