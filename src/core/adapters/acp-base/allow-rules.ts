// The read-only allow-rules guard of the ACP base (the readonly mode's readiness check; Grok): the words of
// readiness `<id>` and of start()'s refusal when the user's own settings would let the agent change
// files unasked in a read-only pass (AcpVendorConfig.readonlyAllowRules). Pure; no em dashes (UI standards).
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ReadinessPurpose } from '../../../shared/vendors.ts'
import type { AcpAllowRule } from './config.ts'

/** What a readiness check names the pass it is for. */
export const PURPOSE_LABEL: Readonly<Record<ReadinessPurpose, string>> = {
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  fix: 'Fix',
  heal: 'the diagnosis',
  catalog: 'the price refresh',
}

/** A settings file as the copy names it: relative under the pass folder, `~/…` under the home folder. */
export function settingsFileLabel(file: string, o: { cwd: string; home: string }): string {
  const under = (root: string): string | undefined => {
    if (root === '') return undefined
    const r = relative(resolve(root), resolve(file))
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : undefined
  }
  const inCwd = under(o.cwd)
  if (inCwd !== undefined) return inCwd
  const inHome = under(o.home)
  return inHome !== undefined ? `~/${inHome}` : file
}

/** The rules as one line: `Bash(npm *) in ~/.claude/settings.json, …`, at most `max`, then how many more. */
export function allowRulesList(
  rules: readonly AcpAllowRule[],
  o: { cwd: string; home: string },
  max = 4,
): string {
  const shown = rules.slice(0, max).map((r) => `${r.rule} in ${settingsFileLabel(r.file, o)}`)
  const more = rules.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** Readiness `<id>` failing, and start()'s refusal: what the rules are, why they stop the pass, what to do. */
export function readonlyAllowRulesCopy(
  displayName: string,
  pass: string,
  rules: readonly AcpAllowRule[],
  o: { cwd: string; home: string },
): { title: string; detail: string } {
  const label = (PURPOSE_LABEL as Readonly<Record<string, string>>)[pass] ?? 'this pass'
  return {
    title: `Your allow rules would let ${displayName} change files in ${label}`,
    detail:
      `${displayName} applies your own allow rules before Dim Factory sees a request, and these let it edit files or run ` +
      `commands that can change them without asking: ${allowRulesList(rules, o)}. Dim Factory cannot turn them off for ` +
      `${displayName}, so it does not run ${label} (read-only) on ${displayName} in this folder. Remove or narrow ` +
      'those rules, or use another vendor for this pass.',
  }
}
