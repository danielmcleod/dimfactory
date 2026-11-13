#!/usr/bin/env node
// Synthesizes the Muse exec fixtures (P1 scenarios M01-M05; Muse runs on `exec`, with no relay)
// from the pinned record shapes (src/core/adapters/muse/protocol/synthesized-v1.4.2/) and the sources they name.
//
//   node tests/fixtures/muse/recipes/synthesize.mjs [--check]
//
// The adapter was built without the Muse CLI (not installed on the dev machine), so every fixture is synthesized: its
// header says "synthesized": true and names its sources. The envelope and the payloads Dim Factory reads follow the
// community SDK muse-codes 0.1.4 (built from captured `muse exec --json` output of Muse Code 0.1.0-R708.1); the
// flags, exit codes and approval behaviour follow the official docs (dev.meta.ai/docs/muse-code, fetched 2026-10-11).
// What no source shows is marked x-assumed in the pin and in tests/fixtures/muse/README.md: usage (M02, M04), a
// refused side effect (M03), a failed run's terminal record (M05). Every record goes through the recorder's Muse
// rules (scripts/redact-muse.mjs), as a live recording would. For each scenario this also writes the live re-record
// recipe (recipes/<ID>-<slug>/prompt.md, pass.json, record.txt; README "Re-recording live").
// --check compares instead of writing (exit 1 when a committed file differs).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUSE_PROMPT_FILE, redactMuseValue } from '../../../../scripts/redact-muse.mjs'

const SELF = fileURLToPath(import.meta.url)
const FIXTURES = resolve(dirname(SELF), '..')
const RECIPES = dirname(SELF)
const ROUTE = 'exec'
/** The latest Muse Code release in the changelog when the adapter was built (dev.meta.ai/docs/muse-code/changelog). */
const CLI_VERSION = '1.4.2'
const MODEL = 'muse-spark-1.2'
const CWD = '<CWD>'
/** 2026-10-11T00:00:00Z in microseconds (the envelope's recorded_at unit). */
const T0_US = 1_791_676_800_000_000
const SOURCES =
  'src/core/adapters/muse/protocol/synthesized-v1.4.2 (synthesized pin); muse-codes 0.1.4 io/mod.rs and ' +
  'test_cases/meta_tool_use.jsonl (docs.rs, captured from Muse Code 0.1.0-R708.1); dev.meta.ai/docs/muse-code ' +
  '(extending, permissions, auth, configuration, changelog; fetched 2026-10-11)'

const hex = (n, width) => n.toString(16).padStart(width, '0')
/** UUIDv7-shaped ids, fixed per scenario so the files are byte-stable. */
const sessionId = (n) => `0199d2a0-4c1e-7a3b-8d5f-6e7a8b9c${hex(n, 4)}`
const commandId = (n) => `0199d2a0-4c1f-7b20-9c4d-5e6f7a8b${hex(n, 4)}`
const taskId = (n, k) => `0199d2a0-4c20-7c${hex(n, 2)}-a${hex(k, 3)}-0f1e2d3c4b5a`
const recordId = (n, seq) => `0199d2a0-4c21-7d${hex(n, 2)}-8000-${hex(seq, 12)}`
const callId = (n, k) => `call_${hex(n * 0x1000 + k, 8)}5a6b7c8d9e0f1a2b3c4d5e6f`

// ---- one recorded process -----------------------------------------------------------------------------------------

