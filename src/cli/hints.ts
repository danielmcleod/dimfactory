// What to run in a terminal for a recovery action: the app shows buttons, the CLI prints the
// command that does the same (shell_copy commands, `config restore`, `config trust`, `--set` for run overrides), the
// file position to open, or the documentation link (open_docs).
import type { RecoveryAction } from '../shared/failure.ts'

export interface HintContext {
  /** How the user runs this CLI (`pnpm cli`, `node …`, `dim-factory`); see session.ts `cliName`. */
  cli: string
  /** The run folder (project-scope hints). */
  folder?: string
  /** `--home` as given on the command line. */
  home?: string
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Quote an argument that a shell would split. */
export function shellArg(s: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`
}

const setValue = (v: unknown): string => (typeof v === 'string' ? shellArg(v) : JSON.stringify(v))

/** The command (or `file:line:col`) for an action, or undefined when only the app can do it. */
export function recoveryHint(a: RecoveryAction, c: HintContext): string | undefined {
  const home = c.home !== undefined ? ` --home ${shellArg(c.home)}` : ''
  switch (a.kind) {
    case 'shell_copy':
      return a.command
    case 'settings_link': {
      const s = isObj(a.suggested) ? a.suggested : undefined
      if (s === undefined) return undefined
      if (a.id.endsWith('.restore')) {
        const folder = typeof s['folder'] === 'string' ? s['folder'] : c.folder
        const project =
          s['scope'] === 'project' && folder !== undefined ? ` --project ${shellArg(folder)}` : ''
        return `${c.cli} config restore${project}${home}`
      }
      if (a.id.endsWith('.open') && typeof s['path'] === 'string') {
        return typeof s['line'] === 'number'
          ? `${s['path']}:${s['line']}:${typeof s['col'] === 'number' ? s['col'] : 1}`
          : s['path']
      }
      return undefined
    }
    case 'grant':
      if ((a.grant === 'projectAuto' || a.grant === 'largeFolder') && c.folder !== undefined) {
        return `${c.cli} config trust ${shellArg(c.folder)} ${a.grant}${home}`
      }
      // A project recipe's Auto mode, for the version of the file the check showed.
      if (a.grant === 'recipeAuto' && a.recipeId !== undefined && c.folder !== undefined) {
        return `${c.cli} config trust ${shellArg(c.folder)} recipeAuto --recipe ${shellArg(a.recipeId)}${home}`
      }
      // Trusting the folder for a vendor (Gemini).
      if (a.grant === 'vendorFolder' && a.vendor !== undefined && c.folder !== undefined) {
        return `${c.cli} config trust ${shellArg(c.folder)} vendorFolder --vendor ${shellArg(a.vendor)}${home}`
      }
      return undefined
    case 'config_patch': {
      if (a.target !== 'runOverrides') return undefined
      const sets = a.ops.flatMap((op) =>
        op.op === 'add' || op.op === 'replace'
          ? [`--set ${op.path.slice(1).replace(/\//g, '.')}=${setValue(op.value)}`]
          : [],
      )
      return sets.length > 0 ? `run again with ${sets.join(' ')}` : undefined
    }
    case 'open_docs':
      // The app opens it in the browser (recovery.execute); a terminal shows the link.
      return a.url
    case 'retry':
    case 'resume':
    case 'vendor_setup':
    case 'switch_vendor':
    case 'wait_until':
    case 'skip_pass':
    case 'close_run':
    case 'heal':
      return undefined
  }
}

/** `-> label` or `-> label: hint`. */
export function recoveryLine(a: RecoveryAction, c: HintContext | undefined): string {
  const hint =
    c !== undefined
      ? recoveryHint(a, c)
      : a.kind === 'shell_copy'
        ? a.command
        : a.kind === 'open_docs'
          ? a.url
          : undefined
  return `-> ${a.label}${hint !== undefined ? `: ${hint}` : ''}`
}
