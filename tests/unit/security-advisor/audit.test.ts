// The security advisor's audits without running them: which audit applies to a change (per ecosystem, the JS lockfile
// precedence, Yarn 2+ and pip without a requirements.txt as notes, subfolders as notes, no command when no manifest
// changed), each tool's JSON output read from realistic fixtures (npm 7+, npm 6 / pnpm, yarn classic NDJSON,
// pip-audit new and old, cargo audit, the govulncheck stream) with noise around it, severities, and advisories split
// into introduced by the change and already there.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Advisory, AuditParse } from '@core/security/audit.ts'
import {
  classifyAdvisories,
  jsonValues,
  normalizeSeverity,
  parseAuditOutput,
  planAudits,
} from '@core/security/audit.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

function advisories(parse: AuditParse): Advisory[] {
  if (!parse.ok) throw new Error(`expected a report, got: ${parse.reason}`)
  return parse.advisories
}

describe('planAudits', () => {
  it('plans npm audit for a changed package-lock.json', () => {
    const plan = planAudits(['package.json', 'package-lock.json', 'src/index.ts'], ['package-lock.json'])
    expect(plan).toEqual({
      commands: [
        {
          tool: 'npm',
          name: 'npm audit',
          argv: ['npm', 'audit', '--json'],
          cwdRel: '.',
          lockfile: 'package-lock.json',
        },
      ],
      notes: [],
    })
  })

  it('plans npm audit on npm-shrinkwrap.json when package.json alone changed', () => {
    const plan = planAudits(['package.json', 'npm-shrinkwrap.json'], ['package.json'])
    expect(plan.commands.map((c) => [c.tool, c.lockfile])).toEqual([['npm', 'npm-shrinkwrap.json']])
  })

  it('picks pnpm-lock.yaml over yarn.lock over package-lock.json', () => {
    const all = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']
    expect(planAudits(all, ['package.json']).commands.map((c) => [c.tool, c.argv, c.lockfile])).toEqual([
      ['pnpm', ['pnpm', 'audit', '--json'], 'pnpm-lock.yaml'],
    ])
    const noPnpm = all.filter((f) => f !== 'pnpm-lock.yaml')
    expect(planAudits(noPnpm, ['yarn.lock']).commands.map((c) => [c.tool, c.argv, c.lockfile])).toEqual([
      ['yarn', ['yarn', 'audit', '--json'], 'yarn.lock'],
    ])
  })

  it('notes that the Yarn 2+ audit is not supported', () => {
    const plan = planAudits(['package.json', 'yarn.lock', '.yarnrc.yml'], ['yarn.lock'])
    expect(plan.commands).toEqual([])
    expect(plan.notes).toEqual([expect.stringContaining('Yarn 2+')])
  })

  it('notes a package.json with no lockfile', () => {
    const plan = planAudits(['package.json'], ['package.json'])
    expect(plan.commands).toEqual([])
    expect(plan.notes).toEqual([expect.stringContaining('lockfile')])
  })

  it('plans pip-audit on requirements.txt', () => {
    const plan = planAudits(['requirements.txt', 'requirements-dev.txt', 'app.py'], ['requirements-dev.txt'])
    expect(plan.commands).toEqual([
      {
        tool: 'pip-audit',
        name: 'pip-audit',
        argv: ['pip-audit', '-r', 'requirements.txt', '-f', 'json', '--progress-spinner', 'off'],
        cwdRel: '.',
        lockfile: 'requirements.txt',
      },
    ])
  })

  it('notes that pip-audit needs a requirements.txt', () => {
    const plan = planAudits(['pyproject.toml', 'poetry.lock'], ['poetry.lock'])
    expect(plan.commands).toEqual([])
    expect(plan.notes).toEqual([expect.stringContaining('requirements.txt')])
  })

  it('plans cargo audit and govulncheck', () => {
    const files = ['Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum']
    const plan = planAudits(files, ['Cargo.toml', 'go.mod'])
    expect(plan.commands.map((c) => [c.tool, c.name, c.argv, c.lockfile])).toEqual([
      ['cargo-audit', 'cargo audit', ['cargo', 'audit', '--json'], 'Cargo.lock'],
      ['govulncheck', 'govulncheck', ['govulncheck', '-json', './...'], 'go.sum'],
    ])
    expect(planAudits(['go.mod'], ['go.mod']).commands[0]?.lockfile).toBe('go.mod')
  })

  it('plans nothing when no manifest or lockfile changed', () => {
    const files = [
      'package.json',
      'package-lock.json',
      'requirements.txt',
      'Cargo.lock',
      'Cargo.toml',
      'go.mod',
    ]
    expect(planAudits(files, ['src/app.ts', 'README.md'])).toEqual({ commands: [], notes: [] })
  })

  it('plans nothing for an ecosystem the project does not use', () => {
    expect(planAudits(['README.md'], ['package-lock.json'])).toEqual({ commands: [], notes: [] })
  })

  it('notes dependency changes in a subfolder and audits only the root', () => {
    const files = ['package.json', 'package-lock.json', 'web/package.json', 'web/package-lock.json']
    const plan = planAudits(files, [
      'web/package-lock.json',
      'web\\package.json',
      'node_modules/x/package.json',
    ])
    expect(plan.commands).toEqual([])
    expect(plan.notes).toEqual([expect.stringContaining('web/')])
  })
})