class Rec {
  constructor(n) {
    this.n = n
    this.seq = 0
    this.tasks = 0
    this.frames = []
    this.session = sessionId(n)
    this.command = commandId(n)
    this.runStream = { kind: 'run', id: this.command }
  }
  /** One record line, written as the recorder writes a live one (scripts/redact-muse.mjs). */
  record(payloadType, payload, o = {}) {
    this.seq++
    const value = {
      schema_version: 1,
      id: recordId(this.n, this.seq),
      stream: { kind: 'session', id: this.session },
      sequence: this.seq,
      recorded_at: T0_US + this.n * 1_000_000_000 + this.seq * 1_000,
      record_type: o.recordType ?? (this.seq === 1 ? 'reconciliation' : 'event'),
      durability: o.durability ?? 'durable',
      causation_id: this.command,
      payload_type: payloadType,
      payload_schema_version: 1,
      payload,
    }
    this.out(redactMuseValue(value).value)
  }
  out(value) {
    this.frames.push({ t: this.frames.length * 5, dir: 'out', line: JSON.stringify(value) })
  }
  err(line) {
    this.frames.push({ t: this.frames.length * 5, dir: 'err', line })
  }

  // ---- the run --------------------------------------------------------------------------------------------------
  start(prompt) {
    const c = { command_id: this.command }
    this.record('runtime.command.accepted', {
      kind: 'command_accepted',
      ...c,
      command_kind: 'turn.submit',
      client_id: null,
    })
    this.record('session.run.linked', { kind: 'session_run_linked', ...c, run_stream: this.runStream })
    this.record('run.model.configured', {
      kind: 'model_configured',
      ...c,
      run_stream: this.runStream,
      model_id: MODEL,
      display_label: 'Muse Spark 1.2',
      profile_id: 'default',
      provider_id: 'meta',
      source: 'startup',
    })
    this.record(
      'turn.input.user',
      { kind: 'turn_input_user', ...c, prompt, run_stream: this.runStream },
      { recordType: 'status', durability: 'ephemeral' },
    )
    this.record('run.lifecycle.started', { kind: 'run_started', ...c, prompt, run_stream: this.runStream })
  }
  #lifecycle(task, kind, extra = {}) {
    this.record(`task.lifecycle.${kind}`, {
      kind: 'task_lifecycle',
      command_id: this.command,
      run_stream: this.runStream,
      task_id: task,
      task_stream: { kind: 'task', id: task },
      event: { kind, task_id: task, ...extra },
    })
  }
  #newTask(taskKind) {
    const task = taskId(this.n, ++this.tasks)
    this.record('task.stream.linked', {
      kind: 'task_stream_linked',
      command_id: this.command,
      run_stream: this.runStream,
      task_id: task,
      task_stream: { kind: 'task', id: task },
    })
    this.#lifecycle(task, 'proposed', { task_kind: taskKind })
    this.#lifecycle(task, 'accepted')
    return task
  }
  /** One model call (task kind `model.meta.response`); `usage` (x-assumed) rides on its producer facet. */
  modelCall(o = {}) {
    const task = this.#newTask('model.meta.response')
    const key = `model:${this.command}:${task}`
    this.#lifecycle(task, 'scheduled', { idempotency_key: key })
    this.#lifecycle(task, 'side_effect_intent', {
      cancellation_handle: null,
      idempotency_key: key,
      operation: 'model.meta.response',
      parent_task_id: null,
      policy_decision: 'not_applicable',
    })
    this.#lifecycle(task, 'started', { span_id: hex(this.n * 0x10000 + this.tasks, 16) })
    const attempt = {
      kind: 'external_attempt',
      attempt: 1,
      max_attempts: 3,
      operation: 'model.meta.response',
      system: 'meta',
      ...(o.errorKind !== undefined ? { error_kind: o.errorKind } : {}),
    }
    this.#lifecycle(task, 'status', {
      message: 'opening model stream',
      details: { phase: 'opening_stream', facets: [attempt] },
    })
    if (o.fail !== undefined) {
      this.#lifecycle(task, 'failed', { reason: o.fail })
      return
    }
    this.#lifecycle(task, 'status', {
      message: 'model stream succeeded',
      details: {
        phase: 'stream_succeeded',
        facets: [
          attempt,
          {
            kind: 'producer',
            detail: {
              kind: 'provider',
              provider: 'meta',
              model: MODEL,
              request_id: `0199d2a0-4c22-7e00-8000-${hex(this.n * 0x100 + this.tasks, 12)}`,
              response_id: `resp_${hex(this.n * 0x100 + this.tasks, 24)}`,
              stream: {
                bytes_read: 4096 + this.tasks * 512,
                eof: true,
                eof_buffer_len: 0,
                last_wire_event_type: 'response.completed',
                time_to_first_event_ms: 420,
                wire_events_seen: 24 + this.tasks,
              },
              ...(o.usage !== undefined ? { usage: o.usage } : {}),
            },
          },
        ],
      },
    })
    this.#lifecycle(task, 'completed')
  }
  /**
   * One tool call (task kind `tool.<name>`): `policy` is the side effect's decision (`allow:policy`; x-assumed
   * `deny:…` when the sandbox and the approval mode refuse it), `result` the tool.result, `end` how the task ends.
   */
  tool(name, o) {
    const task = this.#newTask(`tool.${name}`)
    const call = callId(this.n, this.tasks)
    const key = `tool:${call}`
    this.#lifecycle(task, 'scheduled', { idempotency_key: key })
    this.#lifecycle(task, 'side_effect_intent', {
      cancellation_handle: null,
      idempotency_key: key,
      operation: `tool:${name}`,
      parent_task_id: null,
      policy_decision: o.policy ?? 'allow:policy',
    })
    const refused = (o.policy ?? '').startsWith('deny')
    if (!refused) {
      this.#lifecycle(task, 'started', { span_id: hex(this.n * 0x10000 + this.tasks, 16) })
      if (o.chunk !== undefined) this.#lifecycle(task, 'output', { chunk: o.chunk })
    }
    this.record('tool.result', {
      kind: 'tool_result',
      command_id: this.command,
      run_stream: this.runStream,
      call_id: call,
      text: o.text,
      correlation_facts: { outcome: o.outcome ?? 'success', tool_name: name },
      ...(o.edit !== undefined ? { edit_facts: { ...o.edit, tool_name: name } } : {}),
    })
    if (o.end === 'failed') this.#lifecycle(task, 'failed', { reason: o.reason ?? 'failed' })
    else this.#lifecycle(task, 'completed')
  }
  delta(text) {
    this.record(
      'run.output.delta',
      { kind: 'run_output_delta', command_id: this.command, run_stream: this.runStream, text },
      { recordType: 'status', durability: 'ephemeral' },
    )
  }
  terminal(terminal, o = {}) {
    this.record(`run.terminal.${terminal}`, {
      kind: 'run_terminal',
      command_id: this.command,
      reason: o.reason ?? null,
      run_stream: this.runStream,
      terminal,
      text: o.text ?? null,
      ...(o.usage !== undefined ? { usage: o.usage } : {}),
    })
  }
}

