// `dimf deploy <folder>` (dev/CI): the Deploy helper on demand, read-only. What the folder ships as (classified with
// local rules, no tokens), where it could go (the packs' targets, each with its trade-offs and the cost caveat), the
// pre-flight checklist (secrets, .env files, environment variables, licence; the rest marked "not checked"), and the
// deploy steps of the recommended target (or --target) as commands to copy. Nothing is ever run, signed in to or
// stored. Exit 0, or 1 when the checklist found a problem (a committed secret or .env file).
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Core } from '../../core/app-core.ts'
import { DEPLOY_CLASSES, isDeployClass } from '../../shared/deploy.ts'
import type { CheckState, DeployReport } from '../../shared/deploy.ts'
import { UsageError } from '../args.ts'
import type { CliIo } from '../io.ts'
import { EXIT, usage, withReadOnlyCore } from '../session.ts'

export const DEPLOY_USAGE = 'dimf deploy <folder> [--class c] [--target id] [--json] [--home dir]'

const STATE_TEXT: Readonly<Record<CheckState, string>> = {
  ok: 'ok',
  warn: 'warn',
  problem: 'PROBLEM',
  'not-checked': 'not checked',
}

const CONFIDENCE_TEXT = { high: 'high confidence', medium: 'medium confidence', low: 'a guess' } as const
const SOURCE_TEXT = {
  brief: 'from the brief',
  folder: 'from the folder',
  task: 'from the task',
  default: 'by default',
  user: 'as you chose',
} as const

/** The report as lines (the steps of `target`, else the recommended option). */
export function deployLines(r: DeployReport, target?: string): string[] {
  const out: string[] = []
  out.push(`Deploy helper for ${r.folder}`)
  out.push(`Deliverable: ${r.cls.label} (${SOURCE_TEXT[r.cls.source]}, ${CONFIDENCE_TEXT[r.cls.confidence]})`)
  for (const why of r.cls.reasons) out.push(`  - ${why}`)
  if (r.cls.alternatives.length > 0) {
    const labels = r.cls.alternatives.map((a) => r.classes.find((c) => c.id === a)?.label ?? a)
    out.push(`  Also possible: ${labels.join(', ')} (pass --class to choose)`)
  }
  out.push('')
  if (r.options.length === 0) out.push('No deploy target for this class yet.')
  else out.push('Where it could go:')
  for (const o of r.options) {
    out.push(`  ${o.recommended ? '*' : ' '} ${o.id}  ${o.label}`)
    out.push(`      Free tier: ${o.freeTier}`)
    out.push(`      Cost: ${o.cost}`)
    out.push(`      Cold starts: ${o.coldStarts}`)
    out.push(`      Custom domains: ${o.customDomains}`)
    out.push(`      Data residency: ${o.dataResidency}`)
    if (o.configs.length > 0)
      out.push(
        `      Config: ${o.configs.map((c) => `${c.path} (${c.present ? 'there' : 'missing'})`).join(', ')}`,
      )
  }
  if (r.options.length > 0) out.push(`  ${r.caveats.cost}`)
  out.push('')
  out.push('Pre-flight checklist:')
  for (const item of r.checklist) {
    const state = item.tickedAt !== undefined ? 'ticked by you' : STATE_TEXT[item.state]
    out.push(`  ${state.padEnd(13)} ${item.label}: ${item.detail}`)
    for (const e of item.evidence ?? []) out.push(`                - ${e}`)
  }
  out.push(`  ${r.caveats.security}`)
  for (const n of r.notes) out.push(`Note: ${n}`)
  const chosen = r.options.find((o) => o.id === (target ?? r.target))
  if (chosen !== undefined) {
    out.push('')
    out.push(`Steps for ${chosen.label}${chosen.needs !== undefined ? ` (needs ${chosen.needs})` : ''}:`)
    out.push(`  ${r.caveats.commands}`)
    chosen.steps.forEach((s, i) => {
      out.push(`  ${i + 1}. ${s.label}`)
      if (s.command !== undefined) out.push(`     $ ${s.command}`)
      if (s.note !== undefined) out.push(`     ${s.note}`)
    })
  }
  return out
}

interface Values {
  class?: string | undefined
  target?: string | undefined
  json?: boolean | undefined
  home?: string | undefined
}

async function runDeploy(core: Core, io: CliIo, folder: string, v: Values): Promise<number> {
  const r = await core.invoke('deploy.inspect', {
    folder,
    ...(v.class !== undefined && isDeployClass(v.class) ? { cls: v.class } : {}),
  })
  if (!r.ok) {
    io.err(`dimf deploy: ${r.error.message}`)
    return r.error.code === 'NOT_FOUND' || r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
  }
  const report = r.value
  if (v.target !== undefined && !report.options.some((o) => o.id === v.target)) {
    io.err(
      `dimf deploy: no target "${v.target}" for a ${report.cls.label.toLowerCase()} (targets: ${report.options.map((o) => o.id).join(', ') || 'none'})`,
    )
    return EXIT.usage
  }
  if (v.json === true) io.out(JSON.stringify(report, null, 2))
  else for (const l of deployLines(report, v.target)) io.out(l)
  return report.checklist.some((i) => i.state === 'problem') ? EXIT.failed : EXIT.completed
}

export async function deployCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: Values
  let folder: string
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        class: { type: 'string' },
        target: { type: 'string' },
        json: { type: 'boolean', default: false },
        home: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <folder>')
    if (v.class !== undefined && !isDeployClass(v.class))
      throw new UsageError(`--class takes one of ${DEPLOY_CLASSES.join(', ')}`)
    folder = resolve(io.cwd, parsed.positionals[0] ?? '.')
  } catch (err) {
    return usage(io, 'deploy', DEPLOY_USAGE, err)
  }
  return withReadOnlyCore(io, v.home, (core) => runDeploy(core, io, folder, v), { configBanner: false })
}
