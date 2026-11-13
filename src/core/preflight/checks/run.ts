// Run-scope checks: run.profile, run.passes, run.templates, run.branch, run.verify and
// run.isolation.worktree, run.deps and run.isolation.verifyReady (the last one in prepare only: it reads the
// worktree). When the resolve itself failed (an unknown profile, a missing template, passes that do not fit
// together), the check that owns the failure reports it with the file and line that set the value. The rest of the
// run.* family (pricing, selfHeal) arrives later.
import { isBuiltinCheckArgv } from '../../../shared/pageload.ts'
import { BUILTIN_COMMAND_PATH } from '../../../shared/playtest.ts'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join as joinPath, resolve as resolvePath } from 'node:path'
import type { ResolvedConfig } from '../../../shared/config-schema.ts'
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import { checkRunPlan, guardrailWarnings, rulesInForce } from '../../../shared/guardrails.ts'
import { PASS_NAMES } from '../../../shared/run.ts'
import type { PassName } from '../../../shared/run.ts'
import type { VerifyTrustState } from '../../../shared/verify.ts'
import { runPlanFactsOf } from '../../auto-switch.ts'
import { BUILTIN_PROFILE_NAMES, enabledPasses } from '../../config/defaults.ts'
import { isValidBranchName, runBranchBaseName } from '../../git/branch.ts'
import type { ResolveIssue } from '../../config/resolve.ts'
import { repairCommand } from '../../heal/commands.ts'
import { changedSources, readDepsFacts } from '../../prepare/facts.ts'
import type { DepsFacts } from '../../prepare/facts.ts'
import { checkVerifyReady, verifyReadyResult, wantsVerifyReady } from '../../prepare/readiness.ts'
import { resolvePathEnv } from '../../proc/path-env.ts'
import { PromptResolveError, readTemplateFile } from '../../prompts/resolve.ts'
import { formatIssue, suggestName, validateTemplate } from '../../prompts/template.ts'
import { displayArgv } from '../../verify/argv.ts'
import { configCommands, detectPackageManager, discoverCommands, programName } from '../../verify/discover.ts'
import { resolveCommand } from '../../verify/resolve-cmd.ts'
import { trustOf } from '../../verify/trust.ts'
import type { CheckContext, PreflightCheckDef, PreflightConfigFiles, PreflightDeps } from '../engine.ts'
import { BRAND } from '../../../shared/brand.ts'

export const PASS_LABELS: Readonly<Record<PassName, string>> = {
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  fix: 'Fix',
}

/** At most this many template issues are listed in one result. */
const MAX_LISTED_ISSUES = 5

const hasConfig = (ctx: CheckContext): boolean => ctx.config !== undefined

type ResolveErrorCode = NonNullable<PreflightConfigFiles['error']>['code']

/** The resolve failed with `code` (no config): the check that owns that failure reports it. */
const resolveError = (ctx: CheckContext, code: ResolveErrorCode): PreflightConfigFiles['error'] =>
  ctx.config === undefined && ctx.input.configFiles?.error?.code === code
    ? ctx.input.configFiles.error
    : undefined

/** `C:\…\dimfactory.json:3` (where a layer set the value), or '' for the run layer and the defaults. */
function whereSet(i: ResolveIssue): string {
  if (i.file === undefined) return i.source === 'run' ? 'this run' : ''
  return i.line !== undefined ? `${i.file}:${i.line}` : i.file
}

/** One line per resolve issue: `<file>:<line> <message>` (or the message alone). */
function resolveIssueLines(issues: readonly ResolveIssue[]): string[] {
  return issues.map((i) => {
    const where = whereSet(i)
    return where !== '' ? `${where} ${i.message}` : i.message
  })
}

const researchSettings: RecoveryAction = {
  id: 'run.research.settings',
  label: 'Choose research lenses',
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/passes/plan/researchLenses',
}

const profileSettings: RecoveryAction = {
  id: 'run.profile.settings',
  label: 'Choose a profile',
  kind: 'settings_link',
  route: 'settings/profiles',
  pointer: '/profile',
}

const guardrailSettings: RecoveryAction = {
  id: 'run.guardrails.settings',
  label: 'Open Guardrails',
  kind: 'settings_link',
  route: 'settings/guardrails',
  pointer: '/guardrails',
}