describe('jsonValues', () => {
  it('finds each top-level value around noise, braces inside strings included', () => {
    const text = 'warn: [1/4] start\n{"a":"}{"}\nnoise ] {\n{"b":[1,{"c":"\\"]"}]}\ntrailing'
    expect(jsonValues(text)).toEqual([{ a: '}{' }, { b: [1, { c: '"]' }] }])
  })
})

describe('parseAuditOutput: npm', () => {
  it('reads an npm 7+ report: one advisory per via object, transitive-only entries skipped', () => {
    const list = advisories(parseAuditOutput('npm', fixture('npm-v7.json')))
    expect(list).toEqual([
      {
        tool: 'npm',
        ecosystem: 'npm',
        package: 'minimist',
        id: 'GHSA-xvch-5gv4-984h',
        title: 'Prototype Pollution in minimist',
        severity: 'critical',
        severityKnown: true,
        url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
      },
      {
        tool: 'npm',
        ecosystem: 'npm',
        package: 'semver',
        id: 'GHSA-c2qf-rxjj-qqgw',
        title: 'semver vulnerable to Regular Expression Denial of Service',
        severity: 'medium',
        severityKnown: true,
        url: 'https://github.com/advisories/GHSA-c2qf-rxjj-qqgw',
        fixedIn: '7.5.4',
      },
      {
        tool: 'npm',
        ecosystem: 'npm',
        package: 'legacy-parser',
        id: '1523',
        title: 'Arbitrary code execution in legacy-parser',
        severity: 'high',
        severityKnown: true,
        url: 'https://www.npmjs.com/advisories/1523',
      },
    ])
  })

  it('reads a clean report as no advisories, with noise around it', () => {
    const text = `npm WARN config production Use \`--omit=dev\` instead.\n${fixture('npm-v7-clean.json')}\n[done]\n`
    expect(parseAuditOutput('npm', text)).toEqual({ ok: true, advisories: [] })
  })

  it('reads noise before and after a report with findings', () => {
    const text = `npm WARN deprecated x@1.0.0: {"not":"a report"}\n${fixture('npm-v7.json')}\nnpm notice done\n`
    expect(advisories(parseAuditOutput('npm', text)).map((a) => a.package)).toEqual([
      'minimist',
      'semver',
      'legacy-parser',
    ])
  })

  it('reads the error JSON as not ok with its summary', () => {
    expect(parseAuditOutput('npm', fixture('npm-error.json'))).toEqual({
      ok: false,
      reason: 'This command requires an existing lockfile.',
    })
  })

  it('replaces an em dash in a title and keeps it to one line of at most 200 characters', () => {
    const report = {
      auditReportVersion: 2,
      vulnerabilities: {
        x: {
          name: 'x',
          via: [
            {
              source: 1,
              name: 'x',
              title: `Bad thing \u2014 really bad\n${'second line'}`,
              url: 'https://example.invalid',
              severity: 'low',
            },
            { source: 2, name: 'x', title: 'y'.repeat(300), severity: 'info' },
          ],
        },
      },
      metadata: {},
    }
    const [a, b] = advisories(parseAuditOutput('npm', JSON.stringify(report)))
    expect(a?.title).toBe('Bad thing - really bad')
    expect(b?.title.length).toBeLessThanOrEqual(200)
    expect(b?.severity).toBe('low')
  })
})

