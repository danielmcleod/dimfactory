# Muse fixtures (`muse exec --json`)

The Muse adapter's fixtures (`exec`, no relay, Experimental): the scenarios M01-M05. Layout:
`exec/<ID>-<slug>/{recording.jsonl, expected.events.json}` and `recipes/<ID>-<slug>/{prompt.md, pass.json, record.txt}`.

## Every fixture is SYNTHESIZED

The adapter was built without the Muse CLI: no Muse process ran, no account was used and no
token was spent. `recipes/synthesize.mjs` writes every file here (`node tests/fixtures/muse/recipes/synthesize.mjs`;
`--check` runs in the unit suite, `tests/unit/muse/contract.test.ts`). Each header says `"synthesized": true` and names
its sources in `synthesizedFrom`. The record shapes are the pinned ones in
`src/core/adapters/muse/protocol/synthesized-v1.4.2/` (its README has the sources, URLs and the fetch date,
2026-10-11):

- **Official** (dev.meta.ai/docs/muse-code: extending, permissions, auth, configuration, changelog): the flags, exit
  codes, `--disable-approval` keeps the sandbox, `--yolo` drops approval and sandbox and trusts the workspace, a failed
  run's reason on the last stderr line (1.4.0).
- **Community SDK** muse-codes 0.1.4 (docs.rs; its types and `test_cases/` were captured from Muse Code
  0.1.0-R708.1): the record envelope, the payloads, the order of a tool task's lifecycle.
- **x-assumed** (no source shows them; each fixture's `note` says which it uses): usage (M02 per model call on the
  producer facet, M04 on the terminal record), a refused side effect (M03 `policy_decision: deny:network_restricted`
  and a task that fails before it starts), a failed run's terminal record (M05 `run.terminal.failed` with `reason`).

Every record goes through the recorder's Muse rules (`scripts/redact-muse.mjs`), so a synthesized record looks as a
live recording would: a model call's provider `request_id` / `response_id` read `<REDACTED>`.

| ID | Scenario | Pass | Ends |
|---|---|---|---|
| M01 | plain exec: the session, the model, deltas, `run.terminal.completed` (no usage, as captured) | Implement, autoedit | done |
| M02 | edits and an in-sandbox command under `--disable-approval` (write_file with `edit_facts`, bash) | Implement, autoedit | done, usage summed over 3 model calls |
| M03 | an escalation (a network command) fails under `--disable-approval` with the sandbox's network off (`--sandbox-network restricted`, which Dim Factory passes on autoedit): a declined tool row, no ask, the run goes on | Implement, autoedit | done |
| M04 | `--yolo` full mode (Auto only): a network command and an edit run unasked | Implement, full | done, the terminal record's usage |
| M05 | not signed in: `run.terminal.failed` and the reason on stderr, exit 1 | Implement, autoedit | error `auth_required` |

## Recording format

As the Codex exec fixtures (tests/fixtures/codex/README.md), plus one frame:

- `{"dir":"promptFile","argvPath":"--prompt-file","content":…}` first: the prompt file Dim Factory writes under
  `runs/<id>/prompts/<step>-muse-<n>.md` before the spawn (never argv). The fake CLI reads the file the argv names and
  exits 99 when it differs (`tests/fake-cli/fake-cli.mjs replayPromptFile`). The header's argv names it
  `<PROMPT_FILE>`.
- `{"dir":"eof"}` next: the adapter closes stdin at once (nothing is written to it).
- `out` frames are records, one per line; `err` frames stderr lines; one `exit`.

The header's `pass` is how Dim Factory ran the pass (`step`, `mode`, `trustFolder`, `prompt`); the replay suite
(`tests/integration/muse/replay.test.ts`) turns it into StartOptions. `expected.events.json` follows the Codex
precedent: the normalized events and the signals the scenario is about (here `modelUsed`), each partial (no tool
summary, no error message).

## Re-recording live

On a machine with Muse installed (`irm https://dev.meta.ai/install.ps1 | iex` or
`curl -fsSL https://dev.meta.ai/install.sh | sh`):

1. A fresh `git init`-ed copy of `tests/fixtures/sandboxes/ts-small` per scenario (never a real project; M04 runs with
   no sandbox at all).
2. An env file with `META_API_KEY=…` (an API key always wins over a stored sign-in, so your own sign-in is not
   what the recording uses; only the key's name reaches the header).
   An isolated home: `mkdir %USERPROFILE%\.muse-fixtures` and pass it as `--muse-home`. Muse has no
   profile-folder variable, so the recorder points `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME` (`<dir>/.config`),
   `APPDATA` and `LOCALAPPDATA` (under `<dir>/AppData`) at it: Muse then loads that folder's `.config/muse` (its MCP
   servers, plugins, hooks, skills and remembered permission profile), never your own `~/.config/muse`, which the
   recorder refuses unless `--allow-user-muse-home`. The folder becomes `<MUSE_HOME>` in the recording, and what its
   `settings.json` and `AGENTS.md` name is redacted too (read in memory, never written; the summary gives counts). A
   separate OS user works as well. Keep the isolated profile bare (no MCP servers or plugins) unless a scenario needs
   them.
3. Each scenario's `recipes/<ID>-<slug>/record.txt`, with the placeholders filled in (the muse executable, the sandbox,
   the env file, `<repo>`). `--timeout 900000` bounds a run that waits on an approval (M03: Muse 1.3 was reported to
   hang there; a hang is the finding, not a recording to keep).
4. Review the recording's free text (the summary gives redaction counts only), add the scenario to `LIVE` in
   `recipes/synthesize.mjs`, and write its `expected.events.json` from what the adapter makes of it.
5. `pnpm test`, `pnpm test:int` and `node tests/fixtures/muse/recipes/synthesize.mjs --check`.
6. Where a live record differs from the synthesized one, fix the adapter (with a unit test), never the recording, and
   update the pin (`src/core/adapters/muse/protocol/…/README.md` "Re-pinning").

## Open questions (settled by the live recordings)

- Where exec reports usage, if at all (M02, M04). Until then a Muse pass may have no usage, and its cost reads "none".
- What a refused escalation looks like on the wire under `--disable-approval` (M03), and whether 1.4.2 still waits.
- `run.terminal.*` words other than `completed`, and how `--max-model-steps` ends a run (`cancelled` with a reason?).
- Whether exec reads piped stdin (Dim Factory closes it at once) and whether `--session-id` with an unused id starts a
  session (resume stays off: `capabilities.resume: 'none'`, Fix always starts fresh).
- Whether `muse schema` (or `schema generate-json-schema`) describes the exec records or only the session protocol.
- **A remembered permission profile versus the flags.** Muse remembers permission selections and has an
  Unrestricted profile ("no approval and no sandbox"); the docs do not say whether `permissions.default_profile` (or a
  remembered selection) outranks `--disable-approval`. M02's recipe records it twice, the second time with the isolated
  profile set to start Unrestricted: if that run writes outside the sandbox, the adapter must refuse or pin the sandbox.
  Until then the autoedit copy says Dim Factory cannot check it.
- **The network on autoedit.** Dim Factory passes `--sandbox-network restricted` ("no network access"), so
  the copy's "no network" holds by construction; the probe fails (flag_drift) when `exec --help` lacks the flag. M03
  shows what a refused connection looks like on the wire (a policy deny, or a command that simply fails), and whether
  exec takes `--sandbox-network` at all.