export function runCheckDefs(): PreflightCheckDef[] {
  return [
    {
      id: 'run.profile',
      scope: 'run',
      title: 'Profile',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => hasConfig(ctx) || resolveError(ctx, 'unknown-profile') !== undefined,
      subjectKey: (ctx) => ctx.config?.profile ?? ctx.input.configFiles?.error?.message ?? '',
      run(ctx) {
        const known = ctx.input.profiles ?? BUILTIN_PROFILE_NAMES
        const err = resolveError(ctx, 'unknown-profile')
        if (err !== undefined) {
          const where = err.issues.map(whereSet).find((w) => w !== '')
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: err.issues[0]?.message ?? 'Unknown profile',
              detail: `${err.message}${where !== undefined ? `\nSelected in ${where}.` : ''}`,
              category: 'config_invalid',
              recovery: [profileSettings],
            }),
          )
        }
        const name = ctx.config?.profile ?? ''
        if (known.includes(name)) return Promise.resolve(ctx.result({ status: 'pass', detail: name }))
        const hint = suggestName(name, known)
        return Promise.resolve(
          ctx.result({
            status: 'fail',
            title: `Unknown profile "${name}"`,
            detail: `${hint !== undefined ? `Did you mean "${hint}"? ` : ''}Profiles: ${known.join(', ')}.`,
            category: 'config_invalid',
            recovery: [profileSettings],
          }),
        )
      },
    },
    {
      id: 'run.passes',
      scope: 'run',
      title: 'Passes',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => hasConfig(ctx) || resolveError(ctx, 'invalid') !== undefined,
      subjectKey: (ctx) =>
        ctx.config ? enabledPasses(ctx.config).join(',') : (ctx.input.configFiles?.error?.message ?? ''),
      run(ctx) {
        const err = resolveError(ctx, 'invalid')
        if (err !== undefined) {
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: 'The pass settings do not fit together',
              detail: resolveIssueLines(err.issues).join('\n') || err.message,
              category: 'config_invalid',
              recovery: [
                {
                  id: 'run.passes.settings',
                  label: 'Choose passes',
                  kind: 'settings_link',
                  route: 'settings/passes',
                  pointer: err.issues[0]?.pointer ?? '/passes',
                },
              ],
            }),
          )
        }
        const cfg = ctx.config
        const on = cfg ? enabledPasses(cfg) : []
        if (on.length === 0) {
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: 'No pass is enabled',
              detail: 'Enable at least one of Plan, Implement, Review, Critic or Fix.',
              category: 'config_invalid',
              recovery: [
                {
                  id: 'run.passes.settings',
                  label: 'Choose passes',
                  kind: 'settings_link',
                  route: 'settings/passes',
                  pointer: '/passes',
                },
              ],
            }),
          )
        }
        const sequence = on.map((p) => PASS_LABELS[p]).join(' → ')
        if (cfg !== undefined && !cfg.passes.implement.enabled && cfg.passes.fix.enabled) {
          return Promise.resolve(
            ctx.result({
              status: 'pass',
              title: sequence,
              detail: 'Implement is off, so Fix will be skipped.',
            }),
          )
        }
        return Promise.resolve(
          ctx.result({ status: 'pass', title: sequence, detail: `${on.length} passes enabled.` }),
        )
      },
    },
    {
      id: 'run.templates',
      scope: 'run',
      title: 'Prompt templates',
      dependsOn: [],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => hasConfig(ctx) || resolveError(ctx, 'template') !== undefined,
      subjectKey: (ctx) =>
        ctx.config
          ? enabledPasses(ctx.config)
              .map((p) => `${p}=${ctx.config?.passes[p].promptTemplate.path ?? ''}`)
              .join('|')
          : (ctx.input.configFiles?.error?.message ?? ''),
      run(ctx) {
        const err = resolveError(ctx, 'template')
        if (err !== undefined) {
          const issue = err.issues[0]
          const pass = PASS_NAMES.find((p) => issue?.pointer === `/passes/${p}/promptTemplate`)
          return Promise.resolve(
            ctx.result({
              ...(pass !== undefined ? { id: `run.templates.${pass}` } : {}),
              status: 'fail',
              title:
                pass !== undefined
                  ? `${PASS_LABELS[pass]} prompt template is missing`
                  : 'A prompt template is missing',
              detail: resolveIssueLines(err.issues).join('\n') || err.message,
              category: 'config_invalid',
              recovery: [
                {
                  id: `${pass !== undefined ? `run.templates.${pass}` : 'run.templates'}.settings`,
                  label: pass !== undefined ? `Edit the ${PASS_LABELS[pass]} prompt` : 'Edit the prompts',
                  kind: 'settings_link',
                  route: 'settings/prompts',
                  pointer: issue?.pointer ?? '/passes',
                },
              ],
            }),
          )
        }
        return Promise.resolve(templateResults(ctx))
      },
    },
    {
      // The run branch's name must pass `git check-ref-format --branch`. Applies only
      // with `isolation.branch: runBranch`, so it never blocks a run without one.
      id: 'run.branch',
      scope: 'run',
      title: 'Run branch',
      dependsOn: ['app.git'],
      cost: 'spawn',
      ttlMs: 10 * 60_000,
      authoritativeTtlMs: 0,
      timeoutMs: { live: 2000 },
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => ctx.config?.isolation.branch === 'runBranch',
      subjectKey: (ctx) => ctx.config?.isolation.branchPrefix ?? '',
      async run(ctx) {
        const prefix = ctx.config?.isolation.branchPrefix ?? ''
        const sample = runBranchBaseName(prefix, new Date(ctx.now()), 'task')
        const valid = ctx.deps.branchNameValid ?? isValidBranchName
        if (!(await valid(ctx.folder ?? homedir(), sample))) {
          return ctx.result({
            status: 'fail',
            title: 'The run branch prefix is not valid',
            detail: `git does not accept "${sample}" as a branch name. Change the branch prefix ("${prefix}") in Settings.`,
            category: 'config_invalid',
            recovery: [
              {
                id: 'run.branch.settings',
                label: 'Change the branch prefix',
                kind: 'settings_link',
                route: 'settings/isolation',
                pointer: '/isolation/branchPrefix',
              },
            ],
          })
        }
        return ctx.result({
          status: 'pass',
          detail: `The run works on a new branch named like ${sample.replace(/-task$/, '-<task>')}.`,
        })
      },
    },
    {
      // The rules that hold before anything starts, and any rule that cannot reach the strength it requires.
      id: 'run.guardrails',
      scope: 'run',
      title: 'Guardrails',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => hasConfig(ctx),
      subjectKey: (ctx) =>
        JSON.stringify([
          ctx.config?.guardrails,
          ctx.config?.auto,
          ctx.config?.isolation.mode,
          ctx.config?.passes,
        ]),
      run(ctx) {
        const cfg = ctx.config as ResolvedConfig
        const rules = rulesInForce(cfg.guardrails)
        const facts = runPlanFactsOf(cfg)
        const blocks = checkRunPlan(rules, facts)
        if (blocks.length > 0) {
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title:
                blocks.length === 1
                  ? `A guardrail stops this run: ${blocks[0]?.rule ?? ''}`
                  : `${blocks.length} guardrails stop this run`,
              detail: blocks.map((b) => `${b.rule}. ${b.detail}`).join('\n'),
              category: 'config_invalid',
              recovery: [guardrailSettings],
            }),
          )
        }
        // A rule an AI tool in this run cannot keep: the run may start, but nobody should trust the rule there.
        const cannot = guardrailWarnings(rules, facts)
        if (cannot.length > 0) {
          return Promise.resolve(
            ctx.result({
              status: 'warn',
              title:
                cannot.length === 1
                  ? `A guardrail cannot be kept in this run: ${cannot[0]?.rule ?? ''}`
                  : `${cannot.length} guardrails cannot be kept in this run`,
              detail: cannot.map((b) => `${b.rule}. ${b.detail}`).join('\n'),
              recovery: [guardrailSettings],
            }),
          )
        }
        return Promise.resolve(
          ctx.result({
            status: 'pass',
            detail: `${rules.length} rule${rules.length === 1 ? '' : 's'} in force, plus settings files.`,
          }),
        )
      },
    },
    {
      // Every enabled verify command can run as written, its argv[0] resolves and a `commands`
      // grant covers its body (else a warning: the trust card asks at run time, and Auto skips it). Verify on with no
      // command blocks, naming the detected commands; they are added in Settings → Isolation & Verify (the
      // config_patch allowlist never writes verify commands).
      id: 'run.verify',
      scope: 'run',
      title: 'Verify commands',
      dependsOn: [],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) =>
        ctx.folder !== undefined &&
        ctx.config?.verify.enabled === true &&
        (ctx.config.verify.runAfter.length > 0 || ctx.input.testFirst === true),
      subjectKey: (ctx) => `${ctx.folder ?? ''}|${JSON.stringify(ctx.config?.verify.commands ?? [])}`,
      async run(ctx) {
        const cfg = ctx.config
        const folder = ctx.folder
        if (cfg === undefined || folder === undefined) return []
        const read = ctx.deps.verifyFacts ?? ((f, c) => readVerifyFacts(f, c, ctx.deps, ctx.platform))
        return verifyResults(ctx, await read(folder, cfg), cfg.auto)
      },
    },
    {
      // Test-first (the Brief's approach) needs Verify: the red check shows the new tests failing before Implement,
      // and verify after Implement shows them passing. Verify off, or on without commands, blocks the run; the fix
      // opens Settings > Isolation & Verify with the commands this project suggests (a recovery patch never turns
      // Verify on or writes commands).
      id: 'run.testFirst',
      scope: 'run',
      title: 'Test-first',
      dependsOn: [],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) =>
        ctx.folder !== undefined && ctx.config !== undefined && ctx.input.testFirst === true,
      subjectKey: (ctx) =>
        `${ctx.folder ?? ''}|${String(ctx.config?.verify.enabled)}|${JSON.stringify(ctx.config?.verify.commands ?? [])}`,
      async run(ctx) {
        const cfg = ctx.config
        const folder = ctx.folder
        if (cfg === undefined || folder === undefined) return []
        const read = ctx.deps.verifyFacts ?? ((f, c) => readVerifyFacts(f, c, ctx.deps, ctx.platform))
        const facts = await read(folder, cfg)
        const fix = verifySettings('run.testFirst.settings', 'Turn on Verify and choose commands', ctx.folder)
        const found = facts.detected.map((d) => `${d.name} (${d.command})`)
        const suggest =
          found.length > 0
            ? ` This project suggests: ${found.join(', ')}.`
            : ' Dim Factory found no checks to suggest here; add the command that runs your tests.'
        if (!cfg.verify.enabled) {
          return ctx.result({
            status: 'fail',
            title: 'Test-first needs Verify',
            detail: `Test-first runs your checks to see the new tests fail before Implement and pass after it, so Verify must be on with at least one command.${facts.commands.length === 0 ? suggest : ''} Turn Verify on in Settings, or take Test-first out of the Brief.`,
            category: 'config_invalid',
            recovery: [fix],
          })
        }
        if (facts.commands.length === 0) {
          return ctx.result({
            status: 'fail',
            title: 'Test-first needs a verify command',
            detail: `Verify is on but has no commands to run the new tests.${suggest} Add one in Settings, or take Test-first out of the Brief.`,
            category: 'config_invalid',
            recovery: [fix],
          })
        }
        return ctx.result({
          status: 'pass',
          detail: `The new tests are checked with ${facts.commands.map((c) => c.name).join(', ')}.`,
        })
      },
    },
    {
      // Research before Plan: lens ids that are neither generic nor the run's pack's block the run (the composer or the
      // config names one that does not exist); a Research vendor without web search warns that the run reads this
      // repository only (the web lenses are left out, never silently researched another way).
      id: 'run.research',
      scope: 'run',
      title: 'Research',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) =>
        ctx.config?.passes.plan.research === true &&
        ctx.config.passes.plan.enabled &&
        ctx.input.research !== undefined,
      subjectKey: (ctx) => JSON.stringify(ctx.input.research ?? null),
      run(ctx) {
        const r = ctx.input.research
        if (r === undefined) return Promise.resolve([])
        if (r.unknown.length > 0) {
          return Promise.resolve(
            ctx.result({
              status: 'fail',
              title: r.unknown.length === 1 ? 'Unknown research lens' : 'Unknown research lenses',
              detail: `No lens is called ${r.unknown.map((id) => `"${id}"`).join(', ')}. Pick lenses in the composer, or fix passes.plan.researchLenses in Settings.`,
              category: 'config_invalid',
              recovery: [researchSettings],
            }),
          )
        }
        if (r.web === false) {
          return Promise.resolve(
            ctx.result({
              status: 'warn',
              title: `${r.vendor} cannot search the web`,
              detail: `Research runs on the Plan pass's vendor, and ${r.vendor} has no web search in Dim Factory, so Research reads this repository only${r.offWeb.length > 0 ? ` (left out: ${r.offWeb.join(', ')})` : ''}. Choose Claude or Codex for Plan to research the web.`,
              category: 'capability_missing',
            }),
          )
        }
        return Promise.resolve(
          ctx.result({
            status: 'pass',
            detail: r.web === true ? 'Research may search the web.' : 'Research is on.',
          }),
        )
      },
    },
    {
      // The acceptance review: never blocking. It runs on Review's settings (Critic's, then Plan's, when Review is off):
      // all three off is a warning (it will not run). Without Fix until green its unmet criteria are a summary only, so
      // the check says so; with it, they become [must] findings for Fix.
      id: 'run.acceptance',
      scope: 'run',
      title: 'Acceptance review',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => ctx.config?.passes.review.acceptance === true,
      subjectKey: (ctx) => {
        const p = ctx.config?.passes
        return `${String(p?.review.enabled)}|${String(p?.critic.enabled)}|${String(p?.plan.enabled)}|${String(p?.fix.rounds)}`
      },
      run(ctx) {
        const p = ctx.config?.passes
        if (p === undefined) return Promise.resolve([])
        if (!p.review.enabled && !p.critic.enabled && !p.plan.enabled) {
          return Promise.resolve(
            ctx.result({
              status: 'warn',
              title: 'The acceptance review will not run',
              detail:
                "It runs on the Review pass's settings, or Critic's, then Plan's, and all three are off. Turn one of them on, or turn the acceptance review off.",
              category: 'config_invalid',
            }),
          )
        }
        return Promise.resolve(
          ctx.result({
            status: 'pass',
            detail:
              p.fix.rounds > 1
                ? 'Each acceptance criterion the review finds not met becomes a [must] finding for Fix until green.'
                : 'Fix until green is off, so unmet acceptance criteria are reported as a summary only; they do not become findings.',
          }),
        )
      },
    },
    {
      // Eligibility: a repository with a commit, room for the worktree
      // (1.2 × the HEAD tree + 500 MB) and, on win32, a path git can write. Repository problems are folder.git's (this
      // check waits for it); the long-path case is a warning with the copyable `core.longpaths` command.
      id: 'run.isolation.worktree',
      scope: 'run',
      title: 'Isolated run',
      dependsOn: ['app.git', 'folder.exists', 'folder.git'],
      cost: 'spawn',
      ttlMs: 30_000,
      authoritativeTtlMs: 0,
      timeoutMs: { live: 2000 },
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) =>
        ctx.folder !== undefined &&
        isRunOwner(ctx) &&
        ctx.config?.isolation.mode === 'worktree' &&
        // A copy written from a snapshot is no git worktree: room for it is checked when it is made.
        ctx.input.snapshotCopy !== true &&
        ctx.deps.worktreeEligibility !== undefined,
      subjectKey: (ctx) => ctx.folder ?? '',
      async run(ctx) {
        const folder = ctx.folder
        const check = ctx.deps.worktreeEligibility
        if (folder === undefined || check === undefined) return []
        const e = await check(folder, {
          ...(ctx.mode === 'live' ? { timeoutMs: 2000 } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        return worktreeResults(ctx, e)
      },
    },
    {
      // run.deps: the install's program resolves (corepack counts for a
      // pnpm/yarn packageManager), and a `deps` grant covers it, or install `ask` (the depsConsent card asks at run
      // time); otherwise blocking deps_missing. installCommand replaces detection and needs its own grant.
      id: 'run.deps',
      scope: 'run',
      title: 'Dependencies',
      dependsOn: [],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) =>
        ctx.folder !== undefined && isRunOwner(ctx) && ctx.config?.isolation.mode === 'worktree',
      subjectKey: (ctx) => {
        const w = ctx.config?.isolation.worktree
        return `${ctx.folder ?? ''}|${w?.install ?? ''}|${JSON.stringify(w?.installCommand ?? null)}`
      },
      async run(ctx) {
        const cfg = ctx.config
        const folder = ctx.folder
        if (cfg === undefined || folder === undefined) return []
        const read =
          ctx.deps.depsFacts ??
          (async (f: string, c: ResolvedConfig): Promise<DepsFacts> => {
            const scopeRoot = ctx.deps.scopeRoot !== undefined ? await ctx.deps.scopeRoot(f) : f
            const grants = ctx.deps.trustGrants
            return readDepsFacts(f, c, {
              scopeRoot,
              platform: ctx.platform,
              ...(grants !== undefined ? { grants: () => grants(f) } : {}),
            })
          })
        return depsResults(ctx, await read(folder, cfg), cfg.auto)
      },
    },
    {
      // run.isolation.verifyReady (Prepare step 5): evaluated in prepare against the worktree (owner
      // `worktree`), after deps; never in the live preflight (the worktree does not exist yet). Every enabled verify
      // command's program must resolve there, else verifyEnv opens before Implement.
      id: 'run.isolation.verifyReady',
      scope: 'run',
      title: 'Verify can run in the run’s copy',
      dependsOn: [],
      cost: 'io',
      ttlMs: 0,
      modes: ['authoritative'],
      appliesTo: (ctx) =>
        ctx.folder !== undefined &&
        ctx.input.owner === 'worktree' &&
        ctx.config !== undefined &&
        wantsVerifyReady(ctx.config),
      subjectKey: (ctx) => ctx.folder ?? '',
      async run(ctx) {
        const cfg = ctx.config
        const folder = ctx.folder
        if (cfg === undefined || folder === undefined) return []
        const read =
          ctx.deps.verifyReady ??
          (async (f: string, c: ResolvedConfig) => {
            const root = ctx.deps.scopeRoot !== undefined ? await ctx.deps.scopeRoot(f) : f
            return checkVerifyReady(c, { worktreeFolder: f, worktreeRoot: root, platform: ctx.platform })
          })
        const r = verifyReadyResult(await read(folder, cfg), ctx.now())
        return ctx.result({
          status: r.status,
          title: r.title,
          detail: r.detail,
          blocking: r.blocking,
          recovery: r.recovery,
          ...(r.category !== undefined ? { category: r.category } : {}),
        })
      },
    },
    {
      // The project's quality gates: every required check can run in this run (else the run cannot pass them and will
      // complete with failures). A warning, never blocking: the run still runs.
      id: 'run.quality',
      scope: 'run',
      title: 'Quality gates',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => ctx.config?.quality.enabled === true,
      subjectKey: (ctx) => JSON.stringify(ctx.config?.quality ?? null),
      run(ctx) {
        return Promise.resolve(ctx.result(qualityResult(ctx.config)))
      },
    },
    {
      // Project memory: the file every pass gets, and whether it is longer than its cap.
      id: 'run.memory',
      scope: 'run',
      title: 'Project memory',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => ctx.config?.memory.enabled === true && ctx.folder !== undefined,
      subjectKey: (ctx) => `${ctx.folder ?? ''}|${ctx.config?.memory.maxBytes ?? 0}`,
      async run(ctx) {
        const folder = ctx.folder ?? ''
        const max = ctx.config?.memory.maxBytes ?? 0
        const root = (await ctx.deps.memoryRoot?.(folder).catch(() => undefined)) ?? folder
        const file = joinPath(root, BRAND.memoryFileName)
        const st = await stat(file).catch(() => null)
        if (st === null || !st.isFile())
          return ctx.result({
            status: 'pass',
            detail: `No ${BRAND.memoryFileName} yet. After the run, an update to start it is proposed for you to approve.`,
          })
        const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`
        if (st.size > max)
          return ctx.result({
            status: 'warn',
            title: `${BRAND.memoryFileName} is longer than its cap`,
            detail: `It is ${kb(st.size)}; each pass gets its first ${kb(max)}. Shorten it, or raise memory.maxBytes.`,
            recovery: [
              {
                id: 'run.memory.settings',
                label: 'Change the cap',
                kind: 'settings_link',
                route: 'settings/factory',
                pointer: '/memory/maxBytes',
              },
            ],
          })
        return ctx.result({
          status: 'pass',
          detail: `${BRAND.memoryFileName} (${kb(st.size)}) goes to every pass.`,
        })
      },
    },
  ]
}

const qualitySettings: RecoveryAction = {
  id: 'run.quality.settings',
  label: 'Review the quality gates',
  kind: 'settings_link',
  route: 'settings/factory',
  pointer: '/quality',
}

/** run.quality: the required checks this run cannot pass as configured (a warning), else what it must pass. */
export function qualityResult(cfg: ResolvedConfig | undefined): Parameters<CheckContext['result']>[0] {
  const q = cfg?.quality
  if (cfg === undefined || q === undefined || !q.enabled)
    return { status: 'pass', detail: 'No quality gates.' }
  const problems: string[] = []
  const names = cfg.verify.commands.filter((c) => c.enabled !== false).map((c) => c.name)
  for (const name of q.verify) {
    if (!cfg.verify.enabled) problems.push(`"${name}" is required, but Verify is off.`)
    else if (!names.includes(name))
      problems.push(`"${name}" is required, but no enabled verify command has that name.`)
  }
  if (q.security && !cfg.passes.security.enabled)
    problems.push('The security review is required, but it is off for this run.')
  if (q.acceptance && !cfg.passes.review.acceptance)
    problems.push('The acceptance review is required, but it is off for this run.')
  const required = [...q.verify, ...(q.security ? ['security'] : []), ...(q.acceptance ? ['acceptance'] : [])]
  if (problems.length > 0)
    return {
      status: 'warn',
      title: 'The run cannot pass its quality gates as set up',
      detail: `${problems.join(' ')} The run completes with failures unless every required check passes.`,
      recovery: [qualitySettings],
    }
  return {
    status: 'pass',
    detail:
      required.length > 0
        ? `To count as done the run must pass: ${required.join(', ')}.`
        : 'Quality gates are on, but none is required.',
  }
}

/** The run's own folder (a worktree's prepare preflight has owner `worktree`). */
const isRunOwner = (ctx: CheckContext): boolean => (ctx.input.owner ?? 'run') === 'run'

// ---- run.isolation.worktree ------------------------------------------------------------------------------------

/** A command the user copies (heal/commands.ts ShellCommand); never run by Dim Factory. */
interface CopyableCommand {
  command: string
  shell: 'powershell' | 'sh'
  elevated?: boolean
}

/**
 * git/worktree.ts checkEligibility's answer (its WorktreeEligibility), as run.isolation.worktree reads it: `reasons`
 * one line per blocker; `blockers` with the copyable commands that fix them; the win32 long-path warning.
 */
export interface WorktreeEligibilityResult {
  ok: boolean
  reasons: readonly string[]
  blockers?: readonly { title: string; detail: string; commands?: readonly CopyableCommand[] }[]
  longPathWarning?: { title?: string; detail: string; command?: CopyableCommand }
  /**
   * The folder's uncommitted changes an isolated run leaves out (git/worktree.ts uncommittedCount; the worktree
   * starts from HEAD). The pass result states it ("3 uncommitted changes not included"), which the composer shows.
   */
  uncommitted?: number
}

/** "3 uncommitted changes not included: …" (the composer reads the count from this text). */
export function uncommittedNote(n: number): string {
  return n === 0
    ? 'The folder has 0 uncommitted changes, so the run starts from all of your work.'
    : `${n} uncommitted ${n === 1 ? 'change' : 'changes'} not included: the run starts from your last commit.`
}

const runInPlace: RecoveryAction = {
  id: 'run.isolation.worktree.inPlace',
  label: 'Run in place instead',
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/isolation/mode',
}

const copyAction = (id: string, label: string, c: CopyableCommand, reason: string): RecoveryAction => ({
  id,
  label,
  kind: 'shell_copy',
  command: c.command,
  shell: c.shell,
  reason,
  recheck: 'run.isolation.worktree',
  ...(c.elevated === true ? { elevated: true } : {}),
})

function worktreeResults(ctx: CheckContext, e: WorktreeEligibilityResult): CheckResult[] {
  if (!e.ok) {
    const reasons = e.reasons.filter((r) => r.trim() !== '')
    const fixes = (e.blockers ?? [])
      .flatMap((b) => (b.commands ?? []).map((c) => ({ c, why: b.title })))
      .map(({ c, why }, i) => copyAction(`run.isolation.worktree.fix.${i}`, `Copy ${c.command}`, c, why))
    return [
      ctx.result({
        status: 'fail',
        title: 'This folder cannot run isolated',
        detail:
          reasons.length > 0
            ? reasons.join('\n')
            : 'Dim Factory cannot make a worktree for it. Run in place instead.',
        category: 'worktree_failed',
        recovery: [...fixes, runInPlace],
      }),
    ]
  }
  const out: CheckResult[] = []
  const long = e.longPathWarning
  if (long !== undefined) {
    const fix = long.command ?? repairCommand('longPaths', ctx.os)
    out.push(
      ctx.result({
        id: 'run.isolation.worktree.longPaths',
        status: 'warn',
        title: long.title ?? 'Some paths in the worktree may be too long for Windows',
        detail: long.detail,
        category: 'worktree_failed',
        recovery:
          fix === null
            ? []
            : [
                copyAction(
                  'run.isolation.worktree.longPaths.copy',
                  'Copy the core.longpaths command',
                  fix,
                  'Let git write paths over 260 characters.',
                ),
              ],
      }),
    )
  }
  const base = 'The run works in its own copy of the repository (a git worktree) until you apply it.'
  out.push(
    ctx.result({
      status: 'pass',
      detail: e.uncommitted !== undefined ? `${base} ${uncommittedNote(e.uncommitted)}` : base,
    }),
  )
  return out
}

// ---- run.deps --------------------------------------------------------------------------------------------------

const installCommandLink: RecoveryAction = {
  id: 'run.deps.installCommand',
  label: 'Set the install command',
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/isolation/worktree/installCommand',
}

const installPatch = (value: 'ask' | 'never'): RecoveryAction => ({
  id: `run.deps.install-${value}`,
  label: value === 'never' ? 'Skip dependency install' : 'Ask me before installing',
  kind: 'config_patch',
  target: 'runOverrides',
  ops: [{ op: 'replace', path: '/isolation/worktree/install', value }],
  preview: `isolation.worktree.install: ${value} (this run only)`,
})

/** A command that installs the missing program, when Dim Factory knows one (clipboard only; never run). */
function installHint(tool: string, facts: DepsFacts, os: CheckContext['os']): string | null {
  const prog = programName(tool)
  if (prog === 'pnpm' || prog === 'yarn') {
    return facts.corepack === true ? 'corepack enable' : facts.npm === true ? `npm install -g ${prog}` : null
  }
  if (prog === 'bun') return facts.npm === true ? 'npm install -g bun' : null
  if (prog === 'uv' || prog === 'poetry' || prog === 'pipenv') {
    return os === 'win32' ? `py -3 -m pip install --user ${prog}` : `python3 -m pip install --user ${prog}`
  }
  return null
}

/** run.deps's results (see the def). */
function depsResults(ctx: CheckContext, facts: DepsFacts, auto: boolean): CheckResult[] {
  const d = facts.decision
  switch (d.kind) {
    case 'never':
      return [
        ctx.result({
          status: 'pass',
          title: 'Dependencies are not installed',
          detail:
            'Install dependencies is off, so the run’s copy has only what git and the copy-ins put there.',
        }),
      ]
    case 'none':
      return [
        ctx.result({
          status: 'pass',
          title: 'No dependencies to install',
          detail: 'Dim Factory found no lockfile or project file it installs from.',
        }),
      ]
    case 'invalid':
      return [
        ctx.result({
          status: 'fail',
          title: 'The install command cannot run as written',
          detail: `${d.error}.`,
          category: 'config_invalid',
          recovery: [installCommandLink, installPatch('never')],
        }),
      ]
    case 'plan':
      break
  }
  const plan = d.plan
  const line = displayArgv(plan.argv)
  const where = plan.cwdRel !== '.' ? ` (in ${plan.cwdRel})` : ''
  const trust = facts.trust
  if (trust?.trust === 'invalid') {
    return [
      ctx.result({
        status: 'fail',
        title: 'The install command cannot be trusted',
        detail: `${trust.error}.`,
        category: 'config_invalid',
        recovery: [installCommandLink, installPatch('never')],
      }),
    ]
  }
  const missing = (facts.tools ?? []).filter((t) => t.resolved === null)
  if (missing.length > 0) {
    const tool = missing[0]?.name ?? plan.argv[0] ?? plan.manager
    const hint = installHint(tool, facts, ctx.os)
    const corepackNote =
      plan.corepack === true
        ? ' corepack would run it (package.json names it), but corepack was not found either.'
        : ''
    return [
      ctx.result({
        status: 'fail',
        title: `Installing dependencies needs ${tool}`,
        detail:
          `\`${line}\`${where} needs ${tool}, and Dim Factory did not find it on PATH.${corepackNote} ` +
          'Install it, set another install command, or skip the install.',
        category: 'deps_missing',
        recovery: [
          ...(hint !== null
            ? [
                {
                  id: 'run.deps.tool',
                  label: `Copy ${hint}`,
                  kind: 'shell_copy' as const,
                  command: hint,
                  shell: ctx.os === 'win32' ? ('powershell' as const) : ('sh' as const),
                  reason: `Installing dependencies needs ${tool}.`,
                  recheck: 'run.deps',
                },
              ]
            : []),
          installCommandLink,
          installPatch('never'),
        ],
      }),
    ]
  }
  const corepack = (facts.tools ?? []).some((t) => t.viaCorepack === true) ? ' through corepack' : ''
  if (trust === undefined || trust.trust === 'trusted') {
    return [
      ctx.result({
        status: 'pass',
        title: `Installs with ${line}`,
        detail: `The run’s copy gets its dependencies with \`${line}\`${where}${corepack}; you allowed it for these files.`,
      }),
    ]
  }
  const changed = trust.trust === 'changed' ? changedSources(trust.grantedBody, trust.body) : []
  const changedText =
    trust.trust === 'changed'
      ? `${changed.length > 0 ? changed.join(', ') : 'Its files'} changed since you allowed the install, so Dim Factory asks again. `
      : ''
  if (facts.install === 'auto') {
    return [
      ctx.result({
        status: 'fail',
        title: 'Installing dependencies needs your approval',
        detail:
          `${changedText}Install dependencies is set to auto, but you have not allowed \`${line}\`${where} for ` +
          'these files, and Dim Factory never trusts a command on its own. Let the run ask you, or skip the install.',
        category: 'deps_missing',
        recovery: [installPatch('ask'), installPatch('never'), installCommandLink],
      }),
    ]
  }
  return [
    ctx.result({
      status: auto ? 'warn' : 'pass',
      title:
        trust.trust === 'changed'
          ? 'The install’s files changed since you allowed it'
          : 'Dim Factory asks before installing dependencies',
      detail: auto
        ? `${changedText}Auto never trusts a command on its own, so the run skips \`${line}\`${where} and goes on ` +
          'without dependencies. Run once without Auto and choose Install to allow it.'
        : `${changedText}Before it runs \`${line}\`${where} in the run’s copy, the run asks you to allow it.`,
    }),
  ]
}

