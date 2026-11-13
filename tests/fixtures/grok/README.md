# Grok fixtures

The Grok adapter's fixtures, on the shared ACP base: Grok Build over the Agent Client Protocol (`grok agent --no-leader stdio`, JSON-RPC 2.0 over stdio), replayed by the fake CLI through the real
resolver and spawn path (the fake behind an npm-style shim on Windows or a shebang copy elsewhere, standing in for the
native `grok`).

**Every fixture here is synthesized.** The Grok CLI was not available when the adapter was built, so no
fixture could be recorded live, and no xAI account or token was used. Each one is generated from the pinned ACP schema
(`src/core/adapters/acp-base/protocol/v1.25.0/`) and Grok Build's own public docs and source (below), and its header says so (`"synthesized": true`,
`synthesizedFrom`). Every scenario has a one-command live re-record recipe ("Re-recording live").

## Sources (read-only, 2026-10-11)

All from the public repository github.com/xai-org/grok-build (Apache-2.0), branch `main`, read with a web fetch on
2026-10-11; nothing was downloaded into the repository.

| What | Where |
|---|---|
| `grok agent` options (`--model`, `--always-approve`/`--yolo`, `--reauth`, `--agent-profile`, `--leader`/`--no-leader`), the stdio transport, `_meta` on session/new (`yoloMode`, `autoMode`, `rules`, `agentProfile`), configOptions (`model`, `reasoning_effort`), the x.ai/* extension table | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md |
| Permission modes, the prompt's choices ("Enable always-approve mode", "Allow all edits this session", per-project "Always allow" and "Never allow"), grants in `permission.toml`, folder trust gating repo config, `_meta.yoloMode` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md |
| Sign-in: `grok login`, `XAI_API_KEY` (used only without a session token), `~/.grok/auth.json` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md |
| Install (`%USERPROFILE%\.grok\bin`), `grok --version`, `grok update` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md |
| Exit codes 0/1/130/143, `GROK_DISABLE_AUTOUPDATER`, the headless usage keys (`modelUsage`: inputTokens, outputTokens, cacheReadInputTokens, modelCalls, costUSD; total = input + cache read + cache creation + output) | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md |
| Sessions in `$GROK_HOME/sessions/<encoded cwd>/<id>/`, UUIDv7 ids, ACP session/load | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md |
| `GROK_HOME`, `GROK_DISABLE_AUTOUPDATER`, `GROK_SANDBOX_AUTO_ALLOW_BASH` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md |
| `enter_plan_mode` / `exit_plan_mode` ask before switching | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md |
| initialize (protocol 1, loadSession, session close/list/resume, authMethods, `_meta` grokShell/defaultAuthMethodId/agentVersion), PromptResponse with usage only in `_meta` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs |
| `_meta.yoloMode` read with `as_bool()` on session/new and session/load (an explicit `false` overrides a configured default), NewSessionResponse (`models`, `configOptions`, `_meta`; no `modes`) | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs |
| The PromptResponse `_meta` keys (`totalTokens`, `modelId`, the last turn's `inputTokens`/`outputTokens`/`cachedReadTokens`/`reasoningTokens`, `usage.totalTokens`, `usage.modelUsage`) | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/prompt_response_meta_tests.rs |
| authMethods ids (`xai.api_key`, `cached_token`, `grok.com`, `oidc`), `XAI_API_KEY` and the legacy `GROK_CODE_XAI_API_KEY`, the sign-in error texts | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-shell/src/agent/auth_method.rs |
| Folder trust: no prompt over ACP stdio without the `x.ai/folderTrust.interactive` capability, so an untrusted folder's repo config (MCP, hooks, permission rules) is skipped; `GROK_FOLDER_TRUST` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-shell/src/agent/folder_trust.rs |
| A shared leader process at `~/.grok/leader.sock`, chosen from `--leader`/`--no-leader`, the config and remote settings | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-shell/src/leader/mod.rs and .../xai-grok-pager-bin/src/main.rs |
| The version line `grok <version> (<commit>) <channel>` | https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager-bin/src/main.rs |
| `cliVersion` 1.0.50 (the newest release a third-party tracker listed, 2026-10-06; secondhand, the official changelog answered 403) | https://www.havoptic.com/releases/grok-build/2026/10 |

What the sources do not say is synthesized and marked so: Grok's ACP permission option ids (the names follow the
prompt's choices), its tool call ids and tool names, and the exact `modelUsage` keys over ACP (the headless names).

## Layout

As for Gemini (tests/fixtures/gemini/README.md): `acp/<ID>-<slug>/recording.jsonl` (a header, `{t, dir, line}` frames,
the exit frame) and `expected.events.json`; `recipes/synthesize.mjs` writes both and every recipe (`--check` compares
only and runs in the unit suite); `recipes/<ID>-<slug>/{stdin.jsonl, responders.mjs, pass.json, record.txt}`;
`recipes/dim-factory-responder.mjs` answers every agent request as the ACP base does with the Grok configuration.

### Header

| Field | Value |
|---|---|
| `cliVersion` | `1.0.50` (above); a live re-record stamps the real `grok --version` |
| `protocol`, `jsonrpc` | `"jsonrpc"` and `"2.0"`: the fake replays by message |
| `argv` | `grok agent [--model <m>] --no-leader stdio` (any further agent option, such as the user's `vendors.grok.extraArgs`, goes before `stdio`: user guide 15, "Agent options ... go after `agent` but before the mode name") |
| `envKeys`, `envDrop` | `GROK_DISABLE_AUTOUPDATER` and `GROK_HOME` (an isolated profile), and `^GROK_` / `^XAI_`: the recorded CLI inherits no key, home or Grok switch from the recorder |
| `pass` | `kind` `pass`, `probe` (GR01: `force`, the Test probe) or `study` (GR03); `step`, `mode`, `prompt`, `model`; `auto` (GR05: full mode only comes from Auto); `study` |

## Scenarios

| ID | Scenario |
|---|---|
| GR01 | The Test probe (`vendor.grok.protocol`, "ACP authRequired on Test"): initialize, then session/new in Dim Factory's probe folder; no prompt, no token. loadSession and session/resume advertised; the models named by session/new (no modes: Grok has no ACP mode switch). The launch probe stops at initialize (tests/integration/grok/probe.test.ts) |
| GR01b | Not signed in, on Test: session/new answers -32000 "Authentication required"; `vendor.grok.auth` fails with `grok login` to copy |
| GR02 | Read-only Review with a picked model: session/new with the ask posture `_meta {yoloMode:false, autoMode:false}`, no set_mode; a read runs unasked; a thought, available commands and Grok's own `x.ai/session_notification` (never printed); the answer's `_meta.usage.modelUsage` is the pass usage, exact (cached reads apart) |
| GR03 | **Decides Grok autoedit.** A study of Grok's ask posture: the edit asks, and beyond "Allow once" the only grants are "Allow all edits this session" and "Enable always-approve mode", answers to an edit already asked that widen the session from inside it; no edits-only posture Dim Factory could set before the turn. The study rejects it. The adapter itself refuses an autoedit pass before spawning (its expected events) |
| GR04 | Read-only Critic: a shell command, an edit and Grok's `enter_plan_mode` each ask; the adapter rejects all three (`reject_once`, why `readonly`); zero asks reach the user; each tool ends declined and the turn goes on |
| GR05 | Full mode, only from Auto: session/new with `_meta {yoloMode:true}` (always-approve for this session only, never the `--always-approve` flag); read, edit and test run with no permission request |

**Fixture-gated default:**

| Fixture | Decides | Default in the code |
|---|---|---|
| GR03 | Grok autoedit | **Unsupported** (`src/core/adapters/grok/config.ts GROK_AUTOEDIT_SUPPORTED = false`), with the copy "Not supported until Dim Factory has seen it work". A synthesized GR03 cannot prove otherwise. It becomes supportable only if a live GR03 shows a posture that approves edits and nothing else, set before the turn (an ACP mode or a `_meta` key), and is never one of the session-wide grants Dim Factory refuses by name |

## Suites

| Suite | Covers |
|---|---|
| `tests/unit/grok/fixtures.test.ts` | The set equals the generator's output (`--check`); headers; every frame valid ACP v1.25.0 (Grok's x.ai/* as JSON-RPC only); the contract invariants; the posture, argv and option-choice safety rules; GR03's decision |
| `tests/unit/grok/redaction.test.ts` | Every agent frame is a fixed point of the recorder's Grok rules; the rules and `profileTerms` |
| `tests/integration/grok/replay.test.ts` | Every fixture through the real Grok adapter, resolver, spawn and the fake (a wrong host frame exits 99) |
| `tests/integration/grok/recorder.test.ts` | Every recipe re-recorded through the recorder against the fake gives its fixture back; the responder; the recorder's refusals and its redaction of a real profile (fake personal values) |
| `tests/integration/grok/probe.test.ts`, `passes.test.ts` | The launch probe, readiness, canResume; the child env, flags, asks, a continued session's posture, Grok's failure texts |

Regenerate after a change to the ACP base's frames, the Grok wire or the responder:

```
node tests/fixtures/grok/recipes/synthesize.mjs
```

## Re-recording live

Never against your own `~/.grok`: the recorder refuses it unless told `--allow-user-grok-home`, and refuses the home
folder itself.

1. **Install and sign in an isolated profile**: install Grok Build
   (`irm https://x.ai/cli/install.ps1 | iex` on Windows), then `mkdir %USERPROFILE%\.grok-fixtures`, and in a terminal
   `set GROK_HOME=%USERPROFILE%\.grok-fixtures` and `grok login`. An API key instead goes in an env file passed with
   `--env-file` (only its name reaches the header). GR01b needs a second, signed-out profile.
2. **Fill in the placeholders** of `recipes/<ID>-<slug>/record.txt`: `<fixture GROK_HOME>` is that folder;
   `<the grok executable>` is `%USERPROFILE%\.grok\bin\grok.exe` (or `where grok`); `<x.y.z>` is `grok --version`;
   `<sandbox>` is a fresh `git init`-ed copy of `tests/fixtures/sandboxes/ts-small` in a scratch folder (never the repo
   or a user folder). GR05 writes to its sandbox (always-approve).
3. **Run it.** The recorder spawns `grok agent … --no-leader stdio` with no shell and `GROK_DISABLE_AUTOUPDATER=1`,
   answers every agent request through `responders.mjs`, and writes the redacted recording to `acp/<ID>-<slug>/`.
4. **Review** the recording's free text (the summary gives redaction counts, never values), add the scenario to `LIVE`
   in `recipes/synthesize.mjs`, and write its `expected.events.json` from what the adapter emits. Where the live
   recording differs from the synthesized one, fix the adapter (with a unit test), never the recording.
5. **Run the suites**: `pnpm test`, `pnpm test:int`, `node tests/fixtures/grok/recipes/synthesize.mjs --check`.

### Redaction

Two layers, as for Codex and Gemini; the recorder applies them to every line the CLI writes (`out`, `err`):

| What | Becomes | Where |
|---|---|---|
| tokens, emails, the home folder, the user name in paths, the host name, the sandbox, the temp folder; account and install ids | as for every vendor | `src/shared/redact.ts` |
| `GROK_HOME` | `<GROK_HOME>` (your own `~/.grok`, when allowed, is left to the home rule) | the recorder |
| the session group folder under `<GROK_HOME>/sessions` or `.grok/sessions` (the URL-encoded sandbox path, or a slug and hash) | `<PROJECT>` | `scripts/redact-grok.mjs` |
| an SSO issuer or a custom auth provider label in `authMethods` (`oidc`, `grok.com` with a non-default name) | `<REDACTED>` | same |
| team, principal, tenant, org, issuer and client ids in any key spelling | `<REDACTED>` | same |
| what the profile's own files name: `config.toml` MCP servers with their commands, args, URLs and env values, its OIDC and auth provider settings; `AGENTS.md` lines | `<REDACTED>` | `profileTerms` (read in memory, never written; counts only in the summary) |

Credential and grant files (`auth.json`, `mcp_credentials.json`, `trusted_folders.toml`, `permission.toml`, …) are
never opened, by the recorder or by Dim Factory (the probe checks `auth.json` for existence only). `config.toml` can hold a
key too (a per-model `api_key` or `env_key`, user guide 02): every line that sets `api_key`, `env_key`, a
token, a secret or a password is dropped as the file is read (`src/core/adapters/grok/config-toml.ts`, also used by
Dim Factory's read-only allow-rules scan), so no such value is kept, matched or written; an MCP server's env values under
other names are still read in memory, to redact them.

### Open questions a live recording settles

- **GR03**: the edit's option ids and names, and whether any posture approves edits only.
- **The option ids** of every confirmation (synthesized from the prompt's choices), and whether "Enable always-approve
  mode" comes as `allow_once` or `allow_always` (either way it is refused by name).
- **Usage**: the `modelUsage` keys over ACP (the headless names were used), whether `inputTokens` excludes the cached
  reads (the total's formula decides when it can), and `costUSD` on a subscription sign-in.
- **The leader**: that `--no-leader` keeps the agent in its own process on every Grok the user may have configured.
- **Sign-in**: whether a missing sign-in fails at session/new (`authRequired`, GR01b) or at the prompt. Without
  `XAI_API_KEY` or `auth.json` the launch probe only warns (a per-model key in `config.toml` signs in too,
  and Dim Factory never reads it); Test decides.
- **Allow rules in a read-only pass**: that Grok applies the user's Claude allow rules
  (`~/.claude/settings*.json`, the project's `.claude/settings*.json`) and its own (`[permission] allow`/`rules`,
  `sandbox.auto_allow_bash`) before it asks, as user guide 22 says. Dim Factory does not run a read-only pass on Grok while
  any rule that could change files is found (readiness `grok-allow-rules`). Record GR04 once more with an `Edit` allow
  rule in the fixture profile's Claude settings: if Grok still asks, the scan can be narrowed; if the edit runs unasked,
  it is confirmed.
- **Extra agent options**: that `grok agent --agent-profile <f> --no-leader stdio` (an option before the transport) is
  accepted, and an option after `stdio` is refused.
- **Grok's own notifications** (`x.ai/*`) during a turn, and its tool call ids and names.

## Live checks still to run (prepared, not faked)

1. Install Grok Build and sign in an isolated profile (above).
2. Re-record GR02 and GR04 (the read-only passes; zero asks), GR05 (full mode), GR01 and GR01b (the Test probe), and
   GR03 (decides autoedit), each with its `record.txt`; add each to `LIVE`.
3. Run a Review on Grok from the app (picked under "More"): no ask reaches the attention panel. If your Claude or
   Grok settings allow edits or commands that can change files, Dim Factory says so instead and offers Claude for the
   Review (readiness `grok-allow-rules`).
