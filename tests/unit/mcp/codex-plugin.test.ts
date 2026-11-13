// The Codex plugin: the local marketplace's files (the bridge command, the skill), the plan that lists them and the
// commands without writing anything, and the install run against a fake Codex (a node script that records its
// arguments), which stops at the first failing step and says when Codex is missing.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execCapture } from '../../../src/core/proc/spawn.ts'
import {
  codexMarketplaceDir,
  codexPluginFiles,
  codexPluginPlan,
  installCodexPlugin,
} from '../../../src/core/mcp/codex-plugin.ts'
import type { CodexRunner } from '../../../src/core/mcp/codex-plugin.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dim-factory-codex-plugin-'))
  dirs.push(d)
  return d
}

const BRIDGE = { command: 'C:\\Program Files\\Dim Factory\\Dim Factory.exe', args: ['--mcp'] }

/** A fake `codex`: appends its argv to a log; exits 1 when its first argument is in FAIL_ON. */
function fakeCodex(
  root: string,
  o: { failOn?: string; say?: string } = {},
): { run: CodexRunner; log: string } {
  const log = join(root, 'codex-calls.jsonl')
  const script = join(root, 'fake-codex.mjs')
  writeFileSync(
    script,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      `if (${JSON.stringify(o.say ?? '')}) process.stdout.write(${JSON.stringify(o.say ?? '')})`,
      `if (process.argv[3] === ${JSON.stringify(o.failOn ?? '\u0000')}) { process.stderr.write('boom'); process.exit(1) }`,
    ].join('\n'),
  )
  return {
    log,
    run: async (args) => {
      const r = await execCapture(process.execPath, [script, ...args], { timeoutMs: 30_000 })
      return { code: r.code, output: `${r.stdout}${r.stderr}`, timedOut: r.timedOut }
    },
  }
}

const calls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as string[])
    : []

describe('the Codex plugin', () => {
  it('lists the files and commands without writing anything', () => {
    const home = tmp()
    const plan = codexPluginPlan(home, BRIDGE)
    expect(plan.dir).toBe(codexMarketplaceDir(home))
    expect(plan.installed).toBe(false)
    expect(plan.steps).toEqual([])
    expect(plan.files.map((f) => f.slice(plan.dir.length + 1).replace(/\\/g, '/'))).toEqual([
      '.agents/plugins/marketplace.json',
      'plugins/dim-factory/.codex-plugin/plugin.json',
      'plugins/dim-factory/.mcp.json',
      'plugins/dim-factory/skills/dim-factory/SKILL.md',
    ])
    expect(plan.commands).toEqual([
      `codex plugin marketplace add ${/\s/.test(plan.dir) ? `"${plan.dir}"` : plan.dir}`,
      'codex plugin add dim-factory@dim-factory',
    ])
    expect(existsSync(plan.dir)).toBe(false)
  })

  it('runs the bridge command and carries a skill about the tools (no token anywhere)', () => {
    const files = codexPluginFiles(tmp(), BRIDGE)
    const mcp = files.find((f) => f.path.endsWith('.mcp.json'))
    expect(JSON.parse(mcp?.content ?? '{}')).toEqual({
      mcpServers: { 'dim-factory': { command: BRIDGE.command, args: ['--mcp'] } },
    })
    const skill = files.find((f) => f.path.endsWith('SKILL.md'))?.content ?? ''
    expect(skill).toMatch(/^---\nname: dim-factory\n/)
    for (const tool of ['list_runs', 'get_run', 'get_diff', 'request_run', 'get_request_status']) {
      expect(skill).toContain(tool)
    }
    expect(skill).not.toContain('\u2014')
    const market = JSON.parse(files[0]?.content ?? '{}') as { name: string; plugins: { name: string }[] }
    expect(market.name).toBe('dim-factory')
    expect(market.plugins.map((p) => p.name)).toEqual(['dim-factory'])
    expect(files.map((f) => f.content).join('')).not.toMatch(/token/i)
  })

  it('writes the marketplace and runs both commands with a fake Codex', async () => {
    const home = tmp()
    const fake = fakeCodex(home)
    const r = await installCodexPlugin(home, BRIDGE, fake.run)
    expect(r.installed).toBe(true)
    expect(r.steps.map((s) => s.ok)).toEqual([true, true])
    expect(calls(fake.log)).toEqual([
      ['plugin', 'marketplace', 'add', codexMarketplaceDir(home)],
      ['plugin', 'add', 'dim-factory@dim-factory'],
    ])
    for (const f of r.files) expect(existsSync(f)).toBe(true)
  })

  it('takes "already" as done, stops at a failing step, and says when Codex is missing', async () => {
    const home = tmp()
    const again = await installCodexPlugin(
      home,
      BRIDGE,
      fakeCodex(home, { failOn: 'marketplace', say: 'already added' }).run,
    )
    expect(again.steps.map((s) => s.ok)).toEqual([true, true])

    const home2 = tmp()
    const failing = fakeCodex(home2, { failOn: 'marketplace' })
    const bad = await installCodexPlugin(home2, BRIDGE, failing.run)
    expect(bad.installed).toBe(false)
    expect(bad.steps).toHaveLength(1)
    expect(bad.steps[0]).toMatchObject({ ok: false, output: 'boom' })
    expect(calls(failing.log)).toHaveLength(1)

    const missing = await installCodexPlugin(tmp(), BRIDGE, () => Promise.resolve(null))
    expect(missing.installed).toBe(false)
    expect(missing.steps[0]?.output).toContain('Codex was not found')
  })
})
