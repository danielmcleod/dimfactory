// Extensions end to end: the fake Claude's own settings (the test's private CLAUDE_CONFIG_DIR, never ~/.claude) define
// two MCP servers. In Settings > Extensions the user ticks one for Claude and sets Review to Allowed list; then a run.
// The fake Review sees only that server (its `--mcp-config` file holds it alone, with its env), the file is gone once
// the pass is, Implement keeps today's launch, and no server name, command or env value reaches the raw logs, the
// app's logs or a diagnostics bundle.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { passArgvs } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { CLEAN_FLOW } from './scenarios.ts'

const SECRET = 'e2e-stand-in-secret-91c'
const ALLOWED = 'zeta_e2e_srv'
const OTHER = 'omega_e2e_srv'
const MARKERS = [SECRET, ALLOWED, OTHER, 'zeta-e2e-cmd.js', 'omega-e2e-cmd.js']

/** Every file under `dir` (recursively), as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return ''
  let out = ''
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    out += statSync(p).isDirectory() ? allText(p) : `${readFileSync(p, 'utf8')}\n`
  }
  return out
}

test('Review on the Allowed list sees only the allowed MCP server', async ({ e2e }) => {
  test.setTimeout(240_000)
  // The fake Claude's settings: two servers in its global file (the harness points CLAUDE_CONFIG_DIR here).
  const claudeConfig = join(e2e.root, 'claude-config')
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(
    join(claudeConfig, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        [ALLOWED]: { command: 'node', args: ['zeta-e2e-cmd.js'], env: { ZETA_TOKEN: SECRET } },
        [OTHER]: { command: 'node', args: ['omega-e2e-cmd.js'] },
      },
    }),
  )
  const page = await e2e.start({
    scenario: {
      ...CLEAN_FLOW,
      review: [
        {
          recording: 'C02-review-shape',
          text: 'NO FINDINGS',
          prepend: [
            { op: 'expectArgs', includes: ['--strict-mcp-config', '--mcp-config'] },
            {
              op: 'expectFile',
              argvPath: '--mcp-config',
              json: {
                mcpServers: {
                  [ALLOWED]: { command: 'node', args: ['zeta-e2e-cmd.js'], env: { ZETA_TOKEN: SECRET } },
                  [OTHER]: { $absent: true },
                },
              },
            },
          ],
        },
      ],
    },
    config: { gates: { afterPlan: false } },
  })

  // ---- Settings > Extensions: tick the server, Review to Allowed list ----
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-extensions').click()
  const row = page.getByTestId(`extensions-claude-mcp-${ALLOWED}`)
  await expect(row).toBeVisible()
  await expect(page.getByTestId(`extensions-claude-mcp-${OTHER}`)).toBeVisible()
  await page.getByTestId(`extensions-claude-mcp-${ALLOWED}-allow`).click()
  await expect(page.getByTestId(`extensions-claude-mcp-${ALLOWED}-allow`)).toHaveAttribute(
    'data-state',
    'checked',
  )
  await expect(page.getByTestId(`extensions-claude-mcp-${ALLOWED}-used`)).toHaveText(
    'Used by Implement and Fix',
  )
  await page.getByTestId('pass-extensions-settings-review').click()
  await page.getByTestId('pass-extensions-settings-review-allowed').click()
  await expect(page.getByTestId('pass-extensions-settings-review')).toHaveText('Allowed list')
  await expect(page.getByTestId(`extensions-claude-mcp-${ALLOWED}-used`)).toHaveText(
    'Used by Implement, Review and Fix',
  )
  await expect(page.getByTestId(`extensions-claude-mcp-${OTHER}-used`)).toHaveText(
    'Used by Implement and Fix',
  )
  // Saved to the user's settings (no project chosen). The screen changes first and the file just after, so wait for it.
  type Saved = {
    passes?: { review?: { extensions?: string } }
    extensions?: { allowed?: { claude?: { mcp?: string[] } } }
  }
  const saved = (): Saved => {
    try {
      return JSON.parse(readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')) as Saved
    } catch {
      return {}
    }
  }
  await expect.poll(() => saved().passes?.review?.extensions).toBe('allowed')
  expect(saved().extensions?.allowed?.claude?.mcp).toEqual([ALLOWED])

  // ---- the run ----
  await page.getByTestId('nav-dashboard').click()
  const run = await e2e.runFromDashboard('add a --version flag')
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // The fake Review checked its argv and its config file (a mismatch would have failed the pass).
  const log = e2e.fakeLog()
  expect(log.filter((e) => e.kind === 'error')).toEqual([])
  expect(log.some((e) => e.kind === 'expectFile' && e['ok'] === true)).toBe(true)
  const argvs = passArgvs(log)
  const review = argvs.find((a) => a.includes('dontAsk') && a.includes('sonnet'))
  expect(review).toBeDefined()
  const file = review?.[review.indexOf('--mcp-config') + 1] ?? ''
  expect(file).not.toBe('')
  // The file lived in the run's private scratch folder and is gone.
  expect(file.startsWith(join(e2e.home, 'runs', run.runId))).toBe(true)
  expect(existsSync(file)).toBe(false)
  // Implement (Pass through) launched as today: no strict MCP, no config file.
  const implement = argvs.find((a) => a.includes('acceptEdits'))
  expect(implement).not.toContain('--strict-mcp-config')
  expect(implement).not.toContain('--mcp-config')

  // Nothing Dim Factory wrote down names a server, a command or the secret.
  const written = `${allText(join(e2e.home, 'runs', run.runId, 'raw'))}${allText(join(e2e.home, 'logs'))}`
  expect(MARKERS.filter((m) => written.includes(m))).toEqual([])
  const procs = join(e2e.home, 'runs', run.runId, 'procs.json')
  if (existsSync(procs)) expect(MARKERS.filter((m) => readFileSync(procs, 'utf8').includes(m))).toEqual([])
  const bundle = await e2e.call('diagnostics.build', { runId: run.runId, includeRaw: true })
  expect(MARKERS.filter((m) => bundle.text.includes(m))).toEqual([])

  expect(e2e.pageErrors).toEqual([])
})
