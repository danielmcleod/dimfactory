// Refresh job: the Claude argv (the refresh job, read-only tool cut), the builtin refresh prompt and output schema,
// and that the C17/C18 fixtures still carry exactly what the code sends (argv, env, initialize jsonSchema). C17,
// C18a, C18c and C18d are live recordings of 2.1.289; C18b (retries exhausted) stays synthesized.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compareRecorded } from '../../../fake-cli/fake-cli.mjs'
import {
  buildArgv,
  catalogAllowedTools,
  catalogTools,
  claudeEnv,
  extraArgsProblem,
  routeFor,
} from '../../../../src/core/adapters/claude/launch.ts'
import { initializeRequest } from '../../../../src/core/adapters/claude/protocol.ts'
import { parseRecording } from '../../../../src/core/adapters/claude/normalize.ts'
import {
  CATALOG_REFRESH_TEMPLATE_CANDIDATES,
  currentCatalogText,
  localDate,
  readCatalogRefreshTemplate,
  refreshFlagMap,
  refreshJsonSchema,
  renderRefreshPrompt,
  vendorsText,
} from '../../../../src/core/catalog/refresh.ts'
import { officialHosts } from '../../../../src/core/catalog/sources.ts'
import type { CatalogData } from '../../../../src/core/catalog/store.ts'
import { loadSeedPricing } from '../../../../src/core/catalog/store.ts'
import { parseTemplate, placeholdersOf, validateTemplate } from '../../../../src/core/prompts/template.ts'

const STDIO = fileURLToPath(new URL('../../../fixtures/claude/stdio/', import.meta.url))
/** Recorded live with the refresh's argv and env; C18a's initialize carries no jsonSchema (a CLI ignoring it). */
const LIVE = [
  'C17-refresh-structured-output',
  'C18a-refresh-fenced-fallback',
  'C18c-refresh-skips-structured-output',
  'C18d-refresh-invalid-structured-output',
]
const WITHOUT_SCHEMA = new Set(['C18a-refresh-fenced-fallback'])
const SYNTHESIZED = ['C18b-refresh-structured-retries']
/** The refresh's env (claudeEnv with confined): the names a recording's header lists. */
const REFRESH_ENV_KEYS = ['CLAUDE_CODE_EVAL_CONFINED', 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS']

const BASE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
]

const catalogArgv = (vendors: string[], model: string | null = 'sonnet'): string[] =>
  buildArgv({
    route: 'readonly',
    mode: 'readonly',
    step: 'catalog',
    model,
    webDomains: officialHosts(vendors),
  })