describe('parseAuditOutput: npm 6 and pnpm', () => {
  const expected: Omit<Advisory, 'tool'>[] = [
    {
      ecosystem: 'npm',
      package: 'minimist',
      version: '1.2.0',
      id: '1179',
      title: 'Prototype Pollution',
      severity: 'low',
      severityKnown: true,
      url: 'https://npmjs.com/advisories/1179',
      fixedIn: '0.2.1',
    },
    {
      ecosystem: 'npm',
      package: 'lodash',
      version: '4.17.20',
      id: 'GHSA-35jh-r3h4-6jhm',
      title: 'Command Injection in lodash',
      severity: 'high',
      severityKnown: true,
      url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
      fixedIn: '4.17.21',
    },
    {
      ecosystem: 'npm',
      package: 'lodash',
      version: '4.17.19',
      id: 'GHSA-35jh-r3h4-6jhm',
      title: 'Command Injection in lodash',
      severity: 'high',
      severityKnown: true,
      url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
      fixedIn: '4.17.21',
    },
  ]

  it('reads pnpm audit --json: one advisory per advisory and finding version', () => {
    const list = advisories(parseAuditOutput('pnpm', fixture('pnpm-audit.json')))
    expect(list).toEqual(expected.map((a) => ({ tool: 'pnpm', ...a })))
  })

  it('reads the npm 6 shape from npm audit too', () => {
    const list = advisories(parseAuditOutput('npm', `> audit\n${fixture('pnpm-audit.json')}`))
    // Integer-like keys come out in numeric order: 1179 before 1096410.
    expect(list.map((a) => [a.tool, a.package, a.version])).toEqual([
      ['npm', 'minimist', '1.2.0'],
      ['npm', 'lodash', '4.17.20'],
      ['npm', 'lodash', '4.17.19'],
    ])
  })
})

describe('parseAuditOutput: yarn classic', () => {
  it('reads NDJSON advisories, deduped across resolution paths', () => {
    const list = advisories(parseAuditOutput('yarn', fixture('yarn-audit.ndjson')))
    expect(list.map((a) => [a.tool, a.package, a.version, a.id, a.severity])).toEqual([
      ['yarn', 'lodash', '4.17.20', 'GHSA-35jh-r3h4-6jhm', 'high'],
      ['yarn', 'minimist', '1.2.0', '1179', 'low'],
    ])
  })

  it('reads a summary alone as a clean report, and an error line as not ok', () => {
    const summary =
      '{"type":"auditSummary","data":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}'
    expect(parseAuditOutput('yarn', `yarn audit v1.22.19\n${summary}\nDone in 0.5s.`)).toEqual({
      ok: true,
      advisories: [],
    })
    expect(parseAuditOutput('yarn', '{"type":"error","data":"Error: Request failed \\"500\\""}')).toEqual({
      ok: false,
      reason: 'Error: Request failed "500"',
    })
  })
})

