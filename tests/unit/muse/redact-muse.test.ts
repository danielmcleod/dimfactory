// The recorder's Muse rules (scripts/redact-muse.mjs: deterministic redaction): the
// provider's request and response ids, the profile's plugin and MCP server names. Pure and idempotent, every value
// keeps its type, and every committed Muse record is a fixed point (as the Codex and Gemini fixtures are of theirs).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MUSE_ENV_DROP,
  MUSE_PROMPT_FILE,
  redactMuseText,
  redactMuseValue,
} from '../../../scripts/redact-muse.mjs'

const FIXTURES = fileURLToPath(new URL('../../fixtures/muse/exec/', import.meta.url))

describe('redactMuseValue', () => {
  it('redacts a producer facet’s request and response ids, nowhere else', () => {
    const record = {
      payload: {
        event: {
          details: {
            facets: [
              { kind: 'external_attempt', attempt: 1 },
              {
                kind: 'producer',
                detail: { kind: 'provider', request_id: 'r-1', response_id: 'resp_2', model: 'm' },
              },
            ],
          },
        },
        request_id: 'not-a-producer-id',
      },
    }
    const r = redactMuseValue(record)
    expect(r.counts).toEqual({ 'muse-provider-id': 2 })
    const v = r.value as typeof record
    const producer = v.payload.event.details.facets[1] as { detail: Record<string, unknown> }
    expect(producer.detail).toEqual({
      kind: 'provider',
      request_id: '<REDACTED>',
      response_id: '<REDACTED>',
      model: 'm',
    })
    expect(v.payload.request_id).toBe('not-a-producer-id')
  })

  it('redacts plugin and MCP server names in any string, keeps the rest of the name', () => {
    const r = redactMuseValue({
      a: 'reminder.agent.plugin:acme-tools:skill-reminder',
      b: 'tool.mcp__corp_db__query',
      c: ['tool:mcp__x__y', 42, true, null],
    })
    expect(r.value).toEqual({
      a: 'reminder.agent.plugin:<REDACTED>:skill-reminder',
      b: 'tool.mcp__<REDACTED>__query',
      c: ['tool:mcp__<REDACTED>__y', 42, true, null],
    })
    expect(r.counts).toEqual({ 'muse-profile-name': 3 })
    expect(redactMuseText('warning: mcp__corp__q timed out')).toBe('warning: mcp__<REDACTED>__q timed out')
  })

  it('is idempotent', () => {
    const once = redactMuseValue({
      t: 'plugin:p:x',
      f: [{ kind: 'producer', detail: { request_id: 'q' } }],
    }).value
    const twice = redactMuseValue(once)
    expect(twice.value).toEqual(once)
    expect(twice.counts).toEqual({})
  })

  it('the recorder constants', () => {
    expect(MUSE_PROMPT_FILE).toBe('<PROMPT_FILE>')
    expect([...MUSE_ENV_DROP]).toEqual(['^META_', '^MUSE_'])
  })
})

describe('every committed Muse record is a fixed point of the rules', () => {
  const ids = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  it.each(ids)('%s', (id) => {
    const frames = readFileSync(join(FIXTURES, id, 'recording.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    for (const f of frames) {
      if (f['dir'] === 'out') {
        const value = JSON.parse(f['line'] as string) as unknown
        expect(redactMuseValue(value).counts).toEqual({})
      }
      if (f['dir'] === 'err') expect(redactMuseText(f['line'] as string)).toBe(f['line'])
    }
  })
})
