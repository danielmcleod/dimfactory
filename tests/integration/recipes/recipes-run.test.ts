// Recipes through a real core and the CLI (the fake Claude):
//   - a user recipe that turns Research on: the run researches (its research card), the run records the recipe
//     (summary, resolved.json, provenance `recipe`), and Re-run takes the frozen config and shows the same recipe even
//     after the recipe file changed
//   - a recipe's explicit Research switch sits above the brief pack's own default (research-writing researches)
//   - a project recipe that turns Auto on blocks at preflight until its grant (bound to the file's sha256: an edit
//     voids it); a verify command it adds is not trusted on its own; a user recipe needs no grant
//   - an unknown recipe id is VALIDATION with a did-you-mean
//   - CLI: `dimf run --recipe <id>` runs the recipe's Research step and names the recipe; `dimf recipes` lists the
//     layers; `dimf config trust <folder> recipeAuto --recipe <id>` grants it
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PreflightReport } from '../../../src/shared/preflight.ts'
import { CLI_ENTRY, cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { PassScript, ScenarioSpec } from '../run/scenario.ts'
import { VerifyWorld, openCard, value } from '../verify/helpers.ts'

const world = new VerifyWorld()
const dirs: string[] = []
afterEach(async () => {
  await world.dispose()
  cleanup(...dirs.splice(0))
})

const ANSWER = {
  summary: ['Version flags are table stakes for command line tools.'],
  features: [
    { feature: 'Print the version with --version', priority: 'must', sources: ['https://clig.dev/#help'] },
  ],
  standards: [],
  options: [],
  risks: [],
  questions: [],
  sources: [{ url: 'https://clig.dev/#help', title: 'Command Line Interface Guidelines' }],
}
const RESEARCH: PassScript = {
  recording: 'C02-review-shape',
  text: `\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``,
}
const spec = (research: PassScript[] | undefined): ScenarioSpec => ({
  ...(research !== undefined ? { research } : {}),
  plan: { recording: 'C06-plan-native-host' },
  implement: [
    {
      recording: 'C08a-session-id-implement',
      write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
    },
  ],
})

const RESEARCH_FIRST = {
  id: 'research-first',
  version: 1,
  label: 'Research first',
  description: 'Study the problem space before planning.',
  toggles: { research: true, clarify: false },
  taskHint: 'What should Dim Factory look into first?',
}

function writeRecipe(dir: string, recipe: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${String(recipe['id'])}.json`)
  writeFileSync(file, JSON.stringify(recipe, null, 2))
  return file
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
const ids = (r: PreflightReport, k: 'blocking' | 'warnings' | 'info'): string[] => r[k].map((c) => c.id)
const all = (r: PreflightReport): PreflightReport['info'] => [...r.blocking, ...r.warnings, ...r.info]

describe('a recipe as a config layer (core + fake Claude)', () => {
  it('turns Research on, records the recipe, and Re-run keeps it frozen', async () => {
    const w = await world.setup(spec([RESEARCH, RESEARCH]))
    const file = writeRecipe(join(w.home, 'recipes'), RESEARCH_FIRST)
    const { core } = await world.boot(w.home)
    const listed = value(await core.invoke('recipes.list', { folder: w.folder }))
    expect(listed.recipes.find((v) => v.recipe.id === 'research-first')).toMatchObject({
      layer: 'user',
      path: file,
    })
    // The composer's badges: the switch's value comes from the recipe.
    const view = value(await core.invoke('config.resolve', { folder: w.folder, recipe: 'research-first' }))
    expect(view.config.passes.plan.research).toBe(true)
    expect(view.provenance['/passes/plan/research']).toEqual({
      source: 'recipe',
      file,
      via: 'recipe:research-first',
    })
    const checks = value(await core.invoke('preflight.run', { folder: w.folder, recipe: 'research-first' }))
    expect(checks.info.find((c) => c.id === 'run.recipe')?.title).toBe('Recipe: Research first')
    expect(ids(checks, 'info')).toContain('run.research')

    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: { profile: 'claude-only', gates: { afterPlan: false, beforeFix: false } },
        recipe: 'research-first',
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    // The recipe's Research step runs: its card waits for the user.
    const reviewing = await c.waitFor((s) => openCard(s, 'research') !== undefined, 120_000)
    expect(reviewing.steps.research.status).toBe('waiting')
    expect(reviewing.recipe).toEqual({
      id: 'research-first',
      label: 'Research first',
      layer: 'user',
      sha256: sha256(readFileSync(file, 'utf8')),
    })
    const snap = value(await core.invoke('runs.get', { runId }))
    expect(snap.summary.recipe?.label).toBe('Research first')
    const resolved = JSON.parse(readFileSync(core.paths.run(runId).resolvedJson, 'utf8')) as {
      recipe?: Record<string, unknown>
      provenance?: Record<string, { source: string }>
    }
    expect(resolved.recipe).toMatchObject({
      id: 'research-first',
      layer: 'user',
      path: file,
      setsAuto: false,
    })
    expect(resolved.provenance?.['/passes/plan/research']?.source).toBe('recipe')
    value(await core.invoke('runs.stop', { runId }))
    await c.waitFor((s) => s.status === 'cancelled' || s.status === 'failed', 60_000)

    // The recipe changes: Re-run still takes the frozen config (Research on) and shows the recipe it ran with.
    writeRecipe(join(w.home, 'recipes'), {
      ...RESEARCH_FIRST,
      label: 'Renamed',
      toggles: { research: false },
    })
    const again = value(await core.invoke('runs.rerun', { runId, from: 'start' }))
    const c2 = core.controller(again.runId)
    if (c2 === undefined) throw new Error('no controller')
    expect(c2.state.recipe?.label).toBe('Research first')
    expect(value(await core.invoke('runs.get', { runId: again.runId })).summary.recipe?.label).toBe(
      'Research first',
    )
    const reresearch = await c2.waitFor((s) => openCard(s, 'research') !== undefined, 120_000)
    expect(reresearch.steps.research.status).toBe('waiting')
    value(await core.invoke('runs.stop', { runId: again.runId }))
    await c2.waitFor((s) => s.status === 'cancelled' || s.status === 'failed', 60_000)
  }, 240_000)

  it("a recipe's Research switch sits above the brief pack's default", async () => {
    const w = await world.setup(spec(undefined))
    writeRecipe(join(w.home, 'recipes'), {
      ...RESEARCH_FIRST,
      id: 'no-research',
      toggles: { research: false },
    })
    const { core } = await world.boot(w.home)
    const brief = { category: 'research-writing', fields: {} }
    const packOn = value(await core.invoke('preflight.run', { folder: w.folder, brief }))
    expect(ids(packOn, 'info')).toContain('run.research')
    const recipeOff = value(
      await core.invoke('preflight.run', { folder: w.folder, brief, recipe: 'no-research' }),
    )
    expect(all(recipeOff).map((c) => c.id)).not.toContain('run.research')
    // The run's own choice still wins over the recipe's.
    const runOn = value(
      await core.invoke('preflight.run', {
        folder: w.folder,
        brief,
        recipe: 'no-research',
        overrides: { passes: { plan: { research: true } } },
      }),
    )
    expect(ids(runOn, 'info')).toContain('run.research')
  }, 120_000)

  it('an unknown recipe id is VALIDATION with a did-you-mean (start, checks, estimate, resolve)', async () => {
    const w = await world.setup(spec(undefined))
    const { core } = await world.boot(w.home)
    const start = await core.invoke('runs.start', { folder: w.folder, task: 'x', recipe: 'bug-fx' })
    expect(start.ok === false && start.error.code).toBe('VALIDATION')
    expect(start.ok === false && start.error.message).toContain('(did you mean "bug-fix"?)')
    for (const r of [
      await core.invoke('preflight.run', { folder: w.folder, recipe: 'bug-fx' }),
      await core.invoke('estimates.get', { folder: w.folder, recipe: 'bug-fx' }),
      await core.invoke('config.resolve', { folder: w.folder, recipe: 'bug-fx' }),
    ]) {
      expect(r.ok === false && r.error.code).toBe('VALIDATION')
    }
  }, 60_000)
})

describe('trust: a project recipe that turns Auto on', () => {
  it('blocks at preflight until granted for this version of the file; its verify command stays untrusted', async () => {
    const w = await world.setup(spec(undefined))
    const recipesDir = join(w.folder, '.dimfactory', 'recipes')
    const ship = {
      id: 'ship-it',
      version: 1,
      label: 'Ship it',
      description: 'Everything on, no questions.',
      toggles: {},
      auto: true,
      verify: { enabled: true, commands: [{ name: 'unit', run: ['node', '--version'] }] },
    }
    const file = writeRecipe(recipesDir, ship)
    const { core } = await world.boot(w.home)
    const before = value(await core.invoke('preflight.run', { folder: w.folder, recipe: 'ship-it' }))
    const check = before.blocking.find((b) => b.id === 'folder.trust.recipeAuto')
    expect(check).toMatchObject({
      category: 'trust_required',
      title: 'This project recipe turns on Auto mode',
    })
    const shown = sha256(readFileSync(file, 'utf8'))
    expect(check?.recovery[0]).toMatchObject({
      kind: 'grant',
      grant: 'recipeAuto',
      recipeId: 'ship-it',
      recipeSha: shown,
    })
    // A verify command the recipe adds is data: it goes through Verify's per-command trust like any other.
    const unit = all(before).find((c) => c.id === 'run.verify.unit')
    expect(unit?.status).not.toBe('pass')
    expect(unit?.category === 'verify_untrusted' || unit?.category === 'deps_missing').toBe(true)
    expect(value(await core.invoke('trust.get', { folder: w.folder })).grants.commands).toBeUndefined()

    const blocked = await core.invoke('runs.start', { folder: w.folder, task: 'x', recipe: 'ship-it' })
    expect(blocked.ok === false && blocked.error.code).toBe('PREFLIGHT_BLOCKED')
    // The run deciding Auto itself needs no grant.
    const off = value(
      await core.invoke('preflight.run', { folder: w.folder, recipe: 'ship-it', overrides: { auto: false } }),
    )
    expect(all(off).map((c) => c.id)).not.toContain('folder.trust.recipeAuto')

    // The grant covers this version of the file.
    value(
      await core.invoke('trust.set', {
        folder: w.folder,
        grant: { kind: 'recipeAuto', recipeId: 'ship-it', recipeSha: shown },
        trusted: true,
      }),
    )
    const after = value(await core.invoke('preflight.run', { folder: w.folder, recipe: 'ship-it' }))
    expect(ids(after, 'blocking')).not.toContain('folder.trust.recipeAuto')
    expect(ids(after, 'info')).toContain('folder.trust.recipeAuto')

    // An edit voids it, and the version that was shown can no longer be allowed.
    writeRecipe(recipesDir, { ...ship, description: 'Everything on, really.' })
    const edited = value(await core.invoke('preflight.run', { folder: w.folder, recipe: 'ship-it' }))
    expect(edited.blocking.find((b) => b.id === 'folder.trust.recipeAuto')?.detail).toContain(
      'The file changed since you allowed it',
    )
    const stale = await core.invoke('trust.set', {
      folder: w.folder,
      grant: { kind: 'recipeAuto', recipeId: 'ship-it', recipeSha: shown },
      trusted: true,
    })
    expect(stale.ok === false && stale.error.code).toBe('CONFLICT')

    // The same recipe as the user's own file needs no grant.
    writeRecipe(join(w.home, 'recipes'), { ...ship, id: 'my-ship' })
    const mine = value(await core.invoke('preflight.run', { folder: w.folder, recipe: 'my-ship' }))
    expect(all(mine).map((c) => c.id)).not.toContain('folder.trust.recipeAuto')
  }, 120_000)
})

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function cli(args: string[]): Promise<CliResult> {
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
      reject(new Error(`dimf timed out\n${stdout}\n${stderr}`))
    }, 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

async function cliSetup(s: ScenarioSpec): Promise<{ home: string; folder: string }> {
  const sc = await makeScenario(s)
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  return { home, folder }
}

describe('dimf run --recipe, dimf recipes, dimf config trust recipeAuto', () => {
  it('runs the recipe: its Research step stops at the card without a terminal (exit 5)', async () => {
    const { home, folder } = await cliSetup(spec([RESEARCH]))
    writeRecipe(join(home, 'recipes'), RESEARCH_FIRST)
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--recipe',
      'research-first',
      '--gates',
      'approve',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(5)
    expect(r.stdout).toContain('Recipe: Research first')
    expect(r.stdout).toContain('? Review the research')
    expect(r.stdout).not.toContain('—')
  }, 150_000)

  it('an unknown recipe is a usage error with a did-you-mean; a malformed id never reaches core', async () => {
    const { home, folder } = await cliSetup(spec(undefined))
    const unknown = await cli(['run', folder, 'x', '--recipe', 'bug-fx', '--home', home])
    expect(unknown.code, unknown.stdout + unknown.stderr).toBe(2)
    expect(unknown.stderr).toContain('Unknown recipe "bug-fx" (did you mean "bug-fix"?)')
    const bad = await cli(['run', folder, 'x', '--recipe', 'Bug_Fix', '--home', home])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--recipe: "Bug_Fix" is not a recipe id')
  }, 120_000)

  it('dimf recipes lists the layers; dimf config trust grants a project recipe its Auto mode', async () => {
    const { home, folder } = await cliSetup(spec(undefined))
    writeRecipe(join(home, 'recipes'), { ...RESEARCH_FIRST, id: 'bug-fix', label: 'My bug fix' })
    writeRecipe(join(folder, '.dimfactory', 'recipes'), {
      id: 'ship-it',
      version: 1,
      label: 'Ship it',
      description: 'Everything on.',
      toggles: { fixRounds: 3 },
      auto: true,
    })
    writeFileSync(join(folder, '.dimfactory', 'recipes', 'broken.json'), '{')
    const list = await cli(['recipes', '--folder', folder, '--home', home])
    expect(list.code, list.stdout + list.stderr).toBe(0)
    expect(list.stdout).toContain('new-web-app')
    expect(list.stdout).toContain('My bug fix (User)')
    expect(list.stdout).toContain('Ship it (Project)')
    expect(list.stdout).toContain('Turns on Fix until green (3 rounds), Auto mode.')
    expect(list.stdout).toContain('broken.json: Not valid JSON')
    expect(list.stdout).not.toContain('—')

    const granted = await cli([
      'config',
      'trust',
      folder,
      'recipeAuto',
      '--recipe',
      'ship-it',
      '--home',
      home,
    ])
    expect(granted.code, granted.stdout + granted.stderr).toBe(0)
    expect(granted.stdout).toContain(
      'the project recipe may turn on Auto mode (until its file changes) (ship-it)',
    )
    const trust = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')) as {
      folders: Record<string, { grants: { recipeAuto?: Record<string, { sha: string }> } }>
    }
    const grant = Object.values(trust.folders)[0]?.grants.recipeAuto?.['ship-it']
    expect(grant?.sha).toBe(
      sha256(readFileSync(join(folder, '.dimfactory', 'recipes', 'ship-it.json'), 'utf8')),
    )
    const none = await cli(['config', 'trust', folder, 'recipeAuto', '--home', home])
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('recipeAuto needs --recipe <id>')
  }, 150_000)
})
