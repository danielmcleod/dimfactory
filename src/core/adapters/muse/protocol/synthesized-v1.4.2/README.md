# Muse `exec --json` record shapes (pinned, SYNTHESIZED)

Shapes pinned from `muse schema generate-json-schema` for the Muse exec route; the probe compares a printed schema's
hash with the pin and warns on a difference.

**Nothing here was printed by a Muse CLI.** Muse support was built without one (not installed on the dev machine; no account,
no token). The official docs do not publish the `--json` record schema, so `exec-records.schema.json` is written by hand
from the sources below. `src/core/adapters/muse/protocol.ts` (`MUSE_PIN`) keeps its sha256 (checked by
`tests/unit/muse/protocol.test.ts`) and `liveSchemaSha256: null`: until a schema printed by a real Muse is pinned, the
probe's `vendor.muse.protocol` check warns that the shapes are synthesized.

| What | Value |
|---|---|
| Target | Muse Code **1.4.2** (the latest release in the official changelog on 2026-10-11) |
| Fetched | 2026-10-11 (read-only, no account) |
| File | `exec-records.schema.json` (JSON Schema 2020-12, `x-synthesized: true`); `meta.json` lists every source |
| Live schema | none yet (`meta.json` `liveSchema: null`, `MUSE_PIN.liveSchemaSha256: null`) |

## Sources

| Source | What it gave | Kind |
|---|---|---|
| https://dev.meta.ai/docs/muse-code/extending | `muse exec` flags: `--json` (JSONL on stdout), `--prompt-file`, `--session-id`, `--disable-approval` (sandbox kept), `--yolo`, `--max-model-steps`, `--allow-workspace-switch`; exit codes 0 / 1 (failed or cancelled, also the step cap) / 2 (usage) / 130 / 143 | official |
| https://dev.meta.ai/docs/muse-code/permissions | approval modes (`on-request`, `untrusted`, `never`); `--yolo` drops approval and the sandbox and trusts the workspace; the sandbox's writes and `--sandbox-network` | official |
| https://dev.meta.ai/docs/muse-code | install commands; `muse serve` runs the session protocol and `muse schema` prints its JSON schema; default model `muse-spark-1.2` | official |
| https://dev.meta.ai/docs/muse-code/auth | `META_API_KEY` wins over a stored key and a browser sign-in; `muse auth set`, `muse logout` | official |
| https://dev.meta.ai/docs/muse-code/configuration | `~/.config/muse/settings.json` (`schema_version: 1`), `--trust-workspace`, `--model` | official |
| https://dev.meta.ai/docs/muse-code/changelog | 1.4.0: a failed exec run shows its reason on the final stderr line; a first run without a terminal names `--trust-workspace`; `--output-schema`. 1.4.2: exec returns the run's result when cleanup stalls | official |
| https://docs.rs/crate/muse-codes/0.1.4/source/src/io/mod.rs | the record envelope (`schema_version`, `id`, `stream{kind,id}`, `sequence`, `recorded_at`, `record_type`, `durability`, `causation_id`, `payload_type`, `payload_schema_version`, `payload`) and the payloads (`run.output.delta`, `run.terminal.*`, `task.lifecycle.*`, `tool.result`, `run.model.configured`, …) | community SDK, built from captured output of Muse Code 0.1.0-R708.1 |
| https://docs.rs/crate/muse-codes/0.1.4/source/test_cases/meta_tool_use.jsonl | a captured tool-use run: task lifecycle order, `tool:call_<hex>` keys, `edit_facts`, `run.terminal.completed` with the full text; no usage anywhere | community capture |
## x-assumed (no source shows them)

- **Usage.** No capture carries token counts. The adapter reads a Responses-style `usage` (the Meta Model API is
  Responses-compatible) from a model call's producer facet or from `run.terminal.*`; M02 and M04 use it.
- **A refused side effect.** `policy_decision: deny:<why>` and a task that fails before it starts (M03). The docs say
  only that `--disable-approval` never prompts and the sandbox contains what runs.
- **A failed run.** `run.terminal.failed` with a `reason` (M05). The SDK names `reason` "set on abnormal endings" and
  types `terminal` as a free string.
- **Payload `kind` words** other than `run_output_delta`, `run_terminal`, `task_lifecycle` and `tool_result`.

## Re-pinning from a real Muse

On a machine with Muse installed (any sign-in; nothing is spent):

1. `muse --version`, then `muse schema generate-json-schema` (or `muse schema`, whichever prints JSON) into a scratch
   file. The probe runs the same commands (`MUSE_SCHEMA_PROBE_ARGS`) and shows the first 12 hex digits of the sha256
   it computes (LF line endings, trailing whitespace trimmed: `protocol.ts schemaHash`).
2. If that schema describes the `exec --json` records, add it here as `schema.json` (a new `v<version>/` folder), and
   set `MUSE_PIN.liveSchemaSha256` to its `schemaHash`. If it describes only the session protocol, pin it the same way
   (the probe compares hashes, not contents) and keep this file for the exec records.
3. Re-record M01-M05 (tests/fixtures/muse/README.md "Re-recording live"); where a live record differs from the shapes
   here, fix the adapter (with a unit test), never the recording, and update this file.
