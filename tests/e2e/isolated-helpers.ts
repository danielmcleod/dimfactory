// Helpers shared by the isolated-run E2E specs (Prepare, Deps, Finalize, Apply,
// Cleanup; the composer's "In place | Isolated run", the PrepareCard, the finalize / finalizeConflicts / interruptedApply
// cards, the Diff tab's "Apply to folder…" panel, the Dashboard chip "Isolated: not applied";
// isolated.spec.ts). An isolated run starts from the last commit, so the node scripts the run uses (the install stand-in
// and the verify command) are committed to the temp sandbox repository first. Everything lives under the test's temp
// root: the sandbox, DIM_FACTORY_HOME (its worktrees, trust.json, the E2E apply hold file).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { Scenario } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { CHECK_SCRIPT } from './verify-helpers.ts'
import { gitOut, sha256 } from './git-helpers.ts'

export { CHECK_SCRIPT }

/**
 * The package manager's install, as a node script (`node install.mjs [release-file]`): prints what it does, writes
 * `.deps/installed.txt` in its folder (the run's isolated copy). Given a release file, it keeps printing a line every
 * 100 ms until that file exists (an install still running, for the PrepareCard's live output), then finishes.
 */
export const INSTALL_SCRIPT = [
  "import { existsSync, mkdirSync, writeFileSync } from 'node:fs'",
  'const release = process.argv[2] ?? ""',
  "console.log('resolving 3 packages')",
  'let n = 0',
  'while (release !== "" && !existsSync(release)) {',
  "  console.log('fetching package ' + (++n % 3 + 1) + ' of 3 (' + n + ')')",
  '  await new Promise((r) => setTimeout(r, 100))',
  '}',
  "mkdirSync('.deps', { recursive: true })",
  "writeFileSync('.deps/installed.txt', 'ok')",
  "console.log('installed 3 packages')",
].join('\n')

export const INSTALL_ARGV = ['node', 'install.mjs'] as const

/** The install's argv that keeps running until `releaseInstall`. */
export function slowInstallArgv(e2e: E2EHarness): string[] {
  return [...INSTALL_ARGV, join(e2e.root, 'install-release.txt')]
}

export function releaseInstall(e2e: E2EHarness): void {
  writeFileSync(join(e2e.root, 'install-release.txt'), 'done\n')
}

/** Write files into the sandbox and commit them (an isolated run starts from HEAD, so the worktree has them). */
export function commitSandbox(e2e: E2EHarness, files: Record<string, string | Buffer>): void {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(e2e.sandbox, rel)), { recursive: true })
    writeFileSync(join(e2e.sandbox, rel), data)
  }
  gitOut(e2e.sandbox, 'add', '-A')
  gitOut(e2e.sandbox, 'commit', '-q', '-m', 'isolated run fixture')
}

/** User config for an isolated run: the install command (install `ask`), Verify with `commands`, and `extra`. */
export function isolatedConfig(
  o: {
    mode?: 'worktree'
    installCommand?: readonly string[]
    install?: 'ask' | 'auto' | 'never'
    autoApply?: boolean
    commands?: { name: string; run: string[] }[]
    baseline?: boolean
  } = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const commands = o.commands ?? []
  return {
    isolation: {
      ...(o.mode !== undefined ? { mode: o.mode } : {}),
      worktree: {
        installCommand: [...(o.installCommand ?? INSTALL_ARGV)],
        install: o.install ?? 'ask',
        autoApply: o.autoApply ?? false,
      },
    },
    ...(commands.length > 0
      ? { verify: { enabled: true, commands, ...(o.baseline === true ? { baseline: true } : {}) } }
      : {}),
    ...extra,
  }
}

/**
 * The Dashboard's composer with Isolated run chosen (its pass rows opened): the sandbox, the task, Isolated run, then
 * Run. Resolves with the new run's id once its Run view is open.
 */
