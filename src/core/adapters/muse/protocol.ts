// The pinned shapes of `muse exec --json` (pinned from `muse schema generate-json-schema`; the probe compares the
// schema hash with the pin and warns on a difference). Muse support was built without a Muse CLI:
// the pin in protocol/synthesized-v1.4.2/ is SYNTHESIZED from the official docs and a community SDK's captures.
import { createHash } from 'node:crypto'

/** The folder of the pinned schema (relative to this file). */
export const MUSE_PROTOCOL_DIR = 'protocol/synthesized-v1.4.2'

/**
 * What the pin is. `liveSchemaSha256` is the sha256 of what a real `muse schema` printed (LF line endings, trailing
 * whitespace trimmed) once someone pins it from an install (protocol/…/README.md "Re-pinning"); null until then, so the
 * probe's protocol check can only warn that the shapes are synthesized.
 */
export interface MusePin {
  synthesized: boolean
  /** The Muse release the synthesized shapes target (the latest changelog entry when they were written). */
  targetCliVersion: string
  /** sha256 of the committed schema file (checked by a unit test, like the ACP pin). */
  committedSha256: string
  liveSchemaSha256: string | null
}

export const MUSE_PIN: MusePin = {
  synthesized: true,
  targetCliVersion: '1.4.2',
  committedSha256: '36c65f997ebcf8c23861480f05b7ed4a901bada50685310b3137bd3c7c631506',
  liveSchemaSha256: null,
}

/**
 * The commands that print Muse's schema, tried in order until one answers (`muse schema
 * generate-json-schema`; the official overview says `muse schema` prints it). Token-free, run in the probe folder.
 */
export const MUSE_SCHEMA_PROBE_ARGS: readonly (readonly string[])[] = [
  ['schema', 'generate-json-schema'],
  ['schema'],
]

/** sha256 of a schema as a CLI printed it: CRLF folded to LF, trailing whitespace trimmed. */
export function schemaHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trimEnd(), 'utf8').digest('hex')
}

// ---- payload types (the record's `payload_type`) ----------------------------------------------------------------

export const P = {
  commandAccepted: 'runtime.command.accepted',
  sessionRunLinked: 'session.run.linked',
  modelConfigured: 'run.model.configured',
  turnInputUser: 'turn.input.user',
  runStarted: 'run.lifecycle.started',
  taskStreamLinked: 'task.stream.linked',
  outputDelta: 'run.output.delta',
  toolResult: 'tool.result',
} as const

export const TASK_LIFECYCLE_PREFIX = 'task.lifecycle.'
export const RUN_TERMINAL_PREFIX = 'run.terminal.'
/** `run.terminal.completed` / `terminal: "completed"`: the only successful ending. */
export const TERMINAL_COMPLETED = 'completed'
/** A tool task's `task_kind` (`tool.write_file`). Other tasks (model calls, reminders) are not tools. */
export const TOOL_TASK_PREFIX = 'tool.'
/** A tool task's `idempotency_key` (`tool:call_<hex>`), which a `tool.result` names by its `call_id`. */
export const TOOL_KEY_PREFIX = 'tool:'

/** The payload types the adapter reads; the probe looks for them in the schema a real Muse prints. */
export const READ_PAYLOAD_TYPES: readonly string[] = [
  P.outputDelta,
  'run.terminal',
  'task.lifecycle',
  P.toolResult,
]

/** The task lifecycle event kinds that end a task. */
export const TASK_END_KINDS: ReadonlySet<string> = new Set(['completed', 'failed', 'rejected', 'cancelled'])
