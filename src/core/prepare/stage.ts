// The prepare stages' deps and copy-in facts as the engine and the PrepareCard read them (Prepare steps 2 and 3;
// the depsConsent / depsFailed cards). decideDepsStage is step 3's decision in the
// worktree: an edited command ([Edit command]) over installCommand over detection, `install: 'never'` skipping, and
// the command's standing against the SOURCE folder's `deps` grants (the consent card grants exactly the body read here).
import type { TrustGrants } from '../../shared/ipc.ts'
import { displayArgv } from '../verify/argv.ts'
import { formatVerifyDuration } from '../verify/render.ts'
import type { CopyInResult } from './copyIns.ts'
import { decideDeps, planFromCommand } from './detectDeps.ts'
import type { DepsPlan, InstallSettings } from './detectDeps.ts'
import type { InstallResult } from './install.ts'
import { checkDepsTrust } from './trust.ts'

export type DepsSource = 'detected' | 'config' | 'edited'

/** The deps row's view of a plan (StepView.prepare.deps; depsConsent and depsFailed show it). */
export interface DepsCommandFacts {
  manager: string
  argv: string[]
  cwdRel: string
  lockfile?: string
  source: DepsSource
}

export function depsCommandView(plan: DepsPlan, source: DepsSource): DepsCommandFacts {
  return {
    manager: plan.manager,
    argv: [...plan.argv],
    cwdRel: plan.cwdRel,
    ...(plan.lockfile !== null ? { lockfile: plan.lockfile } : {}),
    source,
  }
}

export interface DepsStageResult {
  /** The install to run; null when there is none (`skip` says why) or the command cannot be read (`error`). */
  plan: DepsPlan | null
  source?: DepsSource
  view?: DepsCommandFacts
  /** UI copy: why the deps row is skipped (install off, nothing to install). */
  skip?: string
  /** UI copy: the configured or edited command cannot run as written (shell syntax). */
  error?: string
  /** How the plan stands against the SOURCE folder's grants (`invalid`: trust cannot cover what it runs). */
  trust?: 'trusted' | 'untrusted' | 'changed' | 'invalid'
  /** The body the `deps` grant must cover (read in the worktree now). */
  body?: string
  /** `changed`: the body the existing grant covers. */
  grantedBody?: string | null
  /** `invalid`: why (UI copy). */
  reason?: string
  /** Trusted only by an Easy run's project permission. */
  via?: 'project'
}

export interface DepsStageOptions {
  /** The run's folder inside the worktree, and the worktree's root (cwdRel and sources are relative to it). */
  worktreeFolder: string
  worktreeRoot: string
  /** The SOURCE folder's grants. */
  grants: () => Promise<TrustGrants>
  /** [Edit command]: the user's command line; replaces installCommand and detection. */
  edited?: string | null
  platform?: NodeJS.Platform
}

/** Step 3's decision (see the header). Never spawns anything. */
export async function decideDepsStage(
  settings: InstallSettings,
  opts: DepsStageOptions,
): Promise<DepsStageResult> {
  const where = {
    scopeRoot: opts.worktreeRoot,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  }
  let plan: DepsPlan
  let source: DepsSource
  if (settings.install === 'never') return { plan: null, skip: 'Install dependencies is off' }
  if (opts.edited !== undefined && opts.edited !== null && opts.edited.trim() !== '') {
    const r = await planFromCommand(opts.edited, opts.worktreeFolder, where)
    if (r.plan === null) return { plan: null, source: 'edited', error: r.error }
    plan = r.plan
    source = 'edited'
  } else {
    const d = await decideDeps(settings, opts.worktreeFolder, where)
    if (d.kind === 'never') return { plan: null, skip: 'Install dependencies is off' }
    if (d.kind === 'none') return { plan: null, skip: 'Nothing to install was found' }
    if (d.kind === 'invalid') return { plan: null, source: 'config', error: d.error }
    plan = d.plan
    source = settings.installCommand !== null ? 'config' : 'detected'
  }
  const view = depsCommandView(plan, source)
  const grants = await opts.grants().catch((): TrustGrants => ({}))
  const t = await checkDepsTrust(opts.worktreeRoot, plan, grants)
  if (t.trust === 'invalid') return { plan, source, view, trust: 'invalid', reason: t.error }
  return {
    plan,
    source,
    view,
    trust: t.trust,
    body: t.body,
    ...(t.trust === 'changed' ? { grantedBody: t.grantedBody ?? null } : {}),
    ...(t.trust === 'trusted' && t.via !== undefined ? { via: t.via } : {}),
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The copy row's one line: "Copied 2 files (.env, certs/dev.pem)", with what was left out. */
export function copyInsSummary(r: CopyInResult): string {
  const left = r.skipped.filter((s) => s.path !== '').length + r.refused.length
  const shown = r.copied.slice(0, 3).join(', ')
  const more = r.copied.length > 3 ? `, ${r.copied.length - 3} more` : ''
  const head =
    r.copied.length === 0
      ? 'Copied nothing'
      : `Copied ${plural(r.copied.length, 'file', 'files')} (${shown}${more})`
  const tail = left > 0 ? `; ${plural(left, 'path', 'paths')} left out` : ''
  return `${head}${tail}${r.truncated === true ? '; stopped at a limit' : ''}`
}

/** The deps row's one line after an install. */
export function installSummary(r: InstallResult): string {
  const line = displayArgv(r.argv)
  switch (r.status) {
    case 'pass':
      return `Installed with ${line} in ${formatVerifyDuration(r.durationMs)}${r.viaCorepack === true ? ' (through corepack)' : ''}`
    case 'fail':
      return r.timedOut === true ? `${line}: ${r.reason ?? 'timed out'}` : (r.reason ?? `${line} failed`)
    case 'env':
      return r.reason ?? `${line} could not run`
    case 'skipped-untrusted':
      return `${line} was not run: ${r.reason ?? 'not allowed yet'}`
    case 'skipped':
      return `${line} was not run: ${r.reason ?? 'skipped'}`
  }
}
