// The optional AI judge (off by default): after the grounding checks, a cheap model of the Review pass's vendor reads
// the pass's claims, the diff's numbers and a summary of what its tools did, and lists the claims the evidence does
// not support. Its findings are always `[should]` and flagged `ai-judged`. It never sees file contents, the names of
// the user's skills, MCP servers or agents, or anything outside the run. Pure: the controller runs the model.
import type { PriceEntry } from '../../shared/catalog.ts'
import type { FindingInput } from '../supervisor/types.ts'
import { checkClaims, pathRefs } from './claims.ts'
import type { GroundingTrack } from './evidence.ts'
import { groundingId } from './checks.ts'

/** The cheapest model the catalog prices for a vendor (input plus output per million tokens); null: none priced. */
export function cheapestModel(entries: readonly PriceEntry[], vendor: string): string | null {
  let best: PriceEntry | undefined
  for (const e of entries) {
    if (e.vendor !== vendor || e.deprecated === true) continue
    if (best === undefined || e.inputPerMTok + e.outputPerMTok < best.inputPerMTok + best.outputPerMTok)
      best = e
  }
  return best?.model ?? null
}

export interface JudgeInput {
  step: 'implement' | 'fix'
  finalText: string
  /** The pass's diff: files, lines added and deleted, and the changed paths (at most 40). */
  diff: { files: number; added: number; deleted: number; paths: readonly string[] }
  evidence?: GroundingTrack | undefined
  /** The Verify round after the pass: each command's name and status. */
  verify?: readonly { name: string; status: string }[] | undefined
}

const CLAIMS_MAX = 20

/** The judge's prompt: the claims, the diff's numbers and the tool summary, and the answer format. */
export function judgePrompt(i: JudgeInput): string {
  const claims = [
    ...checkClaims(i.finalText).map((c) => c.line),
    ...pathRefs(i.finalText)
      .filter((r) => r.claim)
      .map((r) => r.line),
  ]
  const unique = [...new Set(claims)].slice(0, CLAIMS_MAX)
  const ev = i.evidence
  const tools =
    ev === undefined
      ? 'not recorded'
      : `${ev.shells} shell commands (${ev.tests} ran tests, ${ev.builds} built or type-checked), ${Object.keys(ev.failedEdits).length} files with failed edits, ${ev.reads.length} files read`
  const verify =
    i.verify === undefined || i.verify.length === 0
      ? 'did not run'
      : i.verify.map((v) => `${v.name}: ${v.status}`).join('; ')
  return [
    "You check whether a coding agent's claims are supported by evidence. You cannot read files or run anything.",
    '',
    `The ${i.step === 'fix' ? 'Fix' : 'Implement'} pass said:`,
    ...(unique.length > 0 ? unique.map((c) => `- ${c}`) : ['- (no specific claims)']),
    '',
    `Its diff: ${i.diff.files} files, +${i.diff.added} -${i.diff.deleted} lines. Files: ${i.diff.paths.slice(0, 40).join(', ') || 'none'}.`,
    `Its tools: ${tools}.`,
    `Verify after it: ${verify}.`,
    '',
    'List each claim the evidence does not support, one per line, starting with "UNSUPPORTED: " and a short reason.',
    'If every claim is supported, answer exactly "ALL SUPPORTED". Do not list anything else.',
  ].join('\n')
}

const LINE = /^\s*(?:[-*]\s*)?UNSUPPORTED:\s*(.+?)\s*$/i

/** The judge's answer as findings (`[should]`, flagged ai-judged); at most 5. */
export function parseJudgeAnswer(text: string, step: 'implement' | 'fix'): FindingInput[] {
  const out: FindingInput[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (m === null) continue
    const reason = (m[1] ?? '').replace(/—/g, ':').slice(0, 300)
    if (reason === '') continue
    out.push({
      id: groundingId(`judge\n${step}\n${reason.toLowerCase()}`),
      severity: 'should',
      title: `AI-judged: ${reason}`,
      body: 'A cheap model compared the claims with the evidence. Treat this as a hint, not a verdict.',
      source: 'grounding',
      flags: ['ai-judged'],
    })
    if (out.length >= 5) break
  }
  return out
}