/** A Responses-style usage object (x-assumed in the pin). */
const usage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: reasoning },
  total_tokens: input + output,
})

const MODEL_USED = { type: 'meta', key: 'modelUsed', value: { model: MODEL } }
const tool = (id, name, phase, status) => ({
  type: 'tool',
  id,
  name,
  phase,
  ...(status !== undefined ? { status } : {}),
})

// ---- scenarios ------------------------------------------------------------------------------------------------------

const PROMPT = 'Add a --version flag to the CLI that prints the package version.'

/** Each scenario: id, slug, note, pass (header.pass and the recipe's pass.json), the frames, the expected entries. */
const SCENARIOS = [
  {
    id: 'M01',
    slug: 'plain-exec',
    note: 'A plain Implement under --disable-approval with no tool: the session stream, the model Muse configured, one model call (no usage, as captured), the answer as run.output.delta text, then run.terminal.completed with the full text; exit 0.',
    pass: { mode: 'autoedit', prompt: 'Explain in two sentences what src/cli.ts does. Do not change any file.' },
    build(r, s) {
      r.start(s.pass.prompt)
      r.modelCall()
      r.delta('src/cli.ts parses the command line ')
      r.delta('and prints a greeting. ')
      r.delta('It exports nothing else.')
      r.terminal('completed', {
        text: 'src/cli.ts parses the command line and prints a greeting. It exports nothing else.',
      })
    },
    expected: (r) => [
      { type: 'session', id: r.session },
      MODEL_USED,
      { type: 'text', delta: 'src/cli.ts parses the command line ' },
      { type: 'text', delta: 'and prints a greeting. ' },
      { type: 'text', delta: 'It exports nothing else.' },
      {
        type: 'done',
        result: 'src/cli.ts parses the command line and prints a greeting. It exports nothing else.',
      },
    ],
  },
  {
    id: 'M02',
    slug: 'edit-disable-approval',
    note: 'Implement under --disable-approval: write_file and an in-sandbox bash run without asking (allow:policy), each a task with its tool.result (edit_facts on the write); usage (x-assumed) per model call on the producer facet; exit 0.',
    pass: { mode: 'autoedit', prompt: PROMPT },
    build(r, s) {
      r.start(s.pass.prompt)
      r.modelCall({ usage: usage(6200, 4096, 310, 120) })
      r.tool('write_file', {
        text: 'Wrote 14 lines to src/cli.ts',
        edit: { added: 14, path: `${CWD}/src/cli.ts` },
      })
      r.modelCall({ usage: usage(7400, 6144, 180, 40) })
      r.tool('bash', { text: 'tests 3 passed', chunk: 'tests 3 passed\n' })
      r.modelCall({ usage: usage(7900, 7168, 90, 0) })
      r.delta('Added --version, which prints the version from package.json. ')
      r.delta('The tests pass.')
      r.terminal('completed', {
        text: 'Added --version, which prints the version from package.json. The tests pass.',
      })
    },
    expected: (r) => [
      { type: 'session', id: r.session },
      MODEL_USED,
      tool(taskId(r.n, 2), 'write_file', 'start'),
      tool(taskId(r.n, 2), 'write_file', 'end', 'ok'),
      tool(taskId(r.n, 4), 'bash', 'start'),
      tool(taskId(r.n, 4), 'bash', 'end', 'ok'),
      { type: 'text', delta: 'Added --version, which prints the version from package.json. ' },
      { type: 'text', delta: 'The tests pass.' },
      {
        type: 'done',
        result: 'Added --version, which prints the version from package.json. The tests pass.',
        usage: { input: 2104 + 1256 + 732, output: 580, cacheRead: 4096 + 6144 + 7168, reasoning: 160 },
      },
    ],
  },
  {
    id: 'M03',
    slug: 'escalation-fails',
    note: 'No relay: under --disable-approval with the sandbox network off (--sandbox-network restricted, Dim Factory sets it) a command that needs the network fails instead of asking. The side effect is refused (policy_decision deny:network_restricted, x-assumed), the task fails before it starts, its tool.result says why; Muse goes on and completes. No ask ever reaches Dim Factory; exit 0.',
    pass: {
      mode: 'autoedit',
      prompt: 'Check the latest TypeScript version on the npm registry and pin it in package.json.',
    },
    build(r, s) {
      r.start(s.pass.prompt)
      r.modelCall({ usage: usage(5600, 4096, 140, 60) })
      r.tool('bash', {
        policy: 'deny:network_restricted',
        outcome: 'denied',
        text: 'npm view typescript version needs network access, which is off for this run.',
        end: 'failed',
        reason: 'network access denied by the sandbox (--sandbox-network restricted)',
      })
      r.modelCall({ usage: usage(6100, 5120, 70, 0) })
      r.delta('The registry lookup needs network access, which this run does not allow; ')
      r.delta('I kept the pinned version.')
      r.terminal('completed', {
        text: 'The registry lookup needs network access, which this run does not allow; I kept the pinned version.',
      })
    },
    expected: (r) => [
      { type: 'session', id: r.session },
      MODEL_USED,
      tool(taskId(r.n, 2), 'bash', 'start'),
      tool(taskId(r.n, 2), 'bash', 'end', 'declined'),
      { type: 'text', delta: 'The registry lookup needs network access, which this run does not allow; ' },
      { type: 'text', delta: 'I kept the pinned version.' },
      {
        type: 'done',
        result: 'The registry lookup needs network access, which this run does not allow; I kept the pinned version.',
        usage: { input: 1504 + 980, output: 210, cacheRead: 4096 + 5120, reasoning: 60 },
      },
    ],
  },
  {
    id: 'M04',
    slug: 'yolo-full',
    note: 'Full mode (Auto only): --yolo, no sandbox and no prompts (Muse also trusts the folder for the run). A network command and an edit run unasked; the run total (x-assumed) is on run.terminal.completed; exit 0.',
    pass: { mode: 'full', prompt: 'Upgrade the dev dependencies and fix anything that breaks.' },
    argvMode: '--yolo',
    build(r, s) {
      r.start(s.pass.prompt)
      r.modelCall()
      r.tool('bash', { text: 'updated 2 packages', chunk: 'updated 2 packages\n' })
      r.modelCall()
      r.tool('edit_file', {
        text: 'Edited src/cli.ts',
        edit: { added: 2, path: `${CWD}/src/cli.ts` },
      })
      r.modelCall()
      r.delta('Upgraded the dev dependencies and adjusted one import.')
      r.terminal('completed', {
        text: 'Upgraded the dev dependencies and adjusted one import.',
        usage: usage(21000, 15360, 640, 200),
      })
    },
    expected: (r) => [
      { type: 'session', id: r.session },
      MODEL_USED,
      tool(taskId(r.n, 2), 'bash', 'start'),
      tool(taskId(r.n, 2), 'bash', 'end', 'ok'),
      tool(taskId(r.n, 4), 'edit_file', 'start'),
      tool(taskId(r.n, 4), 'edit_file', 'end', 'ok'),
      { type: 'text', delta: 'Upgraded the dev dependencies and adjusted one import.' },
      {
        type: 'done',
        result: 'Upgraded the dev dependencies and adjusted one import.',
        usage: { input: 5640, output: 640, cacheRead: 15360, reasoning: 200 },
      },
    ],
  },
  {
    id: 'M05',
    slug: 'auth-failure',
    note: 'Not signed in: the model call fails (x-assumed shapes), the run ends with run.terminal.failed and its reason, and the reason is the final stderr line (changelog 1.4.0); exit 1. Classified auth_required.',
    pass: { mode: 'autoedit', prompt: PROMPT },
    build(r, s) {
      r.start(s.pass.prompt)
      r.modelCall({ errorKind: 'auth', fail: 'authentication required' })
      const reason = 'Not signed in: run `muse` and sign in, or set META_API_KEY.'
      r.terminal('failed', { reason })
      r.err(`error: ${reason}`)
    },
    exitCode: 1,
    expected: (r) => [
      { type: 'session', id: r.session },
      MODEL_USED,
      { type: 'error', fatal: true, category: 'auth_required' },
    ],
  },
]