describe('parseAuditOutput: pip-audit', () => {
  it('reads the current shape: no severity, skipped dependencies ignored, names normalized', () => {
    const list = advisories(parseAuditOutput('pip-audit', fixture('pip-audit.json')))
    expect(list).toEqual([
      {
        tool: 'pip-audit',
        ecosystem: 'pip',
        package: 'requests',
        version: '2.25.0',
        id: 'PYSEC-2023-74',
        title:
          'Requests is a HTTP library. Since Requests 2.3.0, Requests has been leaking Proxy-Authorization headers to destination servers when redirected to an HTTPS endpoint.',
        severity: 'high',
        severityKnown: false,
        url: 'https://osv.dev/vulnerability/PYSEC-2023-74',
        fixedIn: '2.31.0',
      },
      {
        tool: 'pip-audit',
        ecosystem: 'pip',
        package: 'flask',
        version: '2.2.0',
        id: 'GHSA-m2qf-hxjv-5gpq',
        title: 'GHSA-m2qf-hxjv-5gpq',
        severity: 'high',
        severityKnown: false,
        url: 'https://osv.dev/vulnerability/GHSA-m2qf-hxjv-5gpq',
        fixedIn: '2.2.5',
      },
    ])
  })

  it('reads the older top-level array', () => {
    const list = advisories(
      parseAuditOutput('pip-audit', `Found 1 known vulnerability\n${fixture('pip-audit-old.json')}`),
    )
    expect(list.map((a) => [a.package, a.version, a.id, a.fixedIn])).toEqual([
      ['jinja2', '2.11.2', 'PYSEC-2021-66', '2.11.3'],
    ])
  })
})

describe('parseAuditOutput: cargo audit', () => {
  it('reads the vulnerability list and ignores the warnings', () => {
    const list = advisories(
      parseAuditOutput('cargo-audit', `    Fetching advisory database\n${fixture('cargo-audit.json')}`),
    )
    expect(list).toEqual([
      {
        tool: 'cargo-audit',
        ecosystem: 'cargo',
        package: 'rsa',
        version: '0.9.6',
        id: 'RUSTSEC-2023-0071',
        title: 'Marvin Attack: potential key recovery through timing sidechannels',
        severity: 'high',
        severityKnown: false,
        url: 'https://rustsec.org/advisories/RUSTSEC-2023-0071.html',
      },
      {
        tool: 'cargo-audit',
        ecosystem: 'cargo',
        package: 'h2',
        version: '0.3.22',
        id: 'RUSTSEC-2024-0332',
        title: 'Degradation of service in h2 servers with CONTINUATION Flood',
        severity: 'high',
        severityKnown: false,
        url: 'https://example.com/advisories/h2-continuation-flood',
        fixedIn: '0.3.26',
      },
    ])
  })

  it('takes the severity from a numeric CVSS score', () => {
    const report = {
      vulnerabilities: {
        found: true,
        count: 1,
        list: [
          {
            advisory: { id: 'RUSTSEC-2099-0001', package: 'demo', title: 'Demo', cvss: 9.1 },
            versions: { patched: ['>=1.0.1'] },
            package: { name: 'demo', version: '1.0.0' },
          },
        ],
      },
      warnings: {},
    }
    const [a] = advisories(parseAuditOutput('cargo-audit', JSON.stringify(report)))
    expect([a?.severity, a?.severityKnown, a?.fixedIn]).toEqual(['critical', true, '1.0.1'])
  })

  it('reads a clean report', () => {
    const clean = { vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} }
    expect(parseAuditOutput('cargo-audit', JSON.stringify(clean))).toEqual({ ok: true, advisories: [] })
  })
})

describe('parseAuditOutput: govulncheck', () => {
  it('reads the stream: only called code is an advisory, one per OSV id and module', () => {
    const list = advisories(parseAuditOutput('govulncheck', fixture('govulncheck.txt')))
    expect(list).toEqual([
      {
        tool: 'govulncheck',
        ecosystem: 'go',
        package: 'golang.org/x/crypto',
        version: 'v0.14.0',
        id: 'GO-2023-2402',
        title: 'Man-in-the-middle attacker can compromise integrity of secure channel in golang.org/x/crypto',
        severity: 'high',
        severityKnown: false,
        url: 'https://pkg.go.dev/vuln/GO-2023-2402',
        fixedIn: 'v0.17.0',
      },
    ])
  })

  it('reads a stream with no findings as clean, and Windows line endings too', () => {
    const config = fixture('govulncheck.txt').split('\n').slice(0, 12).join('\r\n')
    expect(parseAuditOutput('govulncheck', `go: downloading x\r\n${config}`)).toEqual({
      ok: true,
      advisories: [],
    })
  })
})

