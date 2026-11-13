// `dimf probe [vendor] [--json] [--force]`: the vendor probe (every check it runs, per vendor).
import { parseArgs } from 'node:util'
import type { CheckResult } from '../../shared/preflight.ts'
import type { ProbeResult } from '../../shared/vendors.ts'
import { adapterRegistry } from '../../core/adapters/registry.ts'
import '../../core/adapters/claude/index.ts'
import '../../core/adapters/codex/index.ts'
import '../../core/adapters/gemini/index.ts'
import '../../core/adapters/grok/index.ts'
import '../../core/adapters/muse/index.ts'

export const PROBE_USAGE = 'dimf probe [claude|codex|gemini|grok|muse] [--json] [--force]'

const STATUS_LABEL: Record<CheckResult['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
}

const BINARY_SOURCE: Record<NonNullable<ProbeResult['binary']>['source'], string> = {
  config: 'configured',
  known: 'well-known',
  path: 'PATH',
  'npm-prefix': 'npm prefix',
  'desktop-bundle': 'desktop bundle',
}

/** Exit 0 when every check passed, warned or was skipped. */
export function probeExitCode(r: ProbeResult): number {
  return r.checks.some((c) => c.status === 'fail') ? 1 : 0
}

export function formatProbe(r: ProbeResult, displayName: string): string {
  const lines: string[] = []
  const failed = r.checks.some((c) => c.status === 'fail')
  const warned = r.checks.some((c) => c.status === 'warn')
  lines.push(`${displayName}: ${failed ? 'not ready' : warned ? 'ready, with warnings' : 'ready'}`)
  if (r.binary !== undefined) lines.push(`  binary   ${r.binary.path} (${BINARY_SOURCE[r.binary.source]})`)
  if (r.version !== undefined) lines.push(`  version  ${r.version}`)
  if (r.account !== undefined)
    lines.push(`  account  ${r.account.method}${r.account.plan ? ` (${r.account.plan})` : ''}`)
  if (r.models.length > 0) lines.push(`  models   ${r.models.map((m) => m.id).join(', ')}`)
  lines.push('')
  const width = Math.max(...r.checks.map((c) => c.id.length), 10)
  for (const c of r.checks) {
    lines.push(`  ${STATUS_LABEL[c.status]}  ${c.id.padEnd(width)}  ${c.title}`)
    for (const d of c.detail.split('\n').filter((l) => l.trim() !== ''))
      lines.push(`        ${''.padEnd(width)}  ${d}`)
    for (const a of c.recovery) {
      const how = a.kind === 'shell_copy' ? `: ${a.command}` : a.kind === 'open_docs' ? `: ${a.url}` : ''
      lines.push(`        ${''.padEnd(width)}  → ${a.label}${how}`)
    }
  }
  return lines.join('\n')
}

export async function probeCommand(args: readonly string[], out: (s: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean', default: false }, force: { type: 'boolean', default: false } },
    allowPositionals: true,
  })
  const vendors = positionals.length > 0 ? positionals : ['claude']
  let code = 0
  const results: ProbeResult[] = []
  for (const v of vendors) {
    const adapter = adapterRegistry.get(v)
    if (adapter === undefined) {
      out(
        `Unknown vendor "${v}". Known: ${adapterRegistry
          .list()
          .map((e) => e.id)
          .join(', ')}`,
      )
      return 2
    }
    const r = await adapter.probe({ force: values.force })
    results.push(r)
    code = Math.max(code, probeExitCode(r))
    if (!values.json) out(formatProbe(r, adapter.displayName))
  }
  if (values.json) out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2))
  return code
}