export async function runIsolatedFromDashboard(
  e2e: E2EHarness,
  task: string,
  o: { uncommitted?: number } = {},
): Promise<string> {
  const page = e2e.p
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill(task)
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  await openPassRows(page)
  const isolated = page.getByTestId('isolation-worktree')
  await expect(isolated).toBeEnabled({ timeout: 30_000 })
  await isolated.click()
  await expect(isolated).toHaveAttribute('aria-pressed', 'true')
  const warning = page.getByTestId('isolation-warning')
  await expect(warning).toBeVisible()
  // Core's live check counts what the run leaves out (it starts from HEAD); the line changes its words in place.
  if (o.uncommitted !== undefined) {
    await expect(warning).toHaveAttribute('data-count', String(o.uncommitted), { timeout: 30_000 })
    if (o.uncommitted > 0)
      await expect(warning).toHaveText(
        `${o.uncommitted} uncommitted ${o.uncommitted === 1 ? 'change' : 'changes'} not included: isolated runs start from your last commit.`,
      )
  }
  await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('run-view')).toBeVisible()
  return run.runId
}

/** The composer's pass rows (where In place | Isolated run sits), opened. */
export async function openPassRows(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(Passes|Hide passes)$/ })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(page.getByTestId('isolation-worktree')).toBeVisible()
}

/** A card by kind, once shown. */
export async function card(page: Page, kind: string, timeout = 120_000): Promise<Locator> {
  const c = page.getByTestId(`card-${kind}`)
  await expect(c).toBeVisible({ timeout })
  return c
}

/** Press a card's choice and wait for the card to go (or to be replaced). */
export async function choose(page: Page, kind: string, choiceId: string, timeout = 120_000): Promise<void> {
  const c = await card(page, kind, timeout)
  const id = await c.getAttribute('data-card-id')
  await c.getByTestId(`card-choice-${choiceId}`).click()
  await expect(page.locator(`[data-card-id="${id ?? ''}"]`)).toHaveCount(0, { timeout: 60_000 })
}

/** The run's worktree: `<home>/worktrees/<runId>`. */
export function worktreeOf(e2e: E2EHarness, runId: string): string {
  return join(e2e.home, 'worktrees', runId)
}

/** sha256 of each file (or 'absent') under `dir`, keyed by its path. */
export function hashes(dir: string, rels: readonly string[]): Record<string, string> {
  return Object.fromEntries(rels.map((r) => [r, existsSync(join(dir, r)) ? sha256(join(dir, r)) : 'absent']))
}

export const text = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')

/** The file's last modification time in ms (an apply that wrote it again would move it). */
export const mtimeOf = (dir: string, rel: string): number => statSync(join(dir, rel)).mtimeMs

/** The E2E hook's hold file (DIM_FACTORY_E2E=1 only): while it exists, an apply waits after each file it wrote. */
export function applyHold(e2e: E2EHarness): string {
  return join(e2e.home, 'e2e', 'apply-hold')
}

export function holdApply(e2e: E2EHarness): void {
  mkdirSync(join(e2e.home, 'e2e'), { recursive: true })
  writeFileSync(applyHold(e2e), 'hold\n')
}

export function releaseApply(e2e: E2EHarness): void {
  rmSync(applyHold(e2e), { force: true })
}

/** The run's branches in the sandbox repository (`refs/heads/dim/…`). */
export function dimFactoryBranches(e2e: E2EHarness): string[] {
  const out = gitOut(e2e.sandbox, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/dim/')
  return out === '' ? [] : out.split('\n')
}

type Op = Record<string, unknown> & { op: string }

/**
 * Rewrite `<name>.script.jsonl` so the pass writes `files` (in this order) just before its recorded result, as a vendor
 * that edits several files does (the scenario's `write` covers one).
 */
export function writeBeforeResult(
  sc: Scenario,
  name: string,
  files: readonly { path: string; content: string }[],
): void {
  const file = join(sc.dir, `${name}.script.jsonl`)
  const ops = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Op)
  const at = ops.findIndex(
    (o) => o.op === 'stdout' && typeof o['line'] === 'string' && o['line'].includes('"type":"result"'),
  )
  if (at === -1) throw new Error(`${name}: no result line`)
  ops.splice(at, 0, ...files.map((f) => ({ op: 'writeFile', path: f.path, content: f.content })))
  writeFileSync(file, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
}