describe('refresh argv (the refresh job, read-only tool cut)', () => {
  it('is the read-only row with shell, subagents cut and web limited to the official hosts', () => {
    expect(routeFor({ step: 'catalog', mode: 'readonly', planNative: false })).toBe('readonly')
    expect(catalogArgv(['claude'])).toEqual([
      ...BASE,
      'dontAsk',
      '--model',
      'sonnet',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--settings',
      '{"disableAllHooks":true}',
      '--disallowedTools',
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Bash,PowerShell,Agent',
      '--tools',
      'WebSearch,WebFetch',
      '--allowedTools',
      'WebSearch,WebFetch(domain:docs.anthropic.com),WebFetch(domain:www.anthropic.com),' +
        'WebFetch(domain:claude.com),WebFetch(domain:platform.claude.com)',
    ])
  })

  it('its tools are an allow list (--tools), not only a cut; no host leaves web search alone', () => {
    expect(catalogTools(officialHosts(['claude']))).toEqual(['WebSearch', 'WebFetch'])
    expect(catalogTools([])).toEqual(['WebSearch'])
    expect(catalogTools(['not a host', '*.example.com'])).toEqual(['WebSearch'])
    const none = buildArgv({ route: 'readonly', mode: 'readonly', step: 'catalog', webDomains: [] })
    expect(none[none.indexOf('--tools') + 1]).toBe('WebSearch')
    expect(none[none.indexOf('--allowedTools') + 1]).toBe('WebSearch')
    // Only the refresh gets --tools: the review passes keep the CLI's set under the read-only tool cut.
    const review = buildArgv({ route: 'readonly', mode: 'readonly', step: 'review' })
    expect(review).not.toContain('--tools')
    // Dim Factory manages --tools: extraArgs may not set it, and a flagMap rename of it never reaches the refresh.
    expect(extraArgsProblem(['--tools', 'Bash'])).toMatch(/Dim Factory manages it/)
    expect(extraArgsProblem(['--tools=default'])).toMatch(/Dim Factory manages it/)
    expect(refreshFlagMap({ '--tools': '--tool-list' })).toBeUndefined()
  })

  it('never has a permission host, a session, a prompt or a shell, even when the user allows shell', () => {
    const a = buildArgv({
      route: 'readonly',
      mode: 'full',
      step: 'catalog',
      disallowShell: false,
      webDomains: officialHosts(['claude']),
    })
    expect(a).not.toContain('--permission-prompt-tool')
    expect(a.some((x) => x.startsWith('--session-id') || x.startsWith('--resume'))).toBe(false)
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    const cut = (a[a.indexOf('--disallowedTools') + 1] ?? '').split(',')
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'AskUserQuestion'])
      expect(cut).toContain(t)
    // No model given: the CLI default.
    expect(catalogArgv(['claude'], null)).not.toContain('--model')
  })

  it('takes its WebFetch hosts from sources.ts for every vendor in use, and nothing else', () => {
    const allowed = (vendors: string[]): string[] => {
      const a = catalogArgv(vendors)
      return (a[a.indexOf('--allowedTools') + 1] ?? '').split(',')
    }
    expect(allowed(['claude', 'codex'])).toEqual([
      'WebSearch',
      ...officialHosts(['claude', 'codex']).map((h) => `WebFetch(domain:${h})`),
    ])
    expect(allowed(['claude', 'codex'])).toContain('WebFetch(domain:developers.openai.com)')
    // Never a bare WebFetch (any host) and never a wildcard.
    for (const r of allowed(['claude', 'codex', 'gemini', 'grok'])) {
      expect(r === 'WebSearch' || /^WebFetch\(domain:[a-z0-9.-]+\)$/.test(r)).toBe(true)
    }
  })

  it('drops a host that is not a plain DNS name (no commas, rule syntax or wildcards reach the CLI)', () => {
    expect(
      catalogAllowedTools([
        'platform.claude.com',
        'evil.example,Bash',
        '*.example.com',
        'x.com)',
        'UPPER.example',
        'localhost',
        '',
      ]),
    ).toEqual(['WebSearch', 'WebFetch(domain:platform.claude.com)'])
  })

  it("keeps the user's flagMap renames except the flags that hold it read-only and web-limited", () => {
    expect(
      refreshFlagMap({
        '--disallowedTools': '--deny-tools',
        '--allowedTools': '--allow-tools',
        '--permission-mode': '--mode',
        '--settings': '--setting',
        '--permission-prompts': '--prompts',
        '--strict-mcp-config': '--strict-mcp',
        '--no-session-persistence': '--ephemeral-session',
        '--include-partial-messages': '--partial',
      }),
    ).toEqual({ '--include-partial-messages': '--partial' })
    expect(refreshFlagMap({ '--disallowed-tools': '--x' })).toBeUndefined()
    expect(refreshFlagMap(undefined)).toBeUndefined()
  })

  it('sends the schema in initialize as jsonSchema, and nothing new for other passes', () => {
    const schema = refreshJsonSchema(['claude'])
    expect(initializeRequest('init-1', { jsonSchema: schema })).toEqual({
      type: 'control_request',
      request_id: 'init-1',
      request: { subtype: 'initialize', jsonSchema: schema },
    })
    expect(initializeRequest('init-1')).toEqual({
      type: 'control_request',
      request_id: 'init-1',
      request: { subtype: 'initialize' },
    })
  })
})

describe('the refresh env (the allow list is exactly --allowedTools)', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/u' }

  it('confined spawns carry CLAUDE_CODE_EVAL_CONFINED=1, after the user env, which cannot unset it', () => {
    const env = claudeEnv(base, {
      route: 'readonly',
      confined: true,
      vendorEnv: { CLAUDE_CODE_EVAL_CONFINED: '0', OTHER: 'kept' },
      launchedFromClaude: false,
      platform: 'linux',
    })
    expect(env['CLAUDE_CODE_EVAL_CONFINED']).toBe('1')
    expect(env['OTHER']).toBe('kept')
    // Windows variable names are case-insensitive: a lower-case spelling is replaced too.
    const win = claudeEnv(
      { Path: 'C:\\Windows' },
      {
        route: 'readonly',
        confined: true,
        vendorEnv: { claude_code_eval_confined: 'false' },
        launchedFromClaude: false,
        platform: 'win32',
      },
    )
    const keys = Object.keys(win).filter((k) => k.toUpperCase() === 'CLAUDE_CODE_EVAL_CONFINED')
    expect(keys.map((k) => win[k])).toEqual(['1'])
  })

  it('no other pass is confined', () => {
    for (const route of ['readonly', 'plan', 'edit'] as const) {
      const env = claudeEnv(base, { route, launchedFromClaude: false, platform: 'linux' })
      expect(env['CLAUDE_CODE_EVAL_CONFINED']).toBeUndefined()
    }
  })
})

