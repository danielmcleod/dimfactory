// The verify:0 baseline through the real round runner (the isolated run uses the SOURCE folder's command grants).
// The run's copy has another folder key and no grants of its own, so the round is given the
// source folder's: trusted commands run there (pass, fail, env), an untrusted one does not run and stays out of the
// map. baseline.json is written; a verify:1 round in the same copy then reads its failure as pre-existing.
import { readFileSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grantTrust, trustGrantsFor } from '../../../../src/core/config/trust.ts'
import { resolveBuiltinConfig } from '../../../../src/core/config/builtins.ts'
import { homePaths } from '../../../../src/core/home.ts'
import { baselineCommands, readBaseline, runBaseline } from '../../../../src/core/prepare/baseline.ts'
import { readBody } from '../../../../src/core/verify/discover.ts'
import {
  renderVerifySection,
  verifyFindings,
  verifyHasMustFailures,
} from '../../../../src/core/verify/render.ts'
import { runVerifyRound } from '../../../../src/core/verify/run.ts'
import { removeDir, tempDir, writeFiles } from '../../../unit/verify/helpers.ts'

const RUN = '20261009T120000Z-baseline'
const PATH = [dirname(process.execPath), process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter)

let source = ''
let wt = ''
beforeEach(() => {
  source = tempDir('dim-factory-base-src-')
  wt = tempDir('dim-factory-base-wt-')
})
afterEach(() => {
  removeDir(source)
  removeDir(wt)
})

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const SCRIPTS = {
  'ok.cjs': "console.log('fine')",
  'broken.cjs':
    "console.error('AssertionError: expected 1 to be 2'); console.log('Tests: 1 failed'); process.exit(1)",
  'mark.cjs': "require('node:fs').writeFileSync('ran.txt', 'x')",
}

describe('runBaseline (real round)', () => {
  it('runs in the run’s copy with the source folder’s grants and writes the map', async () => {
    writeFiles(source, SCRIPTS)
    writeFiles(wt, SCRIPTS)
    const config = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: {
        isolation: { mode: 'worktree' },
        verify: {
          enabled: true,
          baseline: true,
          commands: [
            { name: 'ok', run: ['node', 'ok.cjs'] },
            { name: 'unit', run: ['node', 'broken.cjs'] },
            { name: 'missing', run: ['no-such-tool-xyz', 'run'] },
            { name: 'untrusted', run: ['node', 'mark.cjs'] },
          ],
        },
      },
    })
    // The user trusted three of them in their folder (trust.json keyed by the SOURCE folder).
    const commands = await baselineCommands(config, source, source)
    for (const c of commands.slice(0, 3)) {
      const body = await readBody(source, c)
      await grantTrust(
        source,
        {
          kind: 'command',
          command: {
            kind: 'verify',
            argv: [...(c.argv ?? [])],
            cwdRel: c.cwdRel,
            ...(body !== null ? { body } : {}),
          },
        },
        { home: home(), folderScope: { scopeRoot: source } },
      )
    }
    const sourceGrants = () => trustGrantsFor(source, { home: home(), folderScope: { scopeRoot: source } })
    // The run's copy has a folder key of its own, with nothing granted.
    expect(await trustGrantsFor(wt, { home: home(), folderScope: { scopeRoot: wt } })).toEqual({})

    const paths = homePaths(home())
    const r = await runBaseline(
      { paths, pathEnv: PATH, grants: sourceGrants },
      { runId: RUN, config, worktreeFolder: wt, worktreeRoot: wt },
    )
    expect(r.round.results.map((x) => [x.name, x.status])).toEqual([
      ['ok', 'pass'],
      ['unit', 'fail'],
      ['missing', 'env'],
      ['untrusted', 'skipped-untrusted'],
    ])
    expect(r.baseline).toEqual({ ok: 'pass', unit: 'fail', missing: 'env' })
    expect(JSON.parse(readFileSync(r.path, 'utf8'))).toEqual(r.baseline)
    expect(r.round.logDir).toBe(paths.run(RUN).verify('verify:0'))
    expect(await readBaseline(paths, RUN)).toEqual(r.baseline)

    // verify:1 later in the same copy: the old failure is pre-existing, a [should] that does not block.
    const v1 = await runVerifyRound(
      { paths, pathEnv: PATH, grants: sourceGrants },
      { runId: RUN, round: 'verify:1', folder: wt, commands: commands.slice(0, 2), failFast: false },
    )
    const baseline = await readBaseline(paths, RUN)
    if (baseline === undefined) throw new Error('baseline.json was not written')
    expect(renderVerifySection(v1.results, baseline)).toContain(
      '- FAIL (already failing before this run) `node broken.cjs`',
    )
    expect(verifyFindings(v1.results, { baseline }).map((f) => [f.severity, f.flags])).toEqual([
      ['should', ['preexisting']],
    ])
    expect(verifyHasMustFailures(v1.results, baseline)).toBe(false)
  })
})
