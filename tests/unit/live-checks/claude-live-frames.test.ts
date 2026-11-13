// What the live re-record (claude.exe 2.1.289, 2026-10-12) showed the Claude normalizer had to learn,
// on the committed recordings and on the frames alone:
//   - C18c: with initialize `jsonSchema`, a model that answers in text gets one CLI nudge, a user turn on the main
//     thread ("[structured-output-enforce] …"); the final message is what the model wrote after it, as the result says,
//     not both turns run together.
//   - C09c: an invalid ANTHROPIC_API_KEY now ends at once, without the ten api_retry frames, in the CLI's own words
//     ("Invalid API key · Fix external API key"); the pass reads as the api_retry path always said it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ClaudeNormalizer,
  ENV_KEY_HINT,
  envKeyMessage,
  normalizeRecording,
  otherCredentialMessage,
} from '../../../src/core/adapters/claude/normalize.ts'
import { synth } from '../../synth.ts'

const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
const recording = (id: string): string => readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8')
const cliFrames = (id: string): Record<string, unknown>[] =>
  recording(id)
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { dir: string; line?: string })
    .filter((f) => f.dir === 'out' && typeof f.line === 'string')
    .map((f) => JSON.parse(f.line!) as Record<string, unknown>)

describe('C18c (live): the CLI nudges a model that skips StructuredOutput once, then reports its text', () => {
  it('the recording: one synthetic nudge between two text turns, a success result without structured_output', () => {
    const frames = cliFrames('C18c-refresh-skips-structured-output')
    const nudges = frames.filter(
      (m) =>
        m['type'] === 'user' &&
        JSON.stringify(m['message']).includes('[structured-output-enforce]') &&
        m['isSynthetic'] === true,
    )
    expect(nudges).toHaveLength(1)
    const result = frames.find((m) => m['type'] === 'result')
    expect(result).toMatchObject({ subtype: 'success', is_error: false, result: synth('done') })
    expect(result).not.toHaveProperty('structured_output')
  })

  it('the pass ends with the text after the nudge, as result.result says', () => {
    const done = normalizeRecording(recording('C18c-refresh-skips-structured-output')).find(
      (e) => e.type === 'done',
    )
    expect(done).toMatchObject({ type: 'done', result: synth('done') })
    expect(normalizeRecording(recording('C18c-refresh-skips-structured-output'))).not.toContainEqual(
      expect.objectContaining({ type: 'meta', key: 'structuredOutput' }),
    )
  })

  it('on the frames alone: text, a user text turn, text again → only the last text is the answer', () => {
    const n = new ClaudeNormalizer({ route: 'readonly', askTimeoutMs: 1000, now: () => 0 })
    const delta = (text: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })
    const user = {
      type: 'user',
      parent_tool_use_id: null,
      isSynthetic: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[structured-output-enforce] Call the tool now.' }],
      },
    }
    for (const f of [delta('first '), delta('draft'), user, delta('final')]) n.line(JSON.stringify(f))
    const end = n.line(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final' }),
    )
    expect(end.events).toContainEqual({ type: 'done', result: 'final' })
  })
})

describe('C09c (live): an invalid ANTHROPIC_API_KEY fails at once', () => {
  it('the recording: no api_retry; the CLI’s synthetic turn and an api_error result with status 401', () => {
    const frames = cliFrames('C09c-invalid-api-key')
    expect(frames.some((m) => m['subtype'] === 'api_retry')).toBe(false)
    expect(frames.find((m) => m['type'] === 'assistant')).toMatchObject({ error: 'authentication_failed' })
    expect(frames.find((m) => m['type'] === 'result')).toMatchObject({
      is_error: true,
      api_error_status: 401,
      terminal_reason: 'api_error',
    })
  })

  it('the pass reads auth_required with the env-key words and hint, as the api_retry path does', () => {
    const entries = normalizeRecording(recording('C09c-invalid-api-key'))
    expect(entries.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: envKeyMessage(401),
      fatal: true,
      category: 'auth_required',
    })
    expect(envKeyMessage(401)).toBe(
      'API key is invalid (401). ANTHROPIC_API_KEY is set and takes precedence over your Claude login.',
    )
    expect(entries).toContainEqual({ type: 'meta', key: 'failureHints', value: [ENV_KEY_HINT] })
  })
})

describe('an auth failure names ANTHROPIC_API_KEY only when it is known to be set', () => {
  // The CLI's stderr says "ANTHROPIC_API_KEY or another auth source is set": an apiKeyHelper or an auth token may be
  // the credential that failed. Known: init's apiKeySource names the variable, or the CLI was spawned with it.
  const C09C = recording('C09c-invalid-api-key')
  const errorOf = (entries: ReturnType<typeof normalizeRecording>) => entries.find((e) => e.type === 'error')
  const GENERIC =
    '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set'
  const retry = {
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 10,
    retry_delay_ms: 2000,
    error_status: 401,
    error: 'authentication_failed',
  }

  it('C09c’s frames with only the CLI’s generic line: the other-credential words, the variable named as the CLI names it', () => {
    const entries = normalizeRecording(C09C, { apiKeyEnv: false })
    expect(errorOf(entries)).toMatchObject({
      category: 'auth_required',
      message: otherCredentialMessage(401),
    })
    expect(otherCredentialMessage(401)).toBe(
      'API key is invalid (401). A key or other credential set for Claude Code (ANTHROPIC_API_KEY or another auth source) takes precedence over your Claude login.',
    )
    expect(otherCredentialMessage(401)).not.toContain('—')
    // The hint to unset ANTHROPIC_API_KEY stays: the CLI named it as a possible source.
    expect(entries).toContainEqual({ type: 'meta', key: 'failureHints', value: [ENV_KEY_HINT] })
  })

  it('known from the recording header (the recorder set it), or from init’s apiKeySource: the variable by name', () => {
    expect(errorOf(normalizeRecording(C09C))).toMatchObject({ message: envKeyMessage(401) })
    const named = C09C.replaceAll(
      '\\"apiKeySource\\":\\"<TOKEN>\\"',
      '\\"apiKeySource\\":\\"ANTHROPIC_API_KEY\\"',
    )
    expect(named).not.toBe(C09C)
    expect(errorOf(normalizeRecording(named, { apiKeyEnv: false }))).toMatchObject({
      message: envKeyMessage(401),
    })
  })

  it('without the CLI’s line or the key: the classifier’s words', () => {
    const quiet = C09C.split('\n')
      .filter((l) => !l.includes('"dir":"err"'))
      .join('\n')
    const entries = normalizeRecording(quiet, { apiKeyEnv: false })
    expect(errorOf(entries)).toMatchObject({
      category: 'auth_required',
      message: 'Invalid API key · Fix external API key',
    })
  })

  it('the api_retry path (a CLI that still retries) reads the same; the adapter’s spawn env decides', () => {
    const fail = (env?: Record<string, string>) => {
      const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000, now: () => 0 })
      if (env !== undefined) n.noteSpawnEnv(env)
      n.stderr(GENERIC)
      return n.line(JSON.stringify(retry)).events.find((e) => e.type === 'error')
    }
    expect(fail()).toMatchObject({ message: otherCredentialMessage(401) })
    expect(fail({ ANTHROPIC_API_KEY: '' })).toMatchObject({ message: otherCredentialMessage(401) })
    expect(fail({ ANTHROPIC_AUTH_TOKEN: 'x' })).toMatchObject({ message: otherCredentialMessage(401) })
    expect(fail({ ANTHROPIC_API_KEY: 'x' })).toMatchObject({ message: envKeyMessage(401) })
  })
})