/** The pass as Dim Factory runs it (header.pass, recipes/<ID>/pass.json). Muse runs only with the folder's grant. */
const passOf = (s) => ({
  kind: 'pass',
  route: ROUTE,
  step: 'implement',
  mode: s.pass.mode,
  planNative: false,
  trustFolder: true,
  prompt: s.pass.prompt,
})

/**
 * `muse exec …` as the adapter builds it (src/core/adapters/muse/launch.ts museArgv): autoedit is `--disable-approval`
 * with the sandbox's network off, full mode `--yolo`.
 */
const argvOf = (s) => [
  'muse',
  'exec',
  '--json',
  '--prompt-file',
  MUSE_PROMPT_FILE,
  '--trust-workspace',
  ...(s.argvMode !== undefined ? [s.argvMode] : ['--disable-approval', '--sandbox-network', 'restricted']),
]

/** What the adapter writes to the prompt file (launch.ts musePromptText: the prompt and a final newline). */
const promptFileText = (s) => `${s.pass.prompt}\n`

function built() {
  return SCENARIOS.map((s, i) => {
    const r = new Rec(i + 1)
    const header = {
      kind: 'header',
      schemaVersion: 1,
      vendor: 'muse',
      route: ROUTE,
      scenario: `${s.id}-${s.slug}`,
      cliVersion: CLI_VERSION,
      os: 'any',
      arch: 'any',
      synthesized: true,
      synthesizedFrom: SOURCES,
      note: `${s.note} Generator: tests/fixtures/muse/recipes/synthesize.mjs. Re-record live: tests/fixtures/muse/README.md.`,
      argv: argvOf(s),
      // The key from --env-file and the isolated home the recorder points Muse at (--muse-home).
      envKeys: ['APPDATA', 'HOME', 'LOCALAPPDATA', 'META_API_KEY', 'USERPROFILE', 'XDG_CONFIG_HOME'],
      envDrop: ['^META_', '^MUSE_'],
      pass: passOf(s),
      hostVersion: '0.1.0',
    }
    // The adapter writes the prompt file before the spawn, then closes stdin at once.
    r.frames.push({ t: 0, dir: 'promptFile', argvPath: '--prompt-file', content: promptFileText(s) })
    r.frames.push({ t: 0, dir: 'eof' })
    s.build(r, s)
    r.frames.push({ t: r.frames.length * 5, dir: 'exit', code: s.exitCode ?? 0, signal: null })
    const text = `${[header, ...r.frames].map((f) => JSON.stringify(f)).join('\n')}\n`
    return { s, r, text }
  })
}

