// Classifier suite inputs: one case per failure category from Claude, Codex and Gemini fixtures plus
// synthesized ones. Claude cases read recorded fixtures (tests/fixtures/claude/stdio/*) where one exists. Codex (X) and
// Gemini/ACP (G) frames are SYNTHESIZED from the documented shapes where no recording exists.
import { fileURLToPath } from 'node:url'
import type { ClassifyInput } from '@core/heal/classify.ts'
import { inputFromRecording } from '../heal/fixture-input.ts'

export const NOW = 1_760_000_000_000

export const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))

/** A recorded Claude fixture as classifier input; `extra` is what Dim Factory itself knew (a kill, a flag). */
export function recorded(id: string, extra: Partial<ClassifyInput> = {}): ClassifyInput {
  return { ...inputFromRecording(`${STDIO}${id}/recording.jsonl`, 'claude'), now: NOW, ...extra }
}

export const claude = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  vendor: 'claude',
  now: NOW,
  ...o,
})
export const codex = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({ vendor: 'codex', now: NOW, ...o })
export const gemini = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  vendor: 'gemini',
  now: NOW,
  ...o,
})
export const local = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  vendor: 'local-ollama',
  now: NOW,
  ...o,
})
/** A Dim Factory-side failure (git, verify, guard): the vendor names the subsystem. */
export const app = (vendor: string, o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  vendor,
  now: NOW,
  ...o,
})

// ---- Codex (SYNTHESIZED; app-server v2 and exec --json shapes) ---------------------------------------------

const THREAD = '0199a0c3-0000-7000-8000-000000000001'
const TURN = '0199a0c3-0000-7000-8000-000000000002'

/** `CodexErrorInfo`: unit variants serialize as a string, struct variants as a single-key object. */
export type CodexInfo = string | Record<string, { httpStatusCode: number | null }>

/** app-server `turn/completed` with `turn.status:'failed'`. */
export function codexTurnFailed(info: CodexInfo | null, message: string) {
  return {
    method: 'turn/completed',
    params: {
      threadId: THREAD,
      turn: {
        id: TURN,
        status: 'failed',
        error: { message, codexErrorInfo: info, additionalDetails: null },
      },
    },
  }
}

/** app-server `error` notification; `willRetry:true` is liveness only. */
export function codexError(info: CodexInfo | null, message: string, willRetry: boolean) {
  return {
    method: 'error',
    params: {
      error: { message, codexErrorInfo: info, additionalDetails: null },
      willRetry,
      threadId: THREAD,
      turnId: TURN,
    },
  }
}

/** exec --json `turn.failed` (codexErrorInfo is flattened into the message). */
export const execTurnFailed = (message: string) => ({ type: 'turn.failed', error: { message } })
/** exec --json `error`: may be transient; text evidence only. */
export const execError = (message: string) => ({ type: 'error', message })

// ---- ACP / Gemini (SYNTHESIZED; ACP JSON-RPC shapes) -----------------------------------------------------

/** The `session/prompt` response. */
export const acpStop = (stopReason: string, id = 7) => ({ jsonrpc: '2.0', id, result: { stopReason } })
/** A JSON-RPC error response. */
export const acpErrorResponse = (code: number, message: string, id = 3) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

export const GEMINI_AUTH_TEXT =
  'Please set an Auth method in your /home/u/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA'

/** A Gemini API 429 as the CLI prints it; `quotaId` decides per-minute (rate) vs per-day (quota). */
export function gemini429(quotaId: string, retry = 'Please retry in 41.5s.'): string {
  return `[API Error: {"error":{"code":429,"message":"You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash. ${retry}","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"${quotaId}"}]}]}}]`
}
