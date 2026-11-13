# Gemini fixtures

The Gemini adapter's fixtures, on the shared ACP base: the Gemini CLI over the Agent Client Protocol (`gemini --acp`, JSON-RPC 2.0 over stdio), replayed by the fake CLI through the real resolver and spawn
path (the fake behind an npm-style `gemini.cmd` shim on Windows, run as system `node <entry>`; a shebang copy elsewhere).

**Every fixture here is synthesized.** The Gemini CLI was not available when the adapter was built, so no
fixture could be recorded live and no Gemini account or token was used. Each one is generated from the pinned ACP
schema (`src/core/adapters/acp-base/protocol/v1.25.0/`) and gemini-cli's own source (below), and its header says so
(`"synthesized": true`, `synthesizedFrom`). Every scenario has a one-command live re-record recipe (below). The checks
that need the real CLI are still to run ("Live checks still to run"), not faked.

**The agent's shapes follow gemini-cli's own source.** The first synthesis followed the ACP schema alone and
got four Gemini shapes wrong; the review read `packages/cli/src/acp/acpSession.ts`, `acpUtils.ts` and the core tools at
the tags v0.62.0, v0.63.0, v0.64.0-preview.0 and main (read-only, raw.githubusercontent.com, 2026-10-11), and the
fixtures now have Gemini's own shapes:

