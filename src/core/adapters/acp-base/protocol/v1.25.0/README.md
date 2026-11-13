# Agent Client Protocol schema v1.25.0 (pinned)

Used by the ACP base adapter (`acp-base/`), Gemini and Grok. The JSON schema of the Agent Client Protocol
(ACP), vendored read-only so the ACP base and the Gemini fixtures are typed and checked against a released version.

| What | Value |
|---|---|
| Source | https://github.com/agentclientprotocol/agent-client-protocol |
| Release | **Schema v1.25.0** (tag `schema-v1.25.0`, released 2026-10-09, marked Latest) |
| Files | `schema/v1/schema.json`, `schema/v1/schema.unstable.json`, `schema/v1/meta.json`, `schema/v1/meta.unstable.json`, and the repository's `LICENSE` |
| Raw URL | `https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/schema-v1.25.0/<file>` |
| Fetched | 2026-10-10 (read-only, no account) |
| License | Apache License 2.0 (`LICENSE`, verbatim) |
| Protocol version | `1` (the `protocolVersion` integer of `initialize`) |

## Files

| File | Upstream sha256 | Committed sha256 |
|---|---|---|
| `schema.json` | `4bcd1d2051ff7ed379bd9b234fb9b09c5ab9245478698e9fab805bd9b52a33a6` | `04adc98acc3607bd153148e4fba7ce09faefa1a96c0ed9befd1937567c7abcd0` |
| `schema.unstable.json` | `5d89e96761e4312d9043ecd41d5be1ba9adc81d02c402bb774b79ef38bc32d91` | `09c298f30814afec037501e49fe0ed6e8231f5dfc7fdde15e73c73fa74301ef5` |
| `meta.json` | `061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88` | same |
| `meta.unstable.json` | `2c85c87aeedbd10bdac671b2f9274666e2833d38b8835decb741ca19a9d7fc5f` | same |
| `LICENSE` | `f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221` | same |
| `types.ts` | (hand-written here) | |

**The one edit.** Each schema file holds two em dashes (U+2014) in descriptions. The repository's UI-copy guard
(`tests/unit/ui-standards/no-em-dash.test.ts`) reads every `.json` under `src/` as text, so the two characters are
written as the JSON escape `—`. The parsed JSON is identical, and replacing each `—` escape with the
character gives the upstream bytes back: `tests/unit/acp/protocol/methods.test.ts` checks both hashes above.
Nothing else was changed (LF line endings, as upstream).

## What Dim Factory uses

- `schema.json` is the stable protocol. `schema.unstable.json` adds what is "not part of the spec yet"; Dim Factory
  reads two of its fields: `PromptResponse.usage` (per-turn token usage) and the `Usage` type.
- `types.ts` is written by hand from the two schemas, for the subset the ACP base sends, answers or reads, plus the
  fields Gemini CLI 0.62 still sends from an earlier unstable draft that v1.25.0 no longer has: `models`
  (`SessionModelState`) on `session/new` / `session/load`, and the `session/set_model` method. Those are marked in
  `types.ts`; the schema allows them (no `additionalProperties: false` anywhere).
- `../../protocol.ts` holds the method table (required: `initialize`, `session/new`, `session/prompt`,
  `session/cancel`, `session/update`, `session/request_permission`; optional: `session/load`, `session/resume`,
  `session/set_mode`, `session/set_model`, `session/set_config_option`), the capability helpers and the wire
  builders. Its unit tests check every entry against these files (`x-method` / `x-side` of each definition).
- JSON-RPC framing: NDJSON with the `"jsonrpc": "2.0"` header on every message (`JsonRpcPeer` `header: '2.0'`).
  Agent request ids start at 0 (the TypeScript SDK's counter), the host's own at 1.

## Updating

A newer schema gets its own folder (`v<x.y.z>/`) with the same five files, the same escape edit, this README's
table, and `protocol.ts` `ACP_SCHEMA_VERSION` / `ACP_PROTOCOL_FOLDER` pointed at it. The old folder stays until no
fixture names it.