describe('the refresh output schema', () => {
  it('is closed at every level and limits vendor to the vendors being refreshed', () => {
    const s = refreshJsonSchema(['claude', 'codex']) as {
      additionalProperties: boolean
      required: string[]
      properties: Record<
        string,
        { items: { additionalProperties: boolean; properties: Record<string, unknown> } }
      >
    }
    expect(s.additionalProperties).toBe(false)
    expect(s.required).toEqual(['generatedAt', 'entries', 'newModels', 'unverifiable'])
    for (const k of ['entries', 'newModels', 'unverifiable']) {
      const item = s.properties[k]?.items
      expect(item?.additionalProperties).toBe(false)
      expect(item?.properties['vendor']).toMatchObject({ enum: ['claude', 'codex'] })
    }
    expect(s.properties['entries']?.items.properties['sourceQuote']).toMatchObject({ maxLength: 200 })
    expect(Object.keys(s.properties['entries']?.items.properties ?? {})).toEqual([
      'vendor',
      'model',
      'aliases',
      'inputPerMTok',
      'outputPerMTok',
      'cacheReadPerMTok',
      'cacheWritePerMTok',
      'sourceUrl',
      'sourceQuote',
      'deprecated',
    ])
  })
})

describe('the prompt (internal/catalog-refresh.md)', () => {
  const catalog = async (): Promise<CatalogData> => ({
    pricing: await loadSeedPricing(),
    models: {
      schemaVersion: 1,
      updatedAt: 0,
      vendors: {
        claude: {
          source: 'cli',
          fetchedAt: 0,
          models: [
            { id: 'claude-opus-5-5', aliases: ['opus'], source: 'cli', fetchedAt: 0 },
            { id: 'claude-sonnet-6', source: 'cli', fetchedAt: 0 },
            { id: 'claude-hidden', hidden: true, source: 'cli', fetchedAt: 0 },
          ],
        },
      },
    },
  })

  it('is the builtin refresh text with exactly the five catalog placeholders', () => {
    const text = readCatalogRefreshTemplate()
    expect(CATALOG_REFRESH_TEMPLATE_CANDIDATES[0]).toMatch(/prompts[\\/]internal[\\/]catalog-refresh\.md$/)
    expect(text.startsWith('You are updating a local price list for a desktop app.')).toBe(true)
    expect(placeholdersOf(parseTemplate(text).nodes).sort()).toEqual(
      ['currentCatalog', 'jsonSchema', 'officialSources', 'today', 'vendors'].sort(),
    )
    expect(validateTemplate(text, 'catalog').issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('renders vendors, sources, today, the catalog and the schema', async () => {
    const schema = refreshJsonSchema(['claude'])
    const prompt = renderRefreshPrompt({
      vendors: ['claude'],
      catalog: await catalog(),
      today: '2026-10-09',
      schema,
    })
    expect(prompt).toContain('Today is 2026-10-09.')
    expect(prompt).toContain('Vendors in use: claude (Anthropic).')
    expect(prompt).toContain(
      'Official pages to prefer: anthropic: docs.anthropic.com, www.anthropic.com, claude.com, platform.claude.com',
    )
    expect(prompt).toContain('"model":"claude-sonnet-5-5"')
    // A CLI model without a price is listed for the AI to price; hidden ones and priced ones are not repeated.
    expect(prompt).toContain(
      '{"vendor":"claude","model":"claude-sonnet-6","aliases":[],"prices":"not known yet"}',
    )
    expect(prompt).not.toContain('claude-hidden')
    expect(prompt.trimEnd().endsWith(JSON.stringify(schema, null, 2))).toBe(true)
    // Codex prices are in the seed, but only the vendors being refreshed are shown.
    expect(prompt).not.toContain('gpt-5.6-sol')
    expect(prompt).not.toMatch(/\{\{/)
  })

  it('lists the vendors with their publisher, and cuts a huge catalog at whole lines', async () => {
    expect(vendorsText(['claude', 'codex', 'local-x'])).toBe('claude (Anthropic), codex (OpenAI), local-x')
    const big = await catalog()
    const one = big.pricing.entries[0]!
    big.pricing.entries = Array.from({ length: 2000 }, (_, i) => ({ ...one, model: `claude-m-${i}` }))
    const text = currentCatalogText(big, ['claude'])
    expect(text.length).toBeLessThanOrEqual(64_100)
    expect(text).toMatch(/\n\(\d+ more entries not shown\)$/)
    expect(currentCatalogText({ ...big, pricing: { ...big.pricing, entries: [] } }, ['gemini'])).toBe(
      '(none yet)',
    )
  })

  it("writes today as the user's local date", () => {
    const at = new Date(2026, 9, 9, 23, 59).getTime()
    expect(localDate(at)).toBe('2026-10-09')
  })
})

/** The header, the initialize request the host sent and the CLI's init frame of one recording. */
function fixture(id: string): {
  header: ReturnType<typeof parseRecording>['header']
  init: { request?: { subtype?: string; jsonSchema?: unknown } }
  tools: string[] | undefined
} {
  const { header, frames } = parseRecording(readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8'))
  const init = JSON.parse(frames.find((f) => f.dir === 'in')?.line ?? '{}') as {
    request?: { subtype?: string; jsonSchema?: unknown }
  }
  const initFrame = frames
    .filter((f) => f.dir === 'out')
    .map((f) => JSON.parse(f.line ?? '{}') as { type?: string; subtype?: string; tools?: string[] })
    .find((f) => f.type === 'system' && f.subtype === 'init')
  return { header, init, tools: initFrame?.tools }
}

describe('C17/C18 fixtures match the code', () => {
  it.each(LIVE)('%s: recorded live; argv, env and initialize jsonSchema are what the job sends', (id) => {
    const { header, init, tools } = fixture(id)
    // Made from the live recording (scripts/synthesize-fixtures.mjs): its argv, env and host frames are as recorded.
    expect(String(header?.['synthesizedFrom'])).toContain('scripts/synthesize-fixtures.mjs')
    expect(header?.['cliVersion']).toBe('2.1.289')
    expect(header?.argv).toEqual(['claude.exe', ...catalogArgv(['claude'])])
    expect(header?.['envKeys']).toEqual(REFRESH_ENV_KEYS)
    expect(
      Object.keys(claudeEnv({}, { route: 'readonly', confined: true }))
        .filter((k) => k.startsWith('CLAUDE_CODE_'))
        .sort(),
    ).toEqual(REFRESH_ENV_KEYS)
    expect(init.request?.subtype).toBe('initialize')
    if (WITHOUT_SCHEMA.has(id)) expect(init.request).not.toHaveProperty('jsonSchema')
    // Recorded under the former host name, which the replay masks (RECORDED_HOST_NAMES) as it does here.
    else expect(compareRecorded(init.request?.jsonSchema, refreshJsonSchema(['claude']))).toEqual([])
    // Confirmed live: only the tools --tools allows, plus the schema's answer tool when the schema
    // was sent. Nothing that edits, runs, schedules or starts agents.
    expect(tools).toEqual(
      WITHOUT_SCHEMA.has(id) ? ['WebFetch', 'WebSearch'] : ['WebFetch', 'WebSearch', 'StructuredOutput'],
    )
    const allowed = new Set([...catalogTools(officialHosts(['claude'])), 'StructuredOutput'])
    for (const t of tools ?? []) expect(allowed.has(t)).toBe(true)
  })

  it.each(SYNTHESIZED)(
    '%s: marked synthesized; argv and initialize jsonSchema are what the job sends',
    (id) => {
      const { header, init, tools } = fixture(id)
      expect(header?.['synthesized']).toBe(true)
      expect(String(header?.['note'])).toContain('retries exhausted could not be provoked live')
      expect(header?.argv).toEqual(['claude.exe', ...catalogArgv(['claude'])])
      expect(init.request?.subtype).toBe('initialize')
      expect(init.request?.jsonSchema).toEqual(refreshJsonSchema(['claude']))
      expect(tools).toEqual(['WebFetch', 'WebSearch', 'StructuredOutput'])
    },
  )

  it('the fixtures README says which are live, that C18b is synthesized and how to regenerate it', () => {
    const readme = readFileSync(join(STDIO, '..', 'README.md'), 'utf8')
    for (const id of [...LIVE, ...SYNTHESIZED]) expect(readme).toContain(id)
    expect(readme).toMatch(/synthesized/i)
    expect(readme).toContain('synthesize.mjs')
  })
})