| What | Gemini sends | The first synthesis had |
|---|---|---|
| A shell confirmation (`run_shell_command`) | `title` = the command (`getDisplayTitle`), one text block = its explanation `[in <dir_path>]` or `[current working directory <cwd>]`, then ` (<description>)` and ` [background]` when set; no `rawInput` | the description in the title, the command as the text |
| `exit_plan_mode` | kind `other` (`Kind.Plan` has no ACP kind), title `Requesting plan approval for: <plans dir>/<file>.md`, no name, no content, no rawInput; the plan is the file it names (written by the model before it asks) | kind `switch_mode`, title "Exit plan mode", the plan as content |
| A mode change (also the echo of Dim Factory's own `session/set_mode`) | an `agent_message_chunk` `[MODE_UPDATE] <mode>` (never `current_mode_update`), sent while set_mode runs | nothing |
| The prompt's answer | 0.62 and 0.63: `_meta.quota.token_count {input_tokens, output_tokens}` only (promptTokenCount, candidatesTokenCount); 0.64: also `usage` (`totalTokens = inputTokens + outputTokens`, cached and thought tokens apart) and a `usage_update` per model call; a cancelled prompt: neither | `usage` everywhere, `totalTokens` with thoughts in it |

| What | Source |
|---|---|
| `acp/<ID>-<slug>/` (all 29) | **Synthesized** by `recipes/synthesize.mjs` (`--check` runs in the unit suite) |
| `src/core/adapters/acp-base/protocol/v1.25.0/` | The ACP schema **Schema v1.25.0** (tag `schema-v1.25.0`, released 2026-10-09), fetched read-only on 2026-10-10 from github.com/agentclientprotocol/agent-client-protocol, Apache-2.0; its README names the files, the hashes and the one escape edit |

## Layout

| Path | What |
|---|---|
| `acp/<ID>-<slug>/recording.jsonl` | A header, then `{t, dir, line}` frames, then the exit frame |
| `acp/<ID>-<slug>/expected.events.json` | What Dim Factory's ACP base must emit for it (below) |
| `recipes/synthesize.mjs` | The generator of the fixtures and of every recipe (`--check`: compare only, exit 1 on a difference or a file it no longer writes; it never deletes a file) |
| `recipes/<ID>-<slug>/stdin.jsonl` | Dim Factory's own requests (`initialize`, `session/new` or `session/load` / `session/resume`, `session/set_mode`, `session/prompt`), each paced by a `$wait` on its answer; the session id is `$capture`d from `session/new` (`--var sessionId=` for a resume) and the sandbox is `$cwd` |
| `recipes/<ID>-<slug>/responders.mjs` | One line on top of `recipes/dim-factory-responder.mjs` with the recipe's `pass.json`: it answers every agent request as the ACP base does, however many a live model makes |
| `recipes/<ID>-<slug>/pass.json`, `record.txt` | How Dim Factory ran the pass (the header's `pass`), and the command that re-records the scenario live |
| `recipes/dim-factory-responder.mjs` | Dim Factory's permission order: a Plan pass's plan exit is rejected and followed by `session/cancel`; a read-only pass rejects every request (`reject_once`); otherwise the pass's `answers` in order (allow → `allow_once`, allow-session → the first session-scoped `allow_always` of optionPrefs, deny → `reject_once`); with `stop.after` an ask, the first ask is a Stop (`session/cancel`, then `cancelled`); any other request gets -32601 (fs and terminal capabilities stay false) |

Frames are those of the Codex app-server recordings: `in` (Dim Factory → agent), `out` (agent → Dim Factory), `err`
(stderr), `{"dir":"eof"}` (the host closed stdin: an ACP agent exits on it) and `exit`. A GX recording ends with the
CLI's exit before any `eof` (it exited first). `{"dir":"file","path":…,"content":…}` is a file the CLI
wrote at that point: Gemini's plan file, recorded before the exit_plan_mode request that names it (the recorder reads
only a `.md` of 1 MB or less under `<GEMINI_CLI_HOME>/.gemini/tmp`). The fake writes it on replay, its `path`
placeholders filled in (`<GEMINI_CLI_HOME>` with its own `GEMINI_CLI_HOME`, `<PROJECT>` with `project`, `<CWD>`), so the
adapter reads the plan from it as from the live file; with `FAKE_CLI_OUT_CWD=1` the same placeholders in the agent's
frames name those folders too.

### Header

| Field | Value |
|---|---|
| `cliVersion` | The Gemini CLI whose shape the fixture has: `0.62.0` (the recommended version), or `0.64.0-preview.0` for G05a (the first that sends `usage`) |
| `protocol`, `jsonrpc` | `"jsonrpc"` and `"2.0"`: the fake replays by **message** (as for Codex: a request takes the next client request of that method, a reply to an agent request is matched by the agent's id, the host's own ids are free), and every message carries the JSON-RPC 2.0 header (JsonRpcPeer `header: '2.0'`) |
| `argv`, `launch` | `gemini --acp [-m <model>] [--skip-trust]`, and `"launch":"node <entry>"`: the npm shim's JS entry runs under system node, never Electron's |
| `envKeys`, `envDrop` | `GEMINI_CLI_HOME` (an isolated profile), and `^GEMINI_` / `^GOOGLE_`: the recorded CLI inherits no key, project or other home from the recorder |
| `pass` | `kind` `pass` or `probe` (G01); `step`, `mode`, `planNative`, `prompt`, `model`; `trustFolder` (the vendorFolder grant: `--skip-trust` is in argv exactly when it is true, or for the probe's Dim Factory-owned folder); `answers` `[{decision}]` given to the asks in order; `stop` `{after: <partial event>, reason}`; `resume` `{sessionId, priorUsage?}` |

### expected.events.json

As for Codex: normalized events plus the adapter signals the scenario is about, never liveness, every entry
**partial**. Events have no ask `requestId`, `detail` or `expiresAt`, and no tool `name` or `summary`; signals have no
`requestId` or `tool`, and a meta signal only its `key`. The adapter replay compares the events in order
(`toMatchObject`) and finds the expected signals in order among the adapter's. `done.usage` is this pass's usage:
`input` is uncached input, `cacheRead` and `reasoning` (Gemini's `thoughtTokens`) are informational.

## Scenarios

| ID | Scenario |
|---|---|
| G01 | The probe (`vendor.gemini.protocol`, `.plan`): `initialize` + `session/new` in Dim Factory's own folder with `--skip-trust`, no prompt, no token. The answer advertises `loadSession`, the four modes (default, autoEdit, yolo, plan) and Gemini CLI 0.62's `models` (outside schema v1.25.0, which moved model choice to `configOptions`) |
| G02 | Read-only Review with a picked model (`-m`): `set_mode default` (no echo: the session starts in default), a thought (logged, never printed), `agent_message_chunk` text, `stopReason end_turn` with 0.62's `_meta.quota` totals (the pass usage, flagged approximate) |
| G03 | `tool_call` / `tool_call_update` deduped by `toolCallId`: the edit is announced twice and updated twice, one tool start and one end; a `plan` update is logged only |
| G04 / G04b | A shell ask in autoEdit (`set_mode autoEdit`, echoed `[MODE_UPDATE] autoEdit`; a pending `tool_call`, then `session/request_permission` for the same id: one card, one ask; title the command, content the explanation). Allow → `proceed_once`; deny → `cancel` (Gemini's Reject, `reject_once`), the tool ends declined and the turn goes on (an explicit Deny lets the vendor continue). G04's session is the one G09a resumes |
| G05a | **Decides G05** (cached-token subtraction), on Gemini 0.64 (`usage`): `inputTokens` is the prompts' promptTokenCount, which includes the cached content, so Dim Factory's `input = inputTokens - cachedReadTokens`; `totalTokens` is `inputTokens + outputTokens` and cannot tell. A `usage_update` per model call and `_meta.quota` are not added on top |
| G05b | A prompt response without `usage` or `_meta` totals: the last `usage_update` (`used`, tokens in context) stands in for the input, output 0, flagged `usageApprox` (usage_update is the fallback usage source). Not a Gemini shape: the ACP base's generic path |
| G05c | Gemini 0.62 and 0.63: no `usage`, no `usage_update`, only `_meta.quota.token_count`; the pass usage is `{input: input_tokens, output: output_tokens}` (cached tokens inside the input, no split; thoughts not counted), flagged `usageApprox` (`no-cached-split`). Every other 0.62 fixture answers so too |
| G06a | Allow for this run → `proceed_always` ("Allow for this session"), never `proceed_always_and_save` ("Allow for all future sessions"); the same command then runs without an ask; the exact allow rule is recorded, keyed on the command (the title), in the folder the explanation names |
| G06b | Synthetic: the only always-option is the forbidden, persistent one, so the ask is raised with `allowSession: false` (Allow for this run hidden) |
| G06c | An MCP tool from the user's own Gemini settings: allow-session picks `proceed_always_tool` (first in optionPrefs); server and tool names redacted |
| G07 | Read-only Review: reads run unasked; a shell command and an edit each ask and are rejected by the adapter (`auto-answered`, why `readonly`). **Zero asks reach the user** |
| G08 | Native Plan (`set_mode plan`, echoed): reads and the plan file under `.gemini/tmp` run unasked (a `file` frame records the plan file); `exit_plan_mode` asks as Gemini sends it (kind `other`, titled `Requesting plan approval for: <plan file>`, no content, no always-option); the adapter reads the plan from that file (only under Gemini's own tmp folder), rejects (never approves), sends `session/cancel`; the prompt ends `cancelled` (no usage) and the pass succeeds with the plan |
| G09a | Fix resumes G04's session with `session/load` (session/resume not advertised); Gemini streams the stored history after its answer and the adapter drops every update until 400 ms of quiet (10 s cap), then re-sends `set_mode`; the pass's usage is its own report |
| G09b | An agent that advertises `sessionCapabilities.resume` is resumed with `session/resume` (no replay), then `set_mode` (the generic ACP base path; Gemini CLI 0.62 does not advertise it) |
| G09c | `session/load` of a session Gemini does not have: -32603 "Internal error" with "Invalid session identifier" in `data.details` → `resume_failed` |
| G10a | Stop with an ask pending: `session/cancel`, then the pending permission answered `{outcome: cancelled}`; the prompt ends `cancelled` → `user_cancelled` |
| G10b | Not signed in: `session/new` answers -32000 "Authentication required" → `auth_required`; Dim Factory never calls `authenticate` |
| G10c / G10d / G10e | `session/prompt` answers -32603 with a daily-quota `RESOURCE_EXHAUSTED` → `quota_exceeded`; `stopReason max_turn_requests` → `turn_limit`; `stopReason refusal` → `content_policy` |
| G11 | Context pressure and a compaction: `usage_update` `{used, size}` after each model call (the context meter: `used` of `size`, the window kept), then the unstable `CompactionUpdate` (`in_progress`, a `compaction_summary_chunk`, `completed`) and a smaller `usage_update`. ACP agents send it only to a client that advertises the `compaction` session capability, which the ACP base does not yet: the normalizer reads it if it comes. |
| GX41 … GX55 | Gemini's process exit codes: 41 auth (`auth_required`), 42 input (`flag_drift`), 44 sandbox (`sandbox_unavailable`), 52 config (`config_invalid`), 53 turn limit (`turn_limit`), 54 tool, only `NO_SPACE_LEFT` (`disk_full`), 55 untrusted folder (`trust_required`: launched without `--skip-trust`, the folder has no vendorFolder grant) |

**Fixture-gated default:**

| Fixture | Decides | Default in the code, pending live confirmation |
|---|---|---|
| G05 | Whether cached tokens are subtracted | **Subtracted**: `inputTokens` includes `cachedReadTokens` (`protocol.ts CACHED_READ_IN_INPUT_DEFAULT`, `gemini/config.ts USAGE_INPUT_INCLUDES_CACHED`): gemini-cli 0.64's buildPromptResponse sends the prompts' promptTokenCount as `inputTokens`, and the Gemini API counts the cached content in it. The report's own `totalTokens` cannot settle it (Gemini sends `inputTokens + outputTokens`); a live G05a (Gemini 0.64 or later) confirms it when `usage.inputTokens` equals `_meta.quota.token_count.input_tokens` with `cachedReadTokens > 0`. On 0.62 and 0.63 there is no split to subtract (G05c, approximate). |

## Suites

| Suite | Covers |
|---|---|
| `tests/unit/acp/protocol/` | The vendored files are the release's bytes (one documented escape edit); every method of `protocol.ts` is the schema's own on the right side; every frame of every fixture is valid for its method; the helpers (resume route, decision table, ask kinds, plan exit, usage, error words); the contract invariants and the safety rules on every fixture; the failure fixtures through the classifier; the recorder's Gemini rules; the set equals the generator's output |
| `tests/integration/acp/fixtures/` | Every fixture replayed through the real resolver, spawn and JsonRpcPeer (`header: '2.0'`; a wrong host frame exits 99, an early close 98); the fake CLI's ACP script ops; every recipe re-recorded through the recorder against the fake gives its fixture back; the Dim Factory responder gives exactly the recorded host frames; the recorder's refusals and its redaction of a real profile (fake personal values) |
| `tests/integration/acp/adapter/` | The ACP base and the Gemini adapter themselves against these fixtures |
| `tests/unit/fixtures-redaction.test.ts` | Every file here is redacted, and every agent frame is a fixed point of the recorder's Gemini rules ("Redaction") |
| `tests/integration/acp/fixtures/expected-events.dump.test.ts` | A tool, skipped unless `DUMP_IDS` is set: writes a re-recorded fixture's `expected.events.json` from what the adapter emits |

The fake CLI's ACP ops, for hand-written scripts: `rpcProtocol{jsonrpc:'2.0'}` puts the header on everything the
script writes and requires it on every client message an rpc op takes; `rpcNotify{method, params}` writes an agent
notification; `rpcRequest{method, params, as?}` an agent request (ids from 0, bound for `rpcExpectResponse`). Every
earlier op and every Codex and Claude fixture keeps its behaviour.

Regenerate after a change to the ACP base's frames (`src/core/adapters/acp-base/protocol.ts`), the responder or a
scenario:

```
node tests/fixtures/gemini/recipes/synthesize.mjs
```

## Re-recording live

Never against your own `~/.gemini`: the recorder refuses it unless told
`--allow-user-gemini-home`, and refuses a `.gemini` folder given as the home.

1. **Install and sign in an isolated profile**:
   `npm install -g @google/gemini-cli@latest`, then `mkdir %USERPROFILE%\.gemini-fixtures`, and in a terminal
   `set GEMINI_CLI_HOME=%USERPROFILE%\.gemini-fixtures` and `gemini` once to sign in. `GEMINI_CLI_HOME` is the folder
   that holds `.gemini` (Gemini's `homedir()` override in `packages/core/src/utils/paths.ts`, read on 2026-10-10). An API
   key instead goes in an env file passed with `--env-file` (only its name reaches the header).
2. **Fill in the placeholders** of `recipes/<ID>-<slug>/record.txt`: `<fixture GEMINI_CLI_HOME>` is that folder;
   `<node>` is the system node (`where node`); `<the gemini package entry .js>` is the file the npm shim runs (the last
   line of `%APPDATA%\npm\gemini.cmd` names it, under `node_modules\@google\gemini-cli\`); `<x.y.z>` is
   `gemini --version`; `<sandbox>` is a fresh `git init`-ed copy of `tests/fixtures/sandboxes/ts-small` in a scratch
   folder (never the repo or a user folder) with a neutral local git identity.
3. **Run it.** The recorder speaks JSON-RPC 2.0 (`--acp`), spawns `node <entry> --acp …` with no shell, answers every
   agent request through `responders.mjs`, and writes the redacted recording to `acp/<ID>-<slug>/`. Order: G04 before
   G09a (same sandbox; G09a takes G04's live session id with `--var` and its done usage in a scratch `pass.json`).
   `record.txt` says what a scenario needs beyond that, and which ones cannot be provoked on demand (they stay
   synthesized until observed).
4. **Review** the recording's free text (the summary on stdout gives redaction counts, never values), then add the
   scenario to `LIVE` in `recipes/synthesize.mjs` (the generator keeps writing its recipe and leaves its recording
   alone) and write its `expected.events.json` with the dump tool:
   `DUMP_IDS=<ID>-<slug> pnpm vitest run --project integration tests/integration/acp/fixtures/expected-events.dump.test.ts`.
   A live recording that differs from the synthesized one is the point: what the adapter gets wrong is an adapter fix
   with a unit test, never an edit to the recording.
5. **Run the suites**: `pnpm test`, `pnpm test:int`, `node tests/fixtures/gemini/recipes/synthesize.mjs --check`.

### Redaction

The recorder takes out of every line the CLI writes (`out`, `err`) what a signed-in profile gives away; Dim Factory's own
frames are left as sent. Two layers, as for Codex:

| What | Becomes | Where |
|---|---|---|
| tokens, emails, the home folder, the user name in paths, the host name, the sandbox, the temp folder | `<TOKEN>`, `user@example.invalid`, `~`, `user`, `host`, `<CWD>`, `<TMP>` | `src/shared/redact.ts` |
| account and install ids, and the Google Cloud project an account is billed through (`cloudaicompanionProject`, a GCP or quota project, any key spelling) | `<REDACTED>` (also in diagnostics, raw run logs and heal prompts) | `src/shared/redact.ts` `ACCOUNT_KEY_PATTERN` |
| `GEMINI_CLI_HOME` | `<GEMINI_CLI_HOME>` (your own home, when allowed, is left to the home rule: `~/.gemini/…`) | the recorder |
| a Google Cloud project given to the recorded CLI (`GOOGLE_CLOUD_PROJECT`, …, via `--env-file`) | `<REDACTED>` | the recorder |
| the project folder Gemini keeps under `.gemini/tmp` and `.gemini/history` (a hash or short name of the sandbox path) | `<PROJECT>` | `scripts/redact-gemini.mjs` |
| the quota in `_meta.quota`: plan-like text (tier, plan, project, account, user, email) and the window's numbers (reset, remaining, limit); token counts stay | `<REDACTED>` and `0` | same |
| MCP servers: a tool title `<tool> (<server> MCP Server)` and the names quoted in `proceed_always_server` / `proceed_always_tool` options | `<REDACTED> (<REDACTED> MCP Server)`, `"<REDACTED>"` | same |
| what the profile's own files name: `settings.json` MCP servers with their commands, args, URLs and env values, `GEMINI.md` lines, custom command and extension names, the install's ids | `<REDACTED>` | `profileTerms` (read in memory, never written; counts only in the summary) |

Credential files (`oauth_creds.json`, `google_accounts.json`, `mcp-oauth-tokens.json`, …) are never opened, by the
recorder or by Dim Factory (the probe checks `oauth_creds.json` for existence only). The rules on frames are pure and
idempotent, so `tests/unit/fixtures-redaction.test.ts` checks every committed recording is a fixed point of them; the
generator writes its agent frames through them too.

### Open questions a live recording settles

The review of gemini-cli's source settled what the first synthesis guessed (the table at the top): the shell
request's title and explanation, exit_plan_mode's kind and title and that it carries no plan, the `[MODE_UPDATE]` echo,
and which versions send `usage`. A live recording still confirms them, and:

- **G05**: `usage.inputTokens` against `_meta.quota.token_count.input_tokens` on 0.64 (above).
- **The plan file (G08)**: that the file the title names exists and holds the plan when the request arrives, inside
  `<GEMINI_CLI_HOME>/.gemini/tmp` (a profile with a custom `plansDir` puts it in the project instead: Dim Factory then
  reads no plan, rejects the exit and the pass fails "could not read the plan"; the recorder records no file frame).
- **The mode echo**: that `[MODE_UPDATE] <mode>` comes before set_mode's answer (the fixtures) or after it (either is
  never printed, and only a widening above the pass's mode stops the pass).
- **Deny (G04b)**: whether Gemini's Reject (`cancel`, its `ToolConfirmationOutcome.Cancel`) lets the turn go on
  or ends it.
- **Resume (G09a)**: that `session/load` streams the history after its answer, and how long it takes (the 400 ms quiet
  window); whether Gemini still sends `models` (0.62) or names models in `configOptions`.
- **Not signed in (G10b)**: whether `authRequired` comes on `session/new` or on the prompt.
- **Stop order**: the fixtures and the responder send `session/cancel` before answering the pending permissions
  `cancelled` (the ACP spec's order). The fake replay matches by message, so the adapter's own order is not checked
  here.
- Gemini's tool call ids (`<tool>-<epoch ms>` in the fixtures) and the stderr of each exit code.

## Live checks still to run (they need the real CLI; prepared, not faked)

1. **Live Gemini native Plan captured**: install and sign in as above, re-record G08 with its `record.txt` (the
   recording must hold the plan file as a `file` frame before the exit request), and run a Plan pass on Gemini from the
   app on a folder trusted for Gemini (the flow "trust a folder for Gemini"). The Plan card shows the captured plan
   ("Native plan · Gemini ACP", not "Fell back" or the final message); Gemini never leaves plan mode.
2. **Read-only Review raises zero asks live**: re-record G07 (and G02) with their `record.txt`, and run a Review on
   Gemini from the app: no ask reaches the attention panel.
3. Then the remaining recipes (G01, G03–G06, G09a, G10b, the GX codes that can be provoked), each added to `LIVE`.
