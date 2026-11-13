// The Muse probe's checks as pure functions (the Muse probe checks) and its CLI spec
// (resolve-cli: the version must identify the product).
import { describe, expect, it } from 'vitest'
import { MUSE_DEFAULT_MODEL, MUSE_REQUIRED_EXEC_FLAGS } from '@core/adapters/muse/capabilities.ts'
import { museCliSpec, museWellKnown, parseMuseVersion } from '@core/adapters/muse/cli-spec.ts'
import {
  museAccount,
  museAuthCheck,
  musePlanCheck,
  museProtocolCheck,
  museVersionCheck,
} from '@core/adapters/muse/probe.ts'
import { MUSE_PIN, schemaHash } from '@core/adapters/muse/protocol.ts'

const HELP = {
  text: `Options:\n${MUSE_REQUIRED_EXEC_FLAGS.map((f) => `  ${f}   x`).join('\n')}\n  --model <ID>`,
}
const SCHEMA = {
  args: ['schema'],
  text: '{"run.output.delta":1,"run.terminal":1,"task.lifecycle":1,"tool.result":1}',
}

describe('parseMuseVersion', () => {
  it.each([
    ['muse 1.4.2-R3401.1', '1.4.2-R3401.1'],
    ['Muse Code 1.4.2', '1.4.2'],
    ['muse-code v1.4.0', '1.4.0'],
    ['1.3.0-R3401.1\n', '1.3.0-R3401.1'],
    ['warning: x\nmuse 0.1.0-R708.1', '0.1.0-R708.1'],
  ])('%j → %s', (out, version) => {
    expect(parseMuseVersion(out)).toEqual({ version })
  })

  it('a bare semver or another product is not Muse', () => {
    expect(parseMuseVersion('1.4.2')).toBeNull()
    expect(parseMuseVersion('claude 2.1.289 (Claude Code)')).toBeNull()
    expect(parseMuseVersion('')).toBeNull()
  })

  it('the spec looks for `muse` with --version, and a native install under ~/.local/bin', () => {
    expect(museCliSpec).toMatchObject({ vendor: 'muse', bin: 'muse', versionArgs: ['--version'] })
    expect(museWellKnown({ platform: 'win32', home: 'C:\\Users\\u' })).toEqual([
      'C:\\Users\\u\\.local\\bin\\muse.exe',
    ])
    expect(museWellKnown({ platform: 'linux', home: '/home/u' })).toEqual(['/home/u/.local/bin/muse'])
  })
})

describe('the checks', () => {
  it('version: recorded only, never judged', () => {
    expect(museVersionCheck('9.9.9', '1.4.2', 1)).toMatchObject({
      id: 'vendor.muse.version',
      status: 'pass',
      title: 'Muse 9.9.9',
    })
  })

  it('auth: META_API_KEY passes; without it a warning with the sign-in command, never a block', () => {
    expect(museAuthCheck({ META_API_KEY: 'k' }, 1)).toMatchObject({ status: 'pass', blocking: false })
    const none = museAuthCheck({ META_API_KEY: '  ' }, 1)
    expect(none).toMatchObject({ status: 'warn', blocking: false, category: 'auth_required' })
    expect(none.recovery[0]).toMatchObject({ kind: 'shell_copy', command: 'muse' })
    expect(museAccount({ META_API_KEY: 'k' })).toEqual({ method: 'api-key' })
    expect(museAccount({})).toBeUndefined()
  })

  it('protocol: the help names every exec flag a pass needs; the schema is compared with the pin (warn)', () => {
    const synthesized = museProtocolCheck(HELP, SCHEMA, MUSE_PIN, 1)
    expect(synthesized).toMatchObject({
      status: 'warn',
      blocking: false,
      title: "Muse's event shapes are not pinned yet",
    })
    const pinned = { ...MUSE_PIN, liveSchemaSha256: schemaHash(SCHEMA.text) }
    expect(museProtocolCheck(HELP, SCHEMA, pinned, 1)).toMatchObject({ status: 'pass', recovery: [] })
    const changed = { ...MUSE_PIN, liveSchemaSha256: 'f'.repeat(64) }
    expect(museProtocolCheck(HELP, SCHEMA, changed, 1)).toMatchObject({
      status: 'warn',
      title: "Muse's schema changed since Dim Factory pinned it",
    })
    const unnamed = museProtocolCheck(HELP, { args: ['schema'], text: '{}' }, pinned, 1)
    expect(unnamed.detail).toContain('The schema does not name run.output.delta')
    const noHelp = museProtocolCheck({ error: 'ENOENT' }, SCHEMA, pinned, 1)
    expect(noHelp).toMatchObject({ status: 'warn', title: 'Muse: could not read its exec options' })
    const missing = museProtocolCheck({ text: 'Options:\n  --json' }, SCHEMA, pinned, 1)
    expect(missing).toMatchObject({ status: 'fail', blocking: true, category: 'flag_drift' })
  })

  it('schemaHash folds CRLF and trailing whitespace', () => {
    expect(schemaHash('{"a":1}\r\n')).toBe(schemaHash('{"a":1}'))
  })

  it('plan: Plan does not run on Muse (no read-only mode)', () => {
    expect(musePlanCheck(1)).toMatchObject({ id: 'vendor.muse.plan', status: 'skip' })
  })

  it('no check text carries an em dash', () => {
    const all = [
      museVersionCheck('1', '1', 1),
      museAuthCheck({}, 1),
      museProtocolCheck(HELP, SCHEMA, MUSE_PIN, 1),
      museProtocolCheck({ text: '' }, undefined, MUSE_PIN, 1),
      musePlanCheck(1),
    ]
    for (const c of all) expect(`${c.title} ${c.detail}`).not.toContain('\u2014')
    expect(MUSE_DEFAULT_MODEL).toBe('muse-spark-1.2')
  })
})
