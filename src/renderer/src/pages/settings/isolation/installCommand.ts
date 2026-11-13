// An install command typed by the user (the install runs like a verify command, argv only, no shell;
// `isolation.worktree.installCommand`; depsConsent / depsFailed [Edit command]). It is split
// exactly as a verify command is (the renderer's port of core's tokenizer, verify/argv.ts: shell syntax refused before
// anything is written or sent), with the refusals worded for an install command. Core checks again.
import { displayArgv, tokenizeCommand } from '../verify/argv.ts'
import type { ArgvResult } from '../verify/argv.ts'

/** The tokenizer's words for a verify command, reworded for an install command. */
function reword(message: string): string {
  return message
    .replace('verify commands', 'install commands')
    .replace('A verify command', 'An install command')
    .replace('The verify command', 'The install command')
}

/** Split an install command line into argv, or say why it cannot run without a shell. */
export function parseInstallCommand(line: string): ArgvResult {
  const r = tokenizeCommand(line)
  return r.ok ? r : { ok: false, message: reword(r.message) }
}

/** core's `installCommand` (argv or one line) as the line the user edits. */
export function installCommandLine(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return displayArgv(value.filter((a): a is string => typeof a === 'string'))
  return ''
}