/** expected.events.json: the normalized events and the signals the scenario is about, each partial (README). */
const expectedText = (s, r) => `${JSON.stringify(s.expected(r), null, 2)}\n`

/** Live re-record notes per scenario (README "Re-recording live"): what it needs beyond the common command. */
const LIVE_NOTES = {
  M01: 'Any signed-in Muse (META_API_KEY in --env-file).',
  M02:
    'Confirms where exec reports usage (none was captured): a producer facet per model call, the terminal record, or nowhere. ' +
    'Record it twice: once on a fresh --muse-home, once with that profile set to start Unrestricted ' +
    '(permissions.default_profile in its settings.json): if the second run writes outside the sandbox, a remembered ' +
    'profile outranks --disable-approval and the adapter must refuse or pin the sandbox (README "Open questions").',
  M03:
    'The live check of "escalations fail": the registry lookup needs the network, which --sandbox-network restricted turns off. ' +
    'Shows how a refused connection looks on the wire (a policy deny, or a command that fails). Muse 1.3 was reported ' +
    'to hang on approvals; --timeout bounds the recording, and a hang is the finding (keep synthesized and note it).',
  M04: '--yolo runs with no sandbox: only in a disposable scratch copy, never a real project.',
  M05:
    'Needs a Muse that is not signed in: an --env-file without META_API_KEY on a machine whose Muse has no stored sign-in. ' +
    'Never run `muse logout` on the everyday sign-in for this; keep synthesized otherwise.',
}

