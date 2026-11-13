// The security advisor's parts outside the state machine:
//   - findings: `[security:<level>]` (critical/high → must, medium/low → should, the level kept), a bare
//     `[security]`, emphasis and spelling variants; the {{findings}} line names the level
//   - the re-check's answer: resolved / open with reasons, lenient forms, unnamed ones open, unknown F-numbers ignored
//   - the scan: secrets become critical (a known format) or medium (entropy) findings that never hold the value;
//     advisories only for dependencies the run added or changed (pre-existing ones are one note); a missing tool or
//     unreadable output is a note, never a finding; a skipped audit is reported as such
//   - config: off in every built-in profile but thorough, on there with its re-check; a run override or project file
//     turns it on; a project file cannot set passthrough on it; the CLI's --security
//   - estimates: the scan, Security and the re-check join the run total when on
//   - templates: security.md validates, and fix.md's security section renders only with security findings
import { describe, expect, it } from 'vitest'
import type { VerifyCommandResult } from '@shared/verify.ts'
import { validateSemantics } from '@shared/config-schema.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { plannedSteps } from '@core/estimates/estimate.ts'
import { parseFindings } from '@core/findings/parse.ts'
import { renderFindings } from '@core/findings/render.ts'
import { readBuiltinTemplate } from '@core/prompts/resolve.ts'
import { validateTemplate } from '@core/prompts/template.ts'
import { parseRecheck } from '@core/security/recheck.ts'
import { advisoryFinding, auditOutcome, runSecurityScan, secretFinding } from '@core/security/scan.ts'
import type { AuditRun, ScanIo } from '@core/security/scan.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import { withSecurityFlag } from '../../../src/cli/commands/run.ts'

describe('findings with a security level', () => {
  it.each([
    ['- [security:critical] `a.ts:1` — leaked key. Remove it.', 'must', 'critical'],
    ['- [security:high] `a.ts:2`: SQL built from input. Bind it.', 'must', 'high'],
    ['- [security:medium] `a.ts:3`: no rate limit. Add one.', 'should', 'medium'],
    ['- [security:low] `a.ts:4`: verbose errors. Trim them.', 'should', 'low'],
    ['- [Security: High] `a.ts:5`: spaced and capitalised.', 'must', 'high'],
    ['- **[security:moderate]** `a.ts:6`: npm says moderate.', 'should', 'medium'],
    ['- [security-critical] `a.ts:7`: hyphenated.', 'must', 'critical'],
  ])('%s', (line, severity, level) => {
    const r = parseFindings(line, 'security')
    expect(r.parse.status).toBe('ok')
    expect(r.findings[0]).toMatchObject({ severity, level, source: 'security' })
  })

  it('a bare [security] is a should without a level; other tags keep no level', () => {
    const r = parseFindings('- [security] something\n- [must] other', 'security')
    expect(r.findings.map((f) => [f.severity, f.level])).toEqual([
      ['must', undefined],
      ['should', undefined],
    ])
  })

  it('tidies the location (no em dash reaches the app) and keeps must first', () => {
    const r = parseFindings(
      '- [security:low] `b.ts:9` — low one\n- [security:critical] `a.ts:1` — key in code',
      'security',
    )
    expect(r.findings.map((f) => f.title)).toEqual(['`a.ts:1`: key in code', '`b.ts:9`: low one'])
    expect(r.findings.map((f) => f.n)).toEqual([1, 2])
  })

  it('NO FINDINGS is none', () => {
    expect(parseFindings('NO FINDINGS', 'security').parse.status).toBe('none')
  })

  it('{{findings}} names the level', () => {
    const [f] = parseFindings('- [security:high] `a.ts:2`: injection', 'security').findings
    if (f === undefined) throw new Error('no finding')
    expect(renderFindings([{ ...f, n: 4 }])).toBe(
      '- [must] F4 (security) [security:high] `a.ts:2`: injection',
    )
  })
})

describe('the re-check answer', () => {
  it('reads resolved and open lines leniently', () => {
    expect(
      parseRecheck(
        [
          '- F1 resolved',
          '* **F2**: open: still there',
          '`F3` fixed',
          'F4 not resolved - only hidden',
          'F9 resolved',
        ].join('\n'),
        [1, 2, 3, 4],
      ),
    ).toEqual({
      resolved: [1, 3],
      open: [
        { n: 2, reason: 'still there' },
        { n: 4, reason: 'only hidden' },
      ],
      named: 4,
    })
  })

  it('keeps an unnamed finding open, and the last line for a number wins', () => {
    expect(parseRecheck('F1 open: no\nF1 resolved', [1, 2])).toEqual({
      resolved: [1],
      open: [{ n: 2 }],
      named: 1,
    })
    expect(parseRecheck('', [5]).named).toBe(0)
  })
})

const io = (files: Record<string, Record<string, string | null>>, patch = ''): ScanIo => ({
  patch: () => Promise.resolve(patch),
  changedPaths: () => Promise.resolve(['package-lock.json']),
  fileAt: (commit, path) => Promise.resolve(files[commit]?.[path] ?? null),
  folderFiles: () => Promise.resolve(['package.json', 'package-lock.json']),
})

