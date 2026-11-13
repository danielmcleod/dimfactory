// The Claude Code plugin: the local marketplace's files (the Claude Code layout, the bridge command, the shared skill),
// the plan that lists them and the commands without writing anything, and the install run against a fake Claude Code
// (a node script that records its arguments; the real CLI never runs), which stops at the first failing step and says
// when Claude Code is missing.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execCapture } from '../../../src/core/proc/spawn.ts'
import {
  claudeMarketplaceDir,
  claudePluginFiles,
  claudePluginPlan,
  installClaudePlugin,
} from '../../../src/core/mcp/claude-plugin.ts'
import type { ClaudeRunner } from '../../../src/core/mcp/claude-plugin.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dim-factory-claude-plugin-'))
  dirs.push(d)
  return d
}

const BRIDGE = { command: 'C:\\Program Files\\Dim Factory\\Dim Factory.exe', args: ['--mcp'] }

/** A fake `claude`: appends its argv to a log; exits 1 when its first argument is in FAIL_ON. */
function fakeClaude(
  root: string,
  o: { failOn?: string; say?: string } = {},
): { run: ClaudeRunner; log: string } {
  const log = join(root, 'claude-calls.jsonl')
  const script = join(root, 'fake-claude.mjs')
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

describe('the Claude Code plugin', () => {
  it('lists the files and commands without writing anything', () => {
    const home = tmp()
    const plan = claudePluginPlan(home, BRIDGE)
    expect(plan.dir).toBe(claudeMarketplaceDir(home))
    expect(plan.installed).toBe(false)
    expect(plan.steps).toEqual([])
    expect(plan.files.map((f) => f.slice(plan.dir.length + 1).replace(/\\/g, '/'))).toEqual([
      '.claude-plugin/marketplace.json',
      'plugins/dim-factory/.claude-plugin/plugin.json',
      'plugins/dim-factory/.mcp.json',
      'plugins/dim-factory/skills/dim-factory/SKILL.md',
    ])
    expect(plan.commands).toEqual([
      `claude plugin marketplace add ${/\s/.test(plan.dir) ? `"${plan.dir}"` : plan.dir}`,
      'claude plugin install dim-factory@dim-factory',
    ])
    expect(existsSync(plan.dir)).toBe(false)
  })

  it('runs the bridge command and carries a skill about the tools (no token anywhere)', () => {
    const files = claudePluginFiles(tmp(), BRIDGE)
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
    // The marketplace names an owner and points the plugin at its folder by a relative path.
    const market = JSON.parse(files[0]?.content ?? '{}') as {
      name: string
      owner: { name: string }
      plugins: { name: string; source: string }[]
    }
    expect(market.name).toBe('dim-factory')
    expect(market.owner.name).toBe('Dim Factory')
    expect(market.plugins).toMatchObject([{ name: 'dim-factory', source: './plugins/dim-factory' }])
    const manifest = JSON.parse(files[1]?.content ?? '{}') as { name: string; version: string }
    expect(manifest).toMatchObject({ name: 'dim-factory', version: '0.1.0' })
    expect(files.map((f) => f.content).join('')).not.toMatch(/token/i)
  })

  it('writes the marketplace and runs both commands with a fake Claude Code', async () => {
    const home = tmp()
    const fake = fakeClaude(home)
    const r = await installClaudePlugin(home, BRIDGE, fake.run)
    expect(r.installed).toBe(true)
    expect(r.steps.map((s) => s.ok)).toEqual([true, true])
    expect(calls(fake.log)).toEqual([
      ['plugin', 'marketplace', 'add', claudeMarketplaceDir(home)],
      ['plugin', 'install', 'dim-factory@dim-factory'],
    ])
    for (const f of r.files) expect(existsSync(f)).toBe(true)
  })

  it('takes "already" as done, stops at a failing step, and says when Claude Code is missing', async () => {
    const home = tmp()
    const again = await installClaudePlugin(
      home,
      BRIDGE,
      fakeClaude(home, { failOn: 'marketplace', say: 'already added' }).run,
    )
    expect(again.steps.map((s) => s.ok)).toEqual([true, true])

    const home2 = tmp()
    const failing = fakeClaude(home2, { failOn: 'marketplace' })
    const bad = await installClaudePlugin(home2, BRIDGE, failing.run)
    expect(bad.installed).toBe(false)
    expect(bad.steps).toHaveLength(1)
    expect(bad.steps[0]).toMatchObject({ ok: false, output: 'boom' })
    expect(calls(failing.log)).toHaveLength(1)

    const missing = await installClaudePlugin(tmp(), BRIDGE, () => Promise.resolve(null))
    expect(missing.installed).toBe(false)
    expect(missing.steps[0]?.output).toContain('Claude Code was not found')
  })
})
