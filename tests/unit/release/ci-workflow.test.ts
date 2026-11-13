// .github/workflows/ci.yml and codex-weekly.yml for a public repository on free GitHub Actions (docs/RELEASING.md
// "Enable GitHub Actions"): CI runs on every push to main and every pull request on Windows, macOS and Linux, needs no
// secret or variable (a fork's pull request has none), and the weekly jobs stay, also without secrets. Every action is
// pinned to a version: a full commit SHA with its tag beside it, or an exact vX.Y.Z tag. Read as text, as
// tests/unit/release/ci-coverage.test.ts reads ci.yml.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const weekly = readFileSync('.github/workflows/codex-weekly.yml', 'utf8')
const release = readFileSync('.github/workflows/release.yml', 'utf8')
const releasing = readFileSync('docs/RELEASING.md', 'utf8')

/** The `on:` block of a workflow. */
const onBlock = (wf: string): string => /^on:\n((?: {2}.*\n|\n)+)/m.exec(wf)?.[1] ?? ''

describe('ci.yml', () => {
  it('runs on every push to main and every pull request', () => {
    const on = onBlock(ci)
    expect(on).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m)
    expect(on).toMatch(/^ {2}pull_request:$/m)
    // Not pull_request_target: a fork's code never runs with the base repository's token or secrets.
    expect(ci).not.toMatch(/pull_request_target/)
  })

  it('tests on Windows, macOS and Linux', () => {
    expect(ci).toMatch(/os: \[windows-latest, macos-latest, ubuntu-latest\]/)
    expect(releasing).toMatch(/runs `ci\.yml` on Windows, macOS and Linux/)
  })

  it('needs no secret and no variable, and only reads the repository', () => {
    expect(ci).not.toMatch(/secrets\.|vars\./)
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m)
    // The package job never picks up a certificate on the runner.
    expect(ci).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
  })
})

describe('codex-weekly.yml', () => {
  it('still runs weekly (and by hand), with no secret and no variable', () => {
    const on = onBlock(weekly)
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: /m)
    expect(on).toMatch(/^ {2}workflow_dispatch:/m)
    expect(weekly).not.toMatch(/secrets\.|vars\./)
    expect(weekly).toMatch(/^permissions:\n {2}contents: read$/m)
  })
})

describe('action pins', () => {
  const workflows = { ci, weekly, release }

  it('pins every action in every workflow to a version', () => {
    for (const [name, wf] of Object.entries(workflows)) {
      const uses = wf.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))
      expect(uses.length, name).toBeGreaterThan(0)
      for (const l of uses)
        expect(l, `${name}: ${l}`).toMatch(
          /uses: [\w.-]+\/[\w.-]+@(?:[0-9a-f]{40} # v\d+\.\d+\.\d+|v\d+\.\d+\.\d+)$/,
        )
    }
  })

  it('uses the same version of an action everywhere', () => {
    const pins = new Map<string, Set<string>>()
    for (const wf of Object.values(workflows))
      for (const m of wf.matchAll(/uses: ([\w.-]+\/[\w.-]+)@(\S+)/g)) {
        const key = m[1] ?? ''
        pins.set(key, (pins.get(key) ?? new Set()).add(m[2] ?? ''))
      }
    for (const [action, set] of pins) expect([...set], action).toHaveLength(1)
  })
})
