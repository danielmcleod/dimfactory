// Vitest global setup: build the fake-CLI launchers once per test run, and contain every
// temp directory the tests (and the fake CLIs they spawn) create under one per-run root that
// is removed on teardown. Workers are started after this runs, so they inherit the env.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFakeCli } from '../../scripts/build-fake-cli.mjs'

export default async function setup(): Promise<() => void> {
  const result = await buildFakeCli()
  process.env['DIM_FACTORY_FAKE_CLI_DIR'] = result.dir

  const root = mkdtempSync(join(tmpdir(), 'dim-factory-vitest-'))
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root
  // A test core that finds the developer's real Codex (the standalone install is a well-known location) talks to
  // an empty CODEX_HOME, never ~/.codex: logged out, so no model list, no thread and no token.
  const codexHome = join(root, 'codex-home')
  mkdirSync(codexHome, { recursive: true })
  process.env['CODEX_HOME'] = codexHome
  // Likewise an empty GEMINI_CLI_HOME (Gemini's home-folder override), so a test core that finds a real Gemini CLI
  // reads no ~/.gemini: not signed in, so its probe's session/new answers authRequired and nothing is prompted.
  const geminiHome = join(root, 'gemini-home')
  mkdirSync(geminiHome, { recursive: true })
  process.env['GEMINI_CLI_HOME'] = geminiHome
  // Likewise an empty GROK_HOME (Grok's home-folder override), so a test core that finds a real Grok CLI reads no
  // ~/.grok: no cached sign-in, no sessions, no config of the developer's own.
  const grokHome = join(root, 'grok-home')
  mkdirSync(grokHome, { recursive: true })
  process.env['GROK_HOME'] = grokHome
  // The fake CLIs replay recorded answers whose words do not match the files a scenario writes, so the grounding checks
  // (what a pass said against what it did) are off in test cores unless a test turns them on.
  process.env['DIM_FACTORY_GROUNDING'] = 'off'

  return () => {
    if (process.env['DIM_FACTORY_KEEP_TMP'] === '1') return
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