const lock = (deps: Record<string, string>): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v }])),
    },
  })

const npmAudit = (vulns: Record<string, { severity: string; title: string; ghsa: string }>): string =>
  JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      Object.entries(vulns).map(([name, v]) => [
        name,
        {
          name,
          severity: v.severity,
          isDirect: true,
          via: [
            {
              source: 1,
              name,
              dependency: name,
              title: v.title,
              url: `https://github.com/advisories/${v.ghsa}`,
              severity: v.severity,
              range: '<9.9.9',
            },
          ],
          effects: [],
          range: '<9.9.9',
          nodes: [`node_modules/${name}`],
          fixAvailable: true,
        },
      ]),
    ),
    metadata: {},
  })

const ran = (
  status: VerifyCommandResult['status'],
  o: Partial<VerifyCommandResult> = {},
): VerifyCommandResult => ({
  name: 'npm audit',
  argv: ['npm', 'audit', '--json'],
  status,
  exitCode: status === 'fail' ? 1 : status === 'pass' ? 0 : null,
  durationMs: 10,
  excerpt: '',
  logPath: '',
  ...o,
})

const NPM = { name: 'npm audit', tool: 'npm', lockfile: 'package-lock.json' }

describe('the scan', () => {
  it('turns advisories for added or changed dependencies into findings; the rest is one note', async () => {
    const stdout = npmAudit({
      'left-pad-ng': { severity: 'critical', title: 'Prototype pollution', ghsa: 'GHSA-aaaa-bbbb-cccc' },
      oldlib: { severity: 'high', title: 'Old problem', ghsa: 'GHSA-dddd-eeee-ffff' },
    })
    const runs = new Map<string, AuditRun>([['npm audit', { result: ran('fail'), stdout }]])
    const out = await runSecurityScan(
      io({
        base: { 'package-lock.json': lock({ oldlib: '1.0.0' }) },
        s1: { 'package-lock.json': lock({ oldlib: '1.0.0', 'left-pad-ng': '0.1.0' }) },
      }),
      {
        from: 'base',
        to: 's1',
        audits: [{ ...NPM, argv: ['npm', 'audit', '--json'], cwdRel: '.', run: true }],
        runAudits: () => Promise.resolve(runs),
      },
    )
    expect(out.audits).toEqual([{ name: 'npm audit', status: 'done', introduced: 1, existing: 1 }])
    expect(out.advisories.map((a) => [a.package, a.level])).toEqual([['left-pad-ng', 'critical']])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]).toMatchObject({ severity: 'must', level: 'critical', source: 'scan' })
    expect(out.existing).toBe(1)
    expect(out.notes.some((n) => n.startsWith('One advisory for dependencies this run did not change'))).toBe(
      true,
    )
  })

  it('finds a secret in the patch: critical, masked, never the whole value', async () => {
    const key = ['AK', 'IA', 'Q7RZ', 'M2XK', 'P9WB', 'T4NV'].join('')
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,0 +2,1 @@',
      `+export const awsKey = '${key}'`,
    ].join('\n')
    const out = await runSecurityScan(io({}, patch), {
      from: 'a',
      to: 'b',
      audits: [],
      runAudits: () => Promise.resolve(new Map()),
    })
    expect(out.secrets).toHaveLength(1)
    expect(out.secrets[0]).toMatchObject({ file: 'src/config.ts', line: 2, level: 'critical' })
    expect(out.findings[0]).toMatchObject({ severity: 'must', level: 'critical' })
    expect(JSON.stringify(out)).not.toContain(key)
    expect(out.findings[0]?.title).toContain('AKIA…')
  })

  it('an entropy hit is a medium [should]', () => {
    const f = secretFinding({
      file: 'a.ts',
      line: 3,
      label: 'High-entropy string near a secret name',
      masked: 'q8Zx… (40 chars)',
      confidence: 'entropy',
      level: 'medium',
    })
    expect(f).toMatchObject({ severity: 'should', level: 'medium' })
    expect(f.title).toContain('Possible secret')
  })

  it('a missing tool is a note, never a finding', () => {
    const out = auditOutcome(
      NPM,
      { result: ran('env', { reason: 'Dim Factory could not find npm' }), stdout: '' },
      {
        before: null,
        after: lock({}),
      },
    )
    expect(out.row).toEqual({ name: 'npm audit', status: 'env', reason: 'Dim Factory could not find npm' })
    expect(out.introduced).toEqual([])
    expect(out.notes[0]).toContain('could not run')
  })

  it('unreadable output is a note, never a finding', () => {
    const out = auditOutcome(
      NPM,
      { result: ran('fail'), stdout: 'npm ERR! something' },
      { before: null, after: null },
    )
    expect(out.row.status).toBe('unreadable')
    expect(out.introduced).toEqual([])
    expect(out.notes[0]).toContain('could not read the output')
  })

  it('a lockfile that cannot be read makes no finding: advisories it cannot attribute are a note', () => {
    const stdout = npmAudit({
      oldlib: { severity: 'critical', title: 'Old problem', ghsa: 'GHSA-dddd-eeee-ffff' },
    })
    for (const lockText of [
      { before: lock({ oldlib: '1.0.0' }), after: 'not a lockfile' },
      { before: 'not a lockfile', after: lock({ oldlib: '1.0.0' }) },
    ]) {
      const out = auditOutcome(NPM, { result: ran('fail'), stdout }, lockText)
      expect(out.row).toMatchObject({ name: 'npm audit', status: 'unreadable' })
      expect(out.row.reason).toContain('package-lock.json')
      expect(out.introduced).toEqual([])
      expect(out.notes).toHaveLength(1)
      expect(out.notes[0]).toContain('it is not a finding')
    }
  })

  it('a lockfile new in this run makes every advisory in it the run’s', () => {
    const stdout = npmAudit({
      oldlib: { severity: 'high', title: 'A problem', ghsa: 'GHSA-dddd-eeee-ffff' },
    })
    const out = auditOutcome(
      NPM,
      { result: ran('fail'), stdout },
      { before: null, after: lock({ oldlib: '1.0.0' }) },
    )
    expect(out.row).toEqual({ name: 'npm audit', status: 'done', introduced: 1, existing: 0 })
    expect(out.introduced.map((a) => a.package)).toEqual(['oldlib'])
  })

  it('an audit skipped (untrusted, by the user) is reported as skipped', () => {
    const out = auditOutcome(
      NPM,
      { result: ran('skipped-untrusted', { reason: 'Not trusted' }), stdout: '' },
      {
        before: null,
        after: null,
      },
    )
    expect(out.row).toEqual({ name: 'npm audit', status: 'skipped', reason: 'Not trusted' })
  })

  it('an advisory without a known severity is high, and says so', () => {
    const f = advisoryFinding({
      tool: 'pip-audit',
      package: 'requests',
      version: '2.0.0',
      id: 'PYSEC-2099-1',
      title: 'A problem',
      level: 'high',
      levelKnown: false,
    })
    expect(f).toMatchObject({ severity: 'must', level: 'high' })
    expect(f.body).toContain('treats it as high')
    expect(f.title).toBe('requests@2.0.0: PYSEC-2099-1 A problem')
  })
})

