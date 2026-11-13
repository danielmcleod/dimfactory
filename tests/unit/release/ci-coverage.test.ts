// The coverage bar "≥ 80% lines / 75% branches on core+shared"
// is enforced by CI, not only by a hand-run `pnpm test:coverage` (a review found that no CI job ran it,
// so vitest.config.ts's thresholds never failed a build).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import config from '../../../vitest.config.ts'

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
  .scripts

/** The `test:` job's block of ci.yml (up to the next top-level job). */
function testJob(): string {
  const start = ci.search(/^ {2}test:\s*$/m)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = ci.slice(start + 1)
  const next = rest.search(/^ {2}[\w-]+:\s*$/m)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('the coverage bar in CI', () => {
  it('the test job runs pnpm test:coverage', () => {
    expect(testJob()).toMatch(/^\s+run: pnpm test:coverage\s*$/m)
  })

  it('test:coverage measures the unit and integration projects with coverage on', () => {
    const s = scripts['test:coverage'] ?? ''
    expect(s).toMatch(/--project unit\b/)
    expect(s).toMatch(/--project integration\b/)
    expect(s).toMatch(/--coverage\b/)
  })

  it('vitest.config.ts holds core + shared to 80% lines and 75% branches', () => {
    const thresholds = config.test?.coverage?.thresholds as Record<string, unknown> | undefined
    expect(thresholds?.['src/{core,shared}/**']).toEqual({ lines: 80, branches: 75 })
  })

  it('every OS still runs the unit, renderer and integration projects', () => {
    const job = testJob()
    expect(job).toMatch(/run: pnpm test\s*$/m)
    expect(job).toMatch(/run: pnpm test:renderer\s*$/m)
    expect(job).toMatch(/run: pnpm test:int\s*$/m)
    // The OS that runs coverage skips the plain runs of the same two projects, and only that one.
    const cov = /- if: (.+)\n\s+run: pnpm test:coverage/.exec(job)?.[1]
    const unit = /- if: (.+)\n\s+run: pnpm test\s*\n/.exec(job)?.[1]
    const int = /- if: (.+)\n\s+run: pnpm test:int/.exec(job)?.[1]
    expect(cov).toBe("runner.os == 'Windows'")
    expect(unit).toBe("runner.os != 'Windows'")
    expect(int).toBe("runner.os != 'Windows'")
  })
})
