// What Gemini CLI puts on the ACP wire where the schema leaves it free (read
// from gemini-cli v0.62.0 and main): a shell confirmation's command and folder, the exit_plan_mode request, the
// approval-mode echo and the token totals of a PromptResponse without `usage`. Pure; shared with the fixture recipes.
import type { AcpShellRequest } from '../acp-base/config.ts'
import type { Rec } from '../acp-base/wire.ts'
import { arr, contentText, num, rec, str } from '../acp-base/wire.ts'

/**
 * Gemini's exit_plan_mode request (core tools/exit-plan-mode.ts): kind `other` (Kind.Plan has no ACP kind), no name,
 * no rawInput and no content; its title is getDescription(), `Requesting plan approval for: <plans dir>/<file>.md`.
 * Group 1 is the plan file.
 */
export const GEMINI_PLAN_EXIT_TITLE = /^Requesting plan approval for: (.+\.md)$/

/**
 * Gemini reports an approval-mode change (its own, or the echo of Dim Factory's session/set_mode) as an
 * agent_message_chunk `[MODE_UPDATE] <mode>` (acpSession handleApprovalModeChanged), never as current_mode_update.
 * Group 1 is the mode id (default, autoEdit, yolo, plan).
 */
export const GEMINI_MODE_UPDATE = /^\[MODE_UPDATE\] (\S+)$/

/** What may follow the folder in a shell explanation: ` (<description>)` and ` [background]`. */
const EXPLANATION_TAIL = /^(?: \(.*\))?(?: \[background\])?$/s

/**
 * The folder a shell explanation names (core tools/shell.ts getContextualDetails): `[in <dir_path>]` (as the model
 * gave it: relative to the session's folder, or absolute) or `[current working directory <cwd>]` (the CLI's own
 * folder, which Dim Factory starts it in), then ` (<description>)` and ` [background]` when set. The description is the
 * model's free text, so the folder is taken only when exactly one reading of the text exists; anything else
 * (another shape, a folder whose `]` makes two readings possible) is undefined: never cached.
 */
export function geminiExplanationDir(explanation: string): string | undefined {
  const text = explanation.trim()
  for (const prefix of ['[in ', '[current working directory ']) {
    if (!text.startsWith(prefix)) continue
    const body = text.slice(prefix.length)
    const readings: string[] = []
    for (let i = body.indexOf(']'); i !== -1; i = body.indexOf(']', i + 1)) {
      if (EXPLANATION_TAIL.test(body.slice(i + 1))) readings.push(body.slice(0, i))
    }
    const dir = readings.length === 1 ? readings[0] : undefined
    return dir !== undefined && dir.trim() !== '' && !/[\r\n\0]/.test(dir) ? dir : undefined
  }
  return undefined
}

/**
 * A Gemini shell confirmation (acpSession runTool): its title is the command (shell.ts getDisplayTitle returns
 * `params.command`), its one text content block the explanation (where it runs and the model's description), and it
 * sends no rawInput. The command comes from the title alone, never from the content; the folder from the explanation,
 * or undefined when it cannot be read for certain (then the request is asked and never cached). Should a later Gemini
 * send the tool's params as rawInput, they are read instead (`command`, and `dir_path` or the session's folder).
 */
export function geminiShellRequest(toolCall: Rec): AcpShellRequest {
  const texts = arr(toolCall['content']).flatMap((c) => {
    const r = rec(c)
    const t = str(r?.['type']) === 'content' ? contentText(r?.['content']) : undefined
    return t !== undefined && t.trim() !== '' ? [t.trim()] : []
  })
  const note = texts.length === 1 ? texts[0] : undefined
  const raw = rec(toolCall['rawInput'])
  const rawCommand = str(raw?.['command'])
  if (rawCommand !== undefined && rawCommand.trim() !== '') {
    const dir = str(raw?.['dir_path'])
    return { command: rawCommand, dir: dir === undefined || dir === '.' ? '' : dir, note }
  }
  const title = str(toolCall['title'])
  const command = title !== undefined && title.trim() !== '' ? title : undefined
  return { command, dir: note !== undefined ? geminiExplanationDir(note) : undefined, note }
}

/**
 * Gemini 0.62 and 0.63 answer session/prompt with `_meta.quota.token_count {input_tokens, output_tokens}` and no
 * `usage` (0.64 sends both). input_tokens is the prompts' promptTokenCount (cached tokens included, no split) and
 * output_tokens their candidatesTokenCount (thoughts not counted). undefined when the answer has none.
 */
export function geminiMetaUsage(result: unknown): { input: number; output: number } | undefined {
  const count = rec(rec(rec(rec(result)?.['_meta'])?.['quota'])?.['token_count'])
  const input = num(count?.['input_tokens'])
  const output = num(count?.['output_tokens'])
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined
  return { input, output }
}