/** recipes/<ID>-<slug>/record.txt: the command that re-records this scenario live (placeholders in <>). */
function recordCommand(s) {
  const name = `${s.id}-${s.slug}`
  const r = `tests/fixtures/muse/recipes/${name}`
  const argv = argvOf(s)
    .slice(1)
    .map((a) => (a === MUSE_PROMPT_FILE ? `"<repo>/${r}/prompt.md"` : a))
  const parts = [
    'node scripts/record-fixture.mjs --muse --muse-home "<fixture Muse home>" --bin "<the muse executable>" --cwd "<sandbox>"',
    `--out tests/fixtures/muse/${ROUTE}/${name} --id ${s.id} --slug ${s.slug} --cli-version <muse --version> --timing off`,
    `--env-file "<a file with META_API_KEY=...>" --pass-file ${r}/pass.json`,
  ]
  const lines = [
    `# ${name}: ${s.note}`,
    ...(LIVE_NOTES[s.id] ? [`# ${LIVE_NOTES[s.id]}`] : []),
    '# A fresh git-init copy of tests/fixtures/sandboxes/ts-small as <sandbox>; Muse signs in with the key, never the everyday sign-in.',
    '# <fixture Muse home> is an isolated folder that stands in for the home (never the everyday one): its .config/muse is the profile recorded.',
    `${parts.join(' ')} --timeout 900000 -- ${argv.join(' ')}`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Scenarios recorded live (`<ID>-<slug>`; README "Re-recording live"): the generator still writes their recipe, and
 * leaves their recording.jsonl and expected.events.json (the live ones) alone. None yet: the Muse CLI was not installed
 * when the adapter was built, so every fixture is synthesized.
 */
export const LIVE = new Set([])

/** Every file the generator owns: absolute path → content. */
export function synthesize() {
  const files = new Map()
  for (const { s, r, text } of built()) {
    const name = `${s.id}-${s.slug}`
    const dir = join(FIXTURES, ROUTE, name)
    if (!LIVE.has(name)) {
      files.set(join(dir, 'recording.jsonl'), text)
      files.set(join(dir, 'expected.events.json'), expectedText(s, r))
    }
    files.set(join(RECIPES, name, 'prompt.md'), promptFileText(s))
    files.set(join(RECIPES, name, 'pass.json'), `${JSON.stringify(passOf(s), null, 2)}\n`)
    files.set(join(RECIPES, name, 'record.txt'), recordCommand(s))
  }
  return files
}

/**
 * Files in the folders the generator owns (exec/<scenario>/, recipes/<scenario>/) that it does not write: a scenario
 * or recipe file since dropped. Absolute paths.
 */
export function strays(files = synthesize()) {
  const owned = new Set([...files.keys()].map((p) => resolve(p).toLowerCase()))
  const out = []
  for (const base of [join(FIXTURES, ROUTE), RECIPES]) {
    if (!existsSync(base)) continue
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (base !== RECIPES && LIVE.has(d.name)) continue // a live recording's folder is not the generator's
      for (const f of readdirSync(join(base, d.name))) {
        const p = join(base, d.name, f)
        if (!owned.has(resolve(p).toLowerCase())) out.push(p)
      }
    }
  }
  return out
}

/** Generated files whose committed content differs (LF-normalized) or that are missing, and stray files. */
export function outOfDate(files = synthesize()) {
  const stale = []
  for (const [path, content] of files) {
    if (!existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== content) stale.push(path)
  }
  return [...stale, ...strays(files)]
}

export { SCENARIOS }

const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
if (process.platform === 'win32' ? argv1.toLowerCase() === SELF.toLowerCase() : argv1 === SELF) {
  const files = synthesize()
  if (process.argv.includes('--check')) {
    const stale = outOfDate(files)
    if (stale.length > 0) {
      process.stderr.write(`synthesize: out of date (run it without --check):\n${stale.map((d) => `  ${d}`).join('\n')}\n`)
      process.exitCode = 1
    }
  } else {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    process.stdout.write(`synthesized ${SCENARIOS.length} Muse fixtures (${files.size} files)\n`)
    // Never deleted here: a file the generator no longer writes is listed for the author to remove.
    const left = strays(files)
    if (left.length > 0) {
      process.stderr.write(`synthesize: files the generator no longer writes (remove them):\n${left.map((d) => `  ${d}`).join('\n')}\n`)
      process.exitCode = 1
    }
  }
}
