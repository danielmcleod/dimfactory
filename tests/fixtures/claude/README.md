# Claude Code fixtures

The Claude adapter's fixtures: `claude.exe` 2.1.289 (win32, recorded with a logged-in claude.ai account) over
`--input-format stream-json`, recorded with `scripts/record-fixture.mjs` and published synthesized ("Synthesized from
live recordings" below). C18b, C19 and C23s were never recorded: their own recipes generate them (below).
`C04e-ask-deny-twice` is an earlier recording of C04b's scenario: there the model asked again after the first deny,
which a later recording's model no longer does (C04b), and E04's deny-twice flow needs two denied asks.

| Path | What |
|---|---|
| `stdio/<ID>-<slug>/recording.jsonl` | Header (argv, envKeys, envDrop), then `{t, dir, line}` frames, then the exit frame |
| `stdio/<ID>-<slug>/expected.events.json` | What the adapter's normalizer makes of the recording (regenerated, never hand-edited) |
| `recipes/<ID>-<slug>/stdin.jsonl` | The paced stdin script the recording was made with (`$wait`/`$sleep`/`$close`/`$kill`) |
| `recipes/<ID>-<slug>/responders.json` or `responders.mjs` | Automatic answers to `can_use_tool` (none = no host or no asks expected) |
| `meta/*.txt` | `claude --version`, `--help` (the source of `CLI_FLAGS`) and `auth status` variants, redacted (the signed-in ones synthesized: plan "example", "Example Organization") |

## Synthesized from live recordings

Every recording under `stdio/` except C18b, C19 and C23s was recorded live with claude.exe 2.1.289 and then rewritten
by `scripts/synthesize-fixtures.mjs` (its header comment has the exact rules): ids become fake `fa4e…` ids of the same
shape, times move so `recordedAt` is 2030-01-01, account, plan, organization and rate-limit details and the
account-specific tools and commands are replaced, and all model text and tool output becomes fake words of the same
length (code tokens kept). The protocol, the CLI's own messages, token counts and the host frames stay as recorded.
Each header keeps `cliVersion` and says `"synthesized": true` with a `synthesizedFrom` note. The same script rewrites
C10b's `script.jsonl` and the signed-in `meta/auth-status*.txt`.

The live originals are kept in `tests/fixtures-private/`, which is not published. `scripts/check-fixtures.mjs` and
`tests/unit/fixtures-synthesized.test.ts` fail when a published recording is not synthesized or carries account data
or live model text. Regenerate after a change to the originals or the script:

```
node scripts/synthesize-fixtures.mjs            # --only <ID>,<ID> for some, --check to compare only
pnpm exec vitest run --project unit tests/unit/adapters/claude.normalize.test.ts -u
```

then the generated recipes that build on them (C23s reads C23a). Locally, `DIM_FACTORY_LIVE_FIXTURES=1` runs the
normalizer snapshot test on the private live recordings and their own `expected.events.json` instead
(`tests/live-fixtures.ts`).

## Redaction

The recorder redacts with the shared rules (`src/shared/redact.ts`: tokens, emails, account and organization keys, the
home folder, the user name, the host, the sandbox as `<CWD>`, the temp folder as `<TMP>`) plus, for `--vendor claude`,
the Claude profile rules of `scripts/redact-claude.mjs` on every line the CLI writes:

- **Protocol rules** (the frame alone): in the initialize reply (and a `commands_changed` push) every command the CLI
  does not mark `builtin` (the user's own skills, the skills claude.ai syncs to the account), every subagent and
  output style that is not one of the CLI's own; in `system/init` the namespaced skills and commands
  (`plugin:skill`), the subagents that are not built in, plugins not loaded from `builtin`, MCP server names and MCP
  tools; hook frames' names and output; an MCP tool's id and input anywhere; a subagent type that is not built in (the
  Agent tool's input, the result's `subagent_stats.by_type`); a plan-limit event's reset times and billing flags (0 and
  false, as Codex's quota rule). What is never personal stays: the CLI's own commands and agents, `models`, the
  subscription tier, utilization.
- **Profile terms** (`--claude-config <dir>`, default the recorded CLI's `CLAUDE_CONFIG_DIR`, else `~/.claude`): the
  names of the user's skills, commands, subagents, output styles and plugins (exact in the CLI's listings, as whole
  words in free text when hyphenated or namespaced and 8 characters or more), and verbatim the hook and status-line
  commands, settings env values, the synced skills' and plugins' folder (named by the account's ids) and each of those
  ids on its own (a frame can name the organization or the account alone), and the user's `CLAUDE.md`
  lines. Read in memory only; `.credentials.json` and `.claude.json` are never opened. The commands and agents the
  initialize reply does not mark built in are learned from the stream too; a name it marks built in is never taken.
- **Checks:** `tests/unit/fixtures-redaction.test.ts` holds every committed Claude CLI frame to be a fixed point of the
  protocol rules, and every plain skill or command name in `system/init` to be one the same recording's initialize
  reply marks built in. Before keeping a re-record, also grep the files for the OS user name (streamed deltas can
  split it) and for the profile's own names.

## Re-recording one scenario

Run each scenario in a fresh `git init`-ed temp copy of `tests/fixtures/sandboxes/ts-small` (committed with a fixed
identity), never in the repo. Take the argv from the recording header (`<CWD>` is never in argv), the env from
`envKeys`, and drop the inherited desktop-session variables. The live recording goes to the private folder, never to
`tests/fixtures/`:

```
node scripts/record-fixture.mjs --bin <claude.exe> --cwd <sandbox> --out tests/fixtures-private/claude/stdio/<ID>-<slug> \
  --vendor claude --route stdio --id <ID> --slug <slug> --cli-version <x.y.z> --timeout 900000 \
  --env-drop "^(CLAUDE|CLAUDECODE|NODE_OPTIONS)" --env-drop "^ANTHROPIC_" \
  --redact-literal <account uuid> --redact-literal <org uuid> --redact-literal <org name> \
  --redact-literal <git user.name> --redact-literal <sandbox path with non-alphanumerics replaced by '-'> \
  --stdin tests/fixtures/claude/recipes/<ID>-<slug>/stdin.jsonl [--responders .../responders.json|.mjs] \
  [--env KEY=VALUE]... [--keep-stdin (C10b)] [--claude-config <dir>] -- <argv from the header, minus the binary>
```

- C08a/C08b share one sandbox and one session UUID (the header's; it is new in a new sandbox's project folder).
  C08c/C08d use a never-used UUID. C08e combines a fresh `--session-id` with C08a's UUID.
- C08d and C09a set `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`. C09a and C09b set `CLAUDE_CONFIG_DIR` to an empty temp
  folder (logged out by construction, whatever the machine's login). C09c sets `ANTHROPIC_API_KEY` to an obviously
  invalid key. C14c sets `CLAUDE_CODE_GIT_BASH_PATH=C:\nonexistent\bin\bash.exe`. C10b passes `--keep-stdin`, and its
  `script.jsonl` (the stop test) is `scripts/fixture-to-script.mjs` of the recording with the tail edit its header
  comment describes.
- The refresh fixtures (C17, C18a, C18c, C18d) take the refresh's argv and env: `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`
  and `CLAUDE_CODE_EVAL_CONFINED=1` (`claudeEnv` with `confined`). C17's and C18a's `stdin.jsonl` carry the prompt
  `renderRefreshPrompt` renders for a first refresh (vendors `['claude']`, the seed prices, no models.json, the
  recording day as today) and, C17 only, the refresh's output schema in initialize. In the recordings that prompt reads
  `<REDACTED>` (pass the prompt as a `--redact-literal`): it carries the catalog and the date of the moment, and every
  replay and job test sends its own. C18c's and C18d's short prompts are recorded as sent.
- After recording: `node scripts/fixture-to-script.mjs` where a test needs a script, the greps above, then
  `node scripts/synthesize-fixtures.mjs --only <ID>` and the snapshot update ("Synthesized from live recordings"),
  `pnpm exec vitest run --project unit tests/unit/fixtures-redaction.test.ts tests/unit/fixtures-synthesized.test.ts`.

## C17, C18 (catalog refresh)

| Fixture | Scenario |
|---|---|
| `C17-refresh-structured-output` | The refresh (`dontAsk`, `--tools WebSearch,WebFetch`, `--allowedTools WebSearch,WebFetch(domain:<official host>)…`) with the refresh's output schema in initialize `jsonSchema`: 16 page fetches, all on platform.claude.com, no web search, one `Bash` call the CLI refuses ("No such tool available"), then the `StructuredOutput` tool; the answer in `result.structured_output` (and its JSON text in `result.result`). |
| `C18a-refresh-fenced-fallback` | The same prompt and an initialize **without** `jsonSchema`: what a CLI that ignores the schema does on the wire (no `StructuredOutput` tool, `init.tools` [WebFetch, WebSearch]). The answer is the fenced JSON block of the final message. |
| `C18b-refresh-structured-retries` | **Generated, never recorded** (its own recipe): the answer never matches the schema, `error_max_structured_output_retries`, terminal reason `structured_output_retry_exhausted`, exit 1 → `stream_malformed`. Retries exhausted could not be provoked live: C18c and C18d are the two attempts. |
| `C18c-refresh-skips-structured-output` | Provoked (the model is told not to call any tool): one `[structured-output-enforce]` user turn from the CLI, the model answers in text again, and the result is a success **without** `structured_output`. |
| `C18d-refresh-invalid-structured-output` | Provoked (the model is told to send `{"generatedAt":"today"}` and never change it): three `StructuredOutput` calls rejected with "Output does not match required schema: root: must have required property 'entries', …", one nudge, then a success without `structured_output`. |

- **C18b's sources:** `@anthropic-ai/claude-agent-sdk` 0.3.289 (`sdk.d.ts`) (`SDKResultError` subtype
  `error_max_structured_output_retries`, `TerminalReason` `structured_output_retry_exhausted`) and the frame shapes of
  the recorded C01, C02, C05a and C16. Its prompt is `<REDACTED>` (the replay accepts any text); its argv and initialize
  `jsonSchema` are exact (`tests/unit/catalog-refresh/job/argv-prompt.test.ts` checks every C17/C18 fixture against the code).
  Regenerate after a change to the refresh schema or flags:
  `node tests/fixtures/claude/recipes/C18b-refresh-structured-retries/synthesize.mjs`, then
  `pnpm exec vitest run --project unit tests/unit/adapters/claude.normalize.test.ts -u -t "C18b"`. A change to the schema
  or flags also means re-recording C17, C18a, C18c and C18d.
- **The confinement checklist, answered live** (the probe notes stay with the private live recordings):
  - `StructuredOutput` runs under `dontAsk` with `--tools` and no allow rule (C17).
  - `init.tools` is exactly WebFetch, WebSearch, StructuredOutput with the schema, WebFetch and WebSearch without it.
  - With `CLAUDE_CODE_EVAL_CONFINED=1` a fetch off the list (example.com), a built-in preapproved host
    (docs.python.org) and a fetch under a bare `"allow": ["WebFetch"]` rule (given with `--settings` for that probe) are
    all denied under `dontAsk` without a prompt (`permission_denied`, `decision_reason_type` `mode`); without the
    variable the preapproved host and the bare rule are fetched. The variable still confines.
  - The retries-exhausted text: not provoked (C18c, C18d); C18b keeps the SDK types' reading.
  - The model called `StructuredOutput` in C17 although the refresh prompt says "Do not use any other tool"; when a model does
    not (C18c, C18d), the result has no `structured_output` and the job falls back to the final message's JSON, which
    there is none of (a failed job, `stream_malformed`).
  - A login that depends on a settings `env` still works in the refresh: under the variable a settings `env` is still
    applied, both from `--settings` and from a `settings.json` in the CLI's config folder (a base URL that cannot
    answer was used in both; probes against a scratch config folder).

## C19 (Research)

| Fixture | Scenario |
|---|---|
| `C19-research-web` | **Generated, never recorded** (its own recipe): Research before Plan with web search (`dontAsk`, `--tools Read,Glob,Grep,WebSearch,WebFetch`, `--allowedTools WebSearch,WebFetch`, the refresh's confinement env `CLAUDE_CODE_EVAL_CONFINED=1`, the research output schema in initialize `jsonSchema`): it reads `package.json`, searches once, fetches one page, then answers with the `StructuredOutput` tool; the cited answer is in `result.structured_output` (and its JSON text in `result.result`). |

- **C19's sources:** the recorded refresh C17 (the same confined read-only route) with Research's own tool set; the
  argv and the initialize `jsonSchema` are exact (`tests/unit/research/c19-fixture.test.ts` checks them against the
  code). Research was never recorded live; the one assumption a live recording would settle is that init.tools lists
  Read, Glob and Grep beside the web tools. Regenerate after a change to Research's schema or flags:
  `node tests/fixtures/claude/recipes/C19-research-web/synthesize.mjs`, then
  `pnpm exec vitest run --project unit tests/unit/adapters/claude.normalize.test.ts -u -t "C19"`.

## The None level

The None level turns Claude's skills off (`--disable-slash-commands`, on every route but the catalog refresh and
Research, whose `--tools` lists no Skill tool) and its hooks in Claude's own plan mode
(`{"useAutoModeDuringPlan":false,"disableAllHooks":true}`), and a read-only or plan pass runs without the subagent
tool (`Agent` in `--disallowedTools`) when the user, the project or an enabled plugin defines custom subagents.
C02, C06, C06b, C11b, C12a, C12b and C13 are recorded with the argv the adapter sends today
(`tests/unit/adapters/claude.extensions-live.test.ts` holds each header's argv to `buildArgv`), with the same CLI.
Against their earlier recordings the behaviour changed in three places, and the tests that pin it say so: C12a's first
model call now reads both files in one message, C06's plan file has a new name, and C13's prompt now names the
`general-purpose` subagent (on a profile with custom subagents the model may otherwise pick one of them). C13 is
recorded without the subagent cut: it records a built-in subagent's frames, as a profile with no custom subagent runs
them.

C07 and C07b (Claude's own plan mode without a host) were not re-recorded: the adapter's plan route always has its host
(`--permission-prompt-tool stdio`), so no argv it sends today matches them. They stay as the record of a hostless plan
pass's final-message plan (the plan-file hygiene tests).

Checked without tokens on 2.1.289: with `--disable-slash-commands` the initialize reply lists
no command, `system/init` lists no skill and no slash command, and `Skill` is gone from `init.tools`, while an
initialize `skills: []` (the Allowed list's filter) keeps every skill and the Skill tool; `--disallowedTools Agent`
removes the subagent tool (`Task` in `init.tools`).

## C20 to C22 (Extensions)

Each runs in the usual sandbox with the recipe's `sandbox/` folder copied over it (a project subagent, a tiny stdio MCP
server with one harmless `echo` tool). Prompts are a line each; haiku wherever it shows the behaviour.

| Fixture | Scenario |
|---|---|
| `C20a-custom-agent-bypass-readonly` | Read-only route (`dontAsk`), recorded **without** the subagent cut on purpose: a project subagent with `permissionMode: bypassPermissions` and `tools: Bash, Write` is told to write two files. Its Bash call is denied (`permission_denied`, `decision_reason_type` `mode`, with its `agent_id`), Write is not a tool it has ("disabled for this session, in subagents as well"), nothing is written. The CLI ran it in the background, so the main thread answers twice. |
| `C20b-custom-agent-bypass-plan` | The same subagent in Claude's own plan mode with a host (C06's responders): its Write and Bash still come to the host as `can_use_tool` (`mode` and `other`), which denies them as a read-only pass. Asked for haiku, the CLI ran the plan turn on sonnet. |
| `C21a-mcp-dontask-denied` | Read-only route at Allowed list (`--strict-mcp-config --mcp-config mcp/servers.json`, the echo server): the server connects, and `dontAsk` denies its tool (`permission_denied`, `mode`). |
| `C21b-mcp-run-without-asking` | The same with the server's Run without asking (`--allowedTools mcp__probe-echo__*`): the tool runs and returns `hi`. |
| `C22a-connectors-listed` | The connector listing: the probe's handshake with strict MCP off, initialize and two `mcp_status` (no user message, no tokens). The signed-in account's claude.ai connectors come back with scope and source `claudeai` and a `claudeai-proxy` config; pending at first, then connected (with tools) or needs-auth. |
| `C22b-connectors-strict-none` | The same with `--strict-mcp-config`: `mcp_status` lists nothing, so a strict session never fetches the connectors. |
| `C22c-connector-explicit-strict` | Strict MCP with `ENABLE_CLAUDEAI_MCP_SERVERS=false` and one connector passed explicitly as a `claudeai-proxy` server in `--mcp-config`: it connects (source `dynamic`) with its tools. |
| `C22d-connector-allowed-pass` | A read-only pass at Allowed list with that connector in its config file: `system/init` lists it connected and its tools; the one-word answer uses none. |

- **Redaction:** an `mcp_status` reply loses each server's name, definition (a connector's address and id), server info,
  error and tools (its status, scope, source and config type stay); `system/init` already loses MCP server names and
  tools. The connector recordings' `mcp/servers.json` held a listed connector's definition and is not committed (the
  recipes say where it came from); the echo server's is.
- **Findings:** a custom subagent's own `permissionMode` does not escape a read-only pass (C20a, C20b); the cut stays
  because a custom subagent is the user's own extension (prompt, model, tools, MCP servers), which None and Allowed list
  leave out. `dontAsk` denies every MCP tool without an allow rule (C21a), so an allowed server is usable on a read-only
  pass only with its Run without asking opt-in (C21b). Connectors are fetched only with strict MCP off (C22a, C22b), and
  such a session also starts every MCP server of the user, the folder and the enabled plugins, so Dim Factory lists
  them only where none would start; one passed explicitly connects under strict MCP (C22c, C22d). A subagent with its
  own MCP server in its frontmatter was probed too: its server never started, with or without strict MCP, so what such
  a server could do stays unrecorded.

## C23, C24 (context and compaction)

Recorded with the same CLI (2.1.289), haiku, each in a fresh sandbox. No `expected.events.json` is hand-written: the
normalizer test writes it.

| Fixture | Scenario |
|---|---|
| `C23a-compact-manual` | Edit route (C08a's argv with haiku and a new session id): one turn reads `src/index.ts`, then a second user message `/compact`. The CLI sends `system/status` `compacting`, then `system/status` with `status: null` and `compact_result: "success"`, a new `system/init`, then `system/compact_boundary` with `compact_metadata` `{trigger: "manual", pre_tokens, post_tokens, cumulative_dropped_tokens, duration_ms, preserved_segment, preserved_messages}`, the summary as a user message and a `result` with no usage of its own (`total_cost_usd` is the session's running total). The main thread's `assistant` frames repeat one `message.usage` for every content block of the same `message.id`. |
| `C23b-context-usage` | Read-only route at Allowed list (C21a's argv and echo server, skills on): a `get_context_usage` control request with `detail: "summary"` right after the user message, and another after the `result`, before stdin closes. Both are answered (the first before the first model call, the second before the exit). |
| `C23s-compact-auto` | **Generated, never recorded** (its own recipe) from C23a's frames: an automatic compaction (`trigger: "auto"`, pre 167,210, post 31,020) inside one turn, between its first request (raised near the 167,000 auto-compact threshold C23b reports) and its second (small, as a compaction leaves it), then the result. An automatic compaction costs far more tokens than a fixture should. Regenerate after C23a is synthesized again: `node tests/fixtures/claude/recipes/C23s-compact-auto/synthesize.mjs`, then the normalizer test with `-u -t "C23s"`. |
| `C24a-compaction-reminder` | The post-compaction reminder: C23a's turns on the edit route with `--settings {"disableAllHooks":true}` (the Allowed list and None levels), initialize registering a `SessionStart` hook (`hookCallbackIds: ["compaction-reminder"]`, no matcher). After `/compact` the CLI sends `hook_callback` with `input.source: "compact"` before `compact_boundary`; the recorded answer carries `hookSpecificOutput.additionalContext` with a codeword, and a third user message asking for it gets the codeword back: the context reaches the model (the hook fires with user hooks off too). No startup callback came. |

- **How Dim Factory uses them:** C23a is checked through the normalizer only (a pass never sends `/compact`; the
  adapter replay skips it). C23b replays through the adapter with `StartOptions.contextBreakdown`, the option that sends
  those two requests. C23s replays as an ordinary Implement pass, and the run-level tests and E2E use it for the
  context meter's states. C24a is checked through the normalizer (its third turn is the check, which a pass never sends);
  tests/integration/adapters/claude.compaction-reminder.test.ts drives the adapter's hook answers with its frame shapes.

- **What `detail: "summary"` answers** (both replies): `categories` (name, tokens, color, kind, `isDeferred`), `totalTokens`,
  `maxTokens`, `rawMaxTokens`, `autocompactSource` (not in the pinned SDK types), `percentage`, `gridRows`, `model`,
  `memoryFiles` (none in this sandbox), `mcpTools` (name, `serverName`, tokens, `isLoaded`: the echo server's tool is
  deferred), `agents` (`agentType`, source, tokens), `slashCommands`, `skills` (`totalSkills`, `includedSkills`, tokens,
  `skillFrontmatter` with name, source and tokens per skill), `autoCompactThreshold`, `isAutoCompactEnabled`,
  `messageBreakdown`, and `apiUsage` (null before the first model call). There is no `systemPromptSections`,
  `systemTools` or `deferredBuiltinTools`. So summary detail still attributes tokens per skill, per MCP tool and
  server, per memory file and per agent.
- The reply after the `result` reads fewer tokens than the one before the model call (35,309 against 38,436: its
  `Messages` category is 13 tokens), although `messageBreakdown` lists the turn's tool call and result.
- **Redaction:** the reply's skill names that are not `built-in`, MCP server names (`serverName`) and memory file paths
  outside the sandbox are taken out (`scripts/redact-claude.mjs`, the context-usage rule; token counts, sources and
  types stay), and so is every thinking block's `signature` (an opaque token that carries the organization id in
  base64).
- A `/compact` before any model call (seen in two C23a attempts that were not kept) answers `status: null`,
  `compact_result: "failed"`, `compact_error: "Not enough messages to compact."` with no `compact_boundary`.