// What preflight `run.deps` reads about an isolated run's dependency install (deps detection; trust;
// deps_missing): the install decision (installCommand or detection, `install`
// policy), whether each program it needs resolves (corepack counts for a pnpm/yarn `packageManager`), and how the
// command stands against the folder's `deps` grants. Read in the user's folder: the worktree does not exist yet, and it
// starts from HEAD, so a lockfile with uncommitted changes may ask for consent again at run time.
import { resolve } from 'node:path'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import { resolvePathEnv, splitPathList } from '../proc/path-env.ts'
import { resolveCommand } from '../verify/resolve-cmd.ts'
import { decideDeps } from './detectDeps.ts'
import type { DepsDecision, DepsPlan } from './detectDeps.ts'
import { checkDepsTrust } from './trust.ts'
import type { DepsTrustRead } from './trust.ts'

export interface DepsToolFact {
  /** The program as the plan names it (`pnpm`, `py`, `./mvnw`). */
  name: string
  /** Where it runs from; null: not found (and corepack cannot stand in). */
  resolved: string | null
  /** Not on PATH, but corepack runs it (package.json#packageManager names it). */
  viaCorepack?: boolean
}

export interface DepsFacts {
  install: 'ask' | 'auto' | 'never'
  decision: DepsDecision
  /** `plan`: each program the install needs before it starts. */
  tools?: DepsToolFact[]
  /** `plan`: how it stands against the folder's `deps` grants (`invalid`: trust cannot cover what it runs). */
  trust?: DepsTrustRead
  /** For the install hints: whether corepack and npm are on PATH. */
  corepack?: boolean
  npm?: boolean
}

export interface DepsFactsOptions {
  /** The scope root (`cwdRel` is relative to it). Default: the folder. */
  scopeRoot?: string
  /** The folder's grants (trust.json). Default: none. */
  grants?: () => Promise<TrustGrants>
  pathEnv?: string
  platform?: NodeJS.Platform
}

/** Each program the plan needs, resolved like the install will resolve it (with the corepack fallback). */
export function resolveTools(
  plan: DepsPlan,
  root: string,
  pathEntries: readonly string[],
  platform: NodeJS.Platform,
): DepsToolFact[] {
  const cwd = resolve(root, plan.cwdRel)
  const opts = { cwd, root, pathEntries, platform }
  return plan.tools.map((name): DepsToolFact => {
    const hit = resolveCommand(name, opts)
    if (hit !== null) return { name, resolved: hit.path }
    if (plan.corepack === true && name === plan.manager) {
      const corepack = resolveCommand('corepack', opts)
      if (corepack !== null) return { name, resolved: corepack.path, viaCorepack: true }
    }
    return { name, resolved: null }
  })
}

/** The default `depsFacts` of preflight run.deps (see the header). */
export async function readDepsFacts(
  folder: string,
  config: Pick<ResolvedConfig, 'isolation'>,
  opts: DepsFactsOptions = {},
): Promise<DepsFacts> {
  const platform = opts.platform ?? process.platform
  const root = resolve(opts.scopeRoot ?? folder)
  const w = config.isolation.worktree
  const decision = await decideDeps({ install: w.install, installCommand: w.installCommand }, folder, {
    scopeRoot: root,
    platform,
  })
  if (decision.kind !== 'plan') return { install: w.install, decision }
  const entries = splitPathList(opts.pathEnv ?? (await resolvePathEnv({ platform })).path, platform)
  const tools = resolveTools(decision.plan, root, entries, platform)
  const grants = opts.grants !== undefined ? await opts.grants().catch((): TrustGrants => ({})) : {}
  const trust = await checkDepsTrust(root, decision.plan, grants)
  const where = { cwd: root, root, pathEntries: entries, platform }
  return {
    install: w.install,
    decision,
    tools,
    trust,
    corepack: resolveCommand('corepack', where) !== null,
    npm: resolveCommand('npm', where) !== null,
  }
}

/** The files whose digest differs between an old and a new body (`changed` trust: what to name). */
export function changedSources(oldBody: string | null | undefined, newBody: string): string[] {
  const files = (body: string): Map<string, string> => {
    const out = new Map<string, string>()
    for (const line of body.split('\n')) {
      const m =
        /^file (.+?) (sha256 [0-9a-f]+|missing|is a link|is not a file|unreadable|outside the project|\d+ bytes)$/.exec(
          line,
        )
      if (m !== null) out.set(m[1] ?? '', m[2] ?? '')
    }
    return out
  }
  const before = files(oldBody ?? '')
  const after = files(newBody)
  const out: string[] = []
  for (const [f, v] of after) if (before.get(f) !== v) out.push(f)
  for (const f of before.keys()) if (!after.has(f)) out.push(f)
  return out
}