// ---- run.verify ------------------------------------------------------------------------------------------------

/** One enabled configured verify command as run.verify sees it. */
export interface VerifyCommandFact {
  name: string
  argv: string[]
  /** Relative to the scope root, `/` separators. */
  cwdRel: string
  body: string | null
  /** It cannot run as written (shell syntax, a cwd outside the project): why. */
  error?: string
  trust: VerifyTrustState
  /** Where argv[0] runs from; null when it was not found (or `error`). */
  resolved: string | null
  /** A command that installs what is missing (e.g. `pnpm install`), when Dim Factory can tell. */
  installHint?: string
}

export interface VerifyFacts {
  /** The enabled `verify.commands[]`, in order. */
  commands: VerifyCommandFact[]
  /** When there is none: what the project's files suggest (name and command line). */
  detected: { name: string; command: string }[]
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** The default `verifyFacts`: config commands, bodies read now, trust.json grants, argv[0] resolved. */
export async function readVerifyFacts(
  folder: string,
  config: ResolvedConfig,
  deps: Pick<PreflightDeps, 'trustGrants' | 'scopeRoot'>,
  platform: NodeJS.Platform = process.platform,
): Promise<VerifyFacts> {
  const root = deps.scopeRoot !== undefined ? await deps.scopeRoot(folder) : folder
  const configured = (await configCommands(config.verify.commands, { folder, scopeRoot: root })).filter(
    (c) => c.enabledByDefault,
  )
  if (configured.length === 0) {
    const found = await discoverCommands(folder, { scopeRoot: root }).catch(() => [])
    return {
      commands: [],
      detected: found
        .filter((c) => c.enabledByDefault)
        .map((c) => ({ name: c.name, command: displayArgv(c.run) })),
    }
  }
  const grants = deps.trustGrants !== undefined ? await deps.trustGrants(folder) : {}
  let entries: string[] | undefined
  const commands: VerifyCommandFact[] = []
  for (const c of configured) {
    const base = { name: c.name, argv: [...c.run], cwdRel: c.cwdRel, body: c.body }
    if (c.error !== undefined) {
      commands.push({ ...base, error: c.error, trust: 'invalid', resolved: null })
      continue
    }
    // Dim Factory's own checks are no program: they run inside Dim Factory and need no grant.
    if (isBuiltinCheckArgv(c.run)) {
      commands.push({ ...base, trust: 'trusted', resolved: BUILTIN_COMMAND_PATH })
      continue
    }
    entries ??= (await resolvePathEnv({ platform })).entries
    const cwd = resolvePath(root, c.cwdRel)
    const argv0 = c.run[0] ?? ''
    const hit = resolveCommand(argv0, { cwd, root, pathEntries: entries, platform })
    const fact: VerifyCommandFact = {
      ...base,
      trust: trustOf(c, c.body, grants).trust,
      resolved: hit?.path ?? null,
    }
    if (hit === null) {
      const prog = programName(argv0)
      if (prog === 'pnpm' || prog === 'yarn') fact.installHint = 'corepack enable'
      else if (!PACKAGE_MANAGERS.has(prog) && (await isFile(joinPath(cwd, 'package.json')))) {
        // A project-local tool (node_modules/.bin) that is not installed yet.
        fact.installHint = `${await detectPackageManager(cwd, root)} install`
      }
    }
    commands.push(fact)
  }
  return { commands, detected: [] }
}

/**
 * Settings → Isolation & Verify's command list. With the run's folder (`suggested`, so the link opens
 * that project's commands, which Settings lists only for a chosen project).
 */
const verifySettings = (id: string, label: string, folder: string | undefined): RecoveryAction => ({
  id,
  label,
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/verify/commands',
  ...(folder !== undefined ? { suggested: { scope: 'project', folder } } : {}),
})

/** run.verify's results: blockers first (cannot run, not found), then the trust warnings; one pass when all is well. */
function verifyResults(ctx: CheckContext, facts: VerifyFacts, auto: boolean): CheckResult[] {
  if (facts.commands.length === 0) {
    const found = facts.detected.map((d) => `${d.name} (${d.command})`)
    return [
      ctx.result({
        status: 'fail',
        title: 'Verify is on but has no commands',
        detail:
          found.length > 0
            ? `This project suggests: ${found.join(', ')}. Add the ones to run in Settings, or turn Verify off.`
            : 'Dim Factory found no checks to suggest here. Add a command in Settings, or turn Verify off.',
        category: 'config_invalid',
        recovery: [verifySettings('run.verify.settings', 'Choose verify commands', ctx.folder)],
      }),
    ]
  }
  const out: CheckResult[] = []
  for (const c of facts.commands) {
    const id = `run.verify.${c.name}`
    const line = c.argv.length > 0 ? displayArgv(c.argv) : c.name
    if (c.error !== undefined) {
      out.push(
        ctx.result({
          id,
          status: 'fail',
          title: `The ${c.name} check cannot run as written`,
          detail: `${c.error}.`,
          category: 'config_invalid',
          recovery: [verifySettings(`${id}.settings`, 'Edit the verify commands', ctx.folder)],
        }),
      )
      continue
    }
    if (c.resolved === null) {
      const prog = c.argv[0] ?? c.name
      const recovery: RecoveryAction[] = []
      if (c.installHint !== undefined) {
        recovery.push({
          id: `${id}.install`,
          label: `Copy ${c.installHint}`,
          kind: 'shell_copy',
          command: c.installHint,
          shell: ctx.os === 'win32' ? 'powershell' : 'sh',
          reason: `The ${c.name} check needs ${prog}.`,
          recheck: 'run.verify',
        })
      }
      recovery.push(verifySettings(`${id}.settings`, 'Edit the verify commands', ctx.folder))
      out.push(
        ctx.result({
          id,
          status: 'fail',
          title: `The ${c.name} check cannot find ${prog}`,
          detail:
            `\`${line}\` needs ${prog}, and Dim Factory did not find it on PATH, in node_modules/.bin, in .venv or as a ` +
            'project wrapper. Install it, or change the command.',
          category: 'deps_missing',
          recovery,
        }),
      )
      continue
    }
    if (c.trust !== 'trusted') {
      const changed = c.trust === 'changed'
      // Never a grant from here. A chip would trust a script the user was never shown; Settings shows the
      // command with its script (and what changed) and grants only the hash it showed.
      const review = verifySettings(`${id}.trust`, 'Review and trust in Settings', ctx.folder)
      out.push(
        ctx.result({
          id,
          status: 'warn',
          title: changed
            ? `The ${c.name} check changed since you trusted it`
            : `The ${c.name} check is not trusted yet`,
          detail: auto
            ? `Auto never trusts a command on its own, so Verify skips \`${line}\`. Review and trust it in Settings to run it.`
            : `Verify asks you to trust \`${line}\` when it gets there, or review and trust it in Settings now.`,
          category: 'verify_untrusted',
          recovery: [review],
        }),
      )
    }
  }
  if (out.length === 0) {
    const names = facts.commands.map((c) => c.name)
    out.push(
      ctx.result({
        status: 'pass',
        detail: `${names.length} ${names.length === 1 ? 'command' : 'commands'} ready: ${names.join(', ')}.`,
      }),
    )
  }
  return out
}

function templateResults(ctx: CheckContext): CheckResult[] {
  const cfg = ctx.config
  if (cfg === undefined) return []
  const planEnabled = cfg.passes.plan.enabled
  const out: CheckResult[] = []
  for (const p of PASS_NAMES) {
    const pass = cfg.passes[p]
    if (!pass.enabled) continue
    const t = pass.promptTemplate
    const id = `run.templates.${p}`
    const settings = {
      id: `${id}.settings`,
      label: `Edit the ${PASS_LABELS[p]} prompt`,
      kind: 'settings_link' as const,
      route: 'settings/prompts',
      pointer: `/passes/${p}/promptTemplate`,
    }
    let file: { text: string; sha256: string } | undefined
    try {
      file = readTemplateFile(t.path)
    } catch (err) {
      out.push(
        ctx.result({
          id,
          status: 'fail',
          title: `${PASS_LABELS[p]} prompt cannot be read`,
          detail: err instanceof PromptResolveError ? err.message : String(err),
          category: 'config_invalid',
          recovery: [settings],
        }),
      )
      continue
    }
    if (file === undefined) {
      out.push(
        ctx.result({
          id,
          status: 'fail',
          title: `${PASS_LABELS[p]} prompt template is missing`,
          detail: `${t.path} does not exist (template "${t.name}", ${t.layer} layer).`,
          category: 'config_invalid',
          recovery: [settings],
        }),
      )
      continue
    }
    const v = validateTemplate(file.text, p, { planEnabled })
    const errors = v.issues.filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      const listed = errors.slice(0, MAX_LISTED_ISSUES).map((i) => formatIssue(i, t.path))
      if (errors.length > MAX_LISTED_ISSUES) listed.push(`… and ${errors.length - MAX_LISTED_ISSUES} more`)
      out.push(
        ctx.result({
          id,
          status: 'fail',
          title: `${PASS_LABELS[p]} prompt template has ${errors.length === 1 ? 'an error' : `${errors.length} errors`}`,
          detail: listed.join('\n'),
          category: 'config_invalid',
          recovery: [settings],
        }),
      )
      continue
    }
    if (v.missingRequired.length > 0) {
      out.push(
        ctx.result({
          id,
          status: 'warn',
          title: `${PASS_LABELS[p]} prompt is missing ${v.missingRequired.map((n) => `{{${n}}}`).join(', ')}`,
          detail: `${t.path}: Dim Factory appends the default ${v.missingRequired.join(' and ')} section${
            v.missingRequired.length === 1 ? '' : 's'
          } when it builds the prompt.`,
          recovery: [settings],
        }),
      )
      continue
    }
    if (file.sha256 !== t.sha256) {
      out.push(
        ctx.result({
          id,
          status: 'pass',
          title: `${PASS_LABELS[p]} prompt changed since the run was configured`,
          detail: `${t.path} will be used as it is now.`,
        }),
      )
    }
  }
  if (out.length === 0) {
    out.push(
      ctx.result({
        status: 'pass',
        detail: enabledPasses(cfg)
          .map(
            (p) =>
              `${PASS_LABELS[p]}: ${cfg.passes[p].promptTemplate.name} (${cfg.passes[p].promptTemplate.layer})`,
          )
          .join(', '),
      }),
    )
  }
  return out
}