describe('parseAuditOutput: garbage', () => {
  it.each(['npm', 'pnpm', 'yarn', 'pip-audit', 'cargo-audit', 'govulncheck'] as const)(
    '%s: not ok on output with no report',
    (tool) => {
      for (const text of ['', 'command not found', '{"unrelated": true}', '{ broken json', '[1, 2']) {
        const parse = parseAuditOutput(tool, text)
        expect(parse.ok).toBe(false)
      }
    },
  )
})

describe('normalizeSeverity', () => {
  it.each([
    ['critical', 'critical', true],
    ['HIGH', 'high', true],
    ['Moderate', 'medium', true],
    ['medium', 'medium', true],
    ['low', 'low', true],
    ['info', 'low', true],
    [9.8, 'critical', true],
    [9, 'critical', true],
    [7, 'high', true],
    [6.9, 'medium', true],
    [4, 'medium', true],
    [3.9, 'low', true],
    [0, 'low', true],
    ['7.5', 'high', true],
    ['unrated', 'high', false],
    [11, 'high', false],
    [-1, 'high', false],
    [Number.NaN, 'high', false],
    [null, 'high', false],
    [undefined, 'high', false],
    [{ score: 9 }, 'high', false],
  ])('%s -> %s (known %s)', (raw, severity, known) => {
    expect(normalizeSeverity(raw)).toEqual({ severity, known })
  })
})

describe('classifyAdvisories', () => {
  const adv = (o: Partial<Advisory> & Pick<Advisory, 'package' | 'id'>): Advisory => ({
    tool: 'npm',
    ecosystem: 'npm',
    title: o.id,
    severity: 'high',
    severityKnown: true,
    ...o,
  })

  it('splits introduced from existing by package name', () => {
    const a = adv({ package: 'lodash', id: 'GHSA-1' })
    const b = adv({ package: 'react', id: 'GHSA-2' })
    expect(classifyAdvisories([a, b], [{ name: 'lodash', to: ['4.17.21'] }])).toEqual({
      introduced: [a],
      existing: [b],
    })
  })

  it('needs the advisory version to be one of the new versions when it names one', () => {
    const newOne = adv({ package: 'lodash', id: 'GHSA-1', version: '4.17.21' })
    const oldOne = adv({ package: 'lodash', id: 'GHSA-3', version: '4.17.19' })
    const result = classifyAdvisories([newOne, oldOne], [{ name: 'lodash', to: ['4.17.21'] }])
    expect(result).toEqual({ introduced: [newOne], existing: [oldOne] })
  })

  it('treats v1.2.3 and 1.2.3 as the same version, and * as any version', () => {
    const go = adv({
      tool: 'govulncheck',
      ecosystem: 'go',
      package: 'golang.org/x/net',
      id: 'GO-1',
      version: 'v0.21.0',
    })
    const pip = adv({
      tool: 'pip-audit',
      ecosystem: 'pip',
      package: 'requests',
      id: 'PYSEC-1',
      version: '2.25.0',
    })
    const result = classifyAdvisories(
      [go, pip],
      [
        { name: 'golang.org/x/net', to: ['0.21.0'] },
        { name: 'Requests', to: ['*'] },
      ],
    )
    expect(result).toEqual({ introduced: [go, pip], existing: [] })
  })

  it('collapses duplicates of tool, package and id, introduced when any of them is', () => {
    const old = adv({ package: 'lodash', id: 'GHSA-1', version: '4.17.19' })
    const fresh = adv({ package: 'lodash', id: 'GHSA-1', version: '4.17.20' })
    const other = adv({ package: 'semver', id: 'GHSA-2' })
    const result = classifyAdvisories([old, fresh, other, other], [{ name: 'lodash', to: ['4.17.20'] }])
    expect(result).toEqual({ introduced: [fresh], existing: [other] })
  })

  it('keeps the same id from two tools apart', () => {
    const a = adv({ package: 'lodash', id: 'GHSA-1' })
    const b = adv({ tool: 'pnpm', package: 'lodash', id: 'GHSA-1' })
    expect(classifyAdvisories([a, b], []).existing).toEqual([a, b])
  })
})