describe('config', () => {
  it('is off in every built-in profile but thorough', () => {
    for (const p of ['balanced', 'claude-only', 'codex-only', 'fast'] as const)
      expect(resolveBuiltinConfig({ profile: p }).passes.security.enabled, p).toBe(false)
    expect(resolveBuiltinConfig({ profile: 'thorough' }).passes.security).toMatchObject({
      enabled: true,
      vendor: 'claude',
      model: 'opus',
      recheck: true,
    })
  })

  it('a run override (the composer toggle, --security) turns it on, with its re-check', () => {
    const c = resolveBuiltinConfig({ overrides: { passes: { security: { enabled: true } } } })
    expect(c.passes.security).toMatchObject({
      enabled: true,
      mode: 'readonly',
      extensions: 'none',
      recheck: true,
    })
    expect(runConfigFromResolved(c).passes.security).toMatchObject({ enabled: true, recheck: true })
    const off = resolveBuiltinConfig({
      overrides: { passes: { security: { enabled: true, recheck: false } } },
    })
    expect(off.passes.security.recheck).toBe(false)
  })

  it('must stay read-only; a project file cannot let it use every extension', () => {
    const issues = validateSemantics(
      { passes: { security: { mode: 'autoedit', extensions: 'passthrough' } } },
      { scope: 'project' },
    )
    expect(issues.map((i) => i.code).sort()).toEqual(['readonly-pass', 'readonly-passthrough'])
  })

  it('the CLI --security sets the run override', () => {
    expect(withSecurityFlag({}, true)).toEqual({ passes: { security: { enabled: true } } })
    expect(withSecurityFlag({ passes: { security: { recheck: false } } }, true)).toEqual({
      passes: { security: { recheck: false, enabled: true } },
    })
    expect(withSecurityFlag({}, false)).toEqual({})
  })
})

describe('estimates', () => {
  it('plan the scan, Security and the re-check when on (and nothing of them when off)', () => {
    const on = plannedSteps(resolveBuiltinConfig({ profile: 'thorough' })).map((q) => q.key)
    expect(on).toEqual(expect.arrayContaining(['scan', 'security', 'recheck']))
    expect(on.indexOf('scan')).toBeLessThan(on.indexOf('review'))
    const off = plannedSteps(resolveBuiltinConfig()).map((q) => q.key)
    expect(off).not.toContain('scan')
    expect(off).not.toContain('security')
  })
})

describe('templates', () => {
  it('security.md validates with {{scan}} and the readers’ placeholders', () => {
    const v = validateTemplate(readBuiltinTemplate('security'), 'security')
    expect(v.issues).toEqual([])
    expect(v.placeholders).toEqual(expect.arrayContaining(['diff', 'scan', 'brief']))
  })

  it('recheck.md validates (internal)', () => {
    expect(validateTemplate(readBuiltinTemplate('recheck'), 'recheck').issues).toEqual([])
  })
})
