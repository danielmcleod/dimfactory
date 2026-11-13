// What the agent plugins (Codex, Claude Code) share: the plan an install would carry out (files to write, commands to
// run, as the user reads them) and the install itself, which writes the files and then runs the agent's CLI commands
// in order, stopping at the first one that fails.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentPluginResult, AgentPluginStep } from '../../shared/ipc.ts'

/** Runs an agent's CLI with these arguments (null: the CLI was not found). */
export type PluginCliRunner = (
  args: string[],
) => Promise<{ code: number | null; output: string; timedOut?: boolean } | null>

export interface PluginFile {
  path: string
  content: string
}

/** JSON as the plugin files hold it: two-space indent, closing newline. */
export const pluginJson = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

/** A shell word to read or paste: double-quoted when it has a space (backslashes kept, as Windows paths need). */
const quoted = (a: string): string => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)

export const commandLine = (bin: string, args: readonly string[]): string =>
  `${bin} ${args.map(quoted).join(' ')}`

/** What an install would write and run; writes nothing. */
export function pluginPlan(o: {
  dir: string
  files: readonly PluginFile[]
  commands: readonly string[][]
  bin: string
}): AgentPluginResult {
  return {
    dir: o.dir,
    files: o.files.map((f) => f.path),
    commands: o.commands.map((args) => commandLine(o.bin, args)),
    installed: false,
    steps: [],
  }
}

/** Write the files, then run each command; a missing CLI or a failing command stops the install there. */
export async function installPlugin(o: {
  dir: string
  files: readonly PluginFile[]
  commands: readonly string[][]
  bin: string
  run: PluginCliRunner
  /** The step's output when the CLI was not found. */
  notFound: string
}): Promise<AgentPluginResult> {
  const plan = pluginPlan(o)
  for (const f of o.files) {
    await mkdir(dirname(f.path), { recursive: true })
    await writeFile(f.path, f.content)
  }
  const steps: AgentPluginStep[] = []
  for (const args of o.commands) {
    const command = commandLine(o.bin, args)
    const r = await o.run(args)
    if (r === null) {
      steps.push({ command, ok: false, output: o.notFound })
      break
    }
    const output = r.output.trim().slice(0, 2000)
    // Adding a marketplace or plugin that is already there is fine.
    const ok = (r.code === 0 && r.timedOut !== true) || /already/i.test(output)
    steps.push({ command, ok, output })
    if (!ok) break
  }
  return {
    ...plan,
    installed: steps.length === o.commands.length && steps.every((s) => s.ok),
    steps,
  }
}
