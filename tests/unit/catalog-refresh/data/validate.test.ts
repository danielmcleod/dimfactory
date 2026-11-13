// Refresh validation (the refresh validation table; src/core/catalog/validate.ts): one case
// per table row, then the row defaults (any flag unticks), the quote limit, `verified`, malformed answers, new models,
// page-stated deprecation, confirm rows and the stable row order and ids. The review round's cases follow:
// cache prices where there were none, cache writes below reads, pages the job never read, an unknown CLI list, a new
// model far from the vendor's prices, answer aliases and models the job's schema check refused.
import { describe, expect, it } from 'vitest'
import {
  catalogRowId,
  checkProposal,
  cleanQuote,
  jobValidateContext,
  priceEditProblem,
  validateProposal,
} from '../../../../src/core/catalog/validate.ts'
import type { CatalogDiffRow, ProposedPrice } from '../../../../src/shared/catalog.ts'
import {
  CLI_MODELS,
  FABLE,
  GPT,
  HAIKU,
  OPUS,
  SONNET,
  allClaude,
  current,
  proposal,
  proposed,
} from './fixtures.ts'

const ctx = { cliModels: { claude: CLI_MODELS } }
const rowOf = (rows: CatalogDiffRow[], model: string, field?: string): CatalogDiffRow | undefined =>
  rows.find(
    (r) =>
      r.model === model &&
      r.field === field &&
      (field !== undefined || (r.kind !== 'price' && r.kind !== 'confirm')),
  )
/** The rows that change prices or models (confirm rows left out). */
const changes = (rows: CatalogDiffRow[]): CatalogDiffRow[] => rows.filter((r) => r.kind !== 'confirm')

describe('the validation table, row by row', () => {
  it('price ≤ 0 or > 1000 → rejected (never a row)', () => {
    const v = checkProposal(
      current(),
      proposal(
        allClaude({
          'claude-opus-5-5': { inputPerMTok: 0 },
          'claude-sonnet-5-5': { outputPerMTok: 1000.01 },
          'claude-haiku-4-5-20251001': { cacheReadPerMTok: -1 },
        }),
      ),
      ctx,
    )
    expect(v.rows.filter((r) => r.kind === 'price')).toEqual([])
    expect(v.rejected.map((r) => [r.model, r.field, r.value])).toEqual([
      ['claude-opus-5-5', 'inputPerMTok', 0],
      ['claude-sonnet-5-5', 'outputPerMTok', 1000.01],
      ['claude-haiku-4-5-20251001', 'cacheReadPerMTok', -1],
    ])
    expect(v.rejected[0]?.reason).toBe(
      'The input price must be more than $0 and at most $1,000 per million tokens.',
    )
    // 1000 itself is allowed.
    const edge = validateProposal(
      current(),
      proposal(allClaude({ 'claude-opus-5-5': { outputPerMTok: 1000 } })),
      ctx,
    )
    expect(rowOf(edge, 'claude-opus-5-5', 'outputPerMTok')).toMatchObject({
      proposed: 1000,
      flags: ['suspicious'],
    })
  })

  it('change > 50% → amber (bigChange), unticked; exactly 50% is not', () => {
    const rows = validateProposal(
      current(),
      proposal(
        allClaude({
          'claude-opus-5-5': { inputPerMTok: 6.5, outputPerMTok: 30 },
          'claude-sonnet-5-5': { inputPerMTok: 0.9 },
        }),
      ),
      ctx,
    )
    expect(rowOf(rows, 'claude-opus-5-5', 'inputPerMTok')).toMatchObject({
      current: 4,
      proposed: 6.5,
      deltaPct: 62.5,
      flags: ['bigChange'],
      ticked: false,
      reason: 'Changes by more than 50% (from $4).',
    })
    expect(rowOf(rows, 'claude-opus-5-5', 'outputPerMTok')).toMatchObject({
      deltaPct: 50,
      flags: [],
      ticked: true,
    })
    expect(rowOf(rows, 'claude-sonnet-5-5', 'inputPerMTok')).toMatchObject({
      deltaPct: -55,
      flags: ['bigChange'],
      ticked: false,
    })
  })

  it('> 10× or < 0.1× → suspicious (instead of bigChange), unticked', () => {
    // Two answers (cache writes below cache reads are also inconsistent, which one answer would add).
    const rows = [
      ...validateProposal(
        current(),
        proposal(allClaude({ 'claude-opus-5-5': { cacheReadPerMTok: 2.5 } })),
        ctx,
      ),
      ...validateProposal(
        current(),
        proposal(allClaude({ 'claude-opus-5-5': { cacheWritePerMTok: 0.5 } })),
        ctx,
      ),
    ]
    // Cache reads at $2.5 stay below input ($4): only the factor flags them.
    expect(rowOf(rows, 'claude-opus-5-5', 'cacheReadPerMTok')).toMatchObject({
      flags: ['suspicious'],
      ticked: false,
    })
    expect(rowOf(rows, 'claude-opus-5-5', 'cacheReadPerMTok')?.flags).not.toContain('bigChange')
    expect(rowOf(rows, 'claude-opus-5-5', 'cacheWritePerMTok')).toMatchObject({
      flags: ['suspicious'],
      ticked: false,
      reason: 'Less than a tenth of the current price ($8).',
    })
  })

  it('output < input, or cacheRead > input → inconsistent, on the rows of the prices involved', () => {
    const rows = validateProposal(
      current(),
      proposal(
        allClaude({
          // output 3.9 < input 4 (−80.5%: bigChange too)
          'claude-opus-5-5': { outputPerMTok: 3.9 },
          // cacheRead 2.5 > input 2 (12.5×: suspicious too)
          'claude-sonnet-5-5': { cacheReadPerMTok: 2.5 },
        }),
      ),
      ctx,
    )
    expect(rowOf(rows, 'claude-opus-5-5', 'outputPerMTok')).toMatchObject({
      flags: ['bigChange', 'inconsistent'],
      ticked: false,
    })
    expect(rowOf(rows, 'claude-opus-5-5', 'outputPerMTok')?.reason).toContain(
      'Output would cost less than input.',
    )
    expect(rowOf(rows, 'claude-sonnet-5-5', 'cacheReadPerMTok')?.flags).toEqual([
      'suspicious',
      'inconsistent',
    ])
    // A new model with no baseline: both relations, flagged on input, output and cache read (its prices stay within
    // 10× of the vendor's others, which the review round also checks).
    const fresh = validateProposal(
      current(),
      proposal([
        ...allClaude(),
        {
          ...proposed(OPUS),
          model: 'claude-opus-6',
          aliases: [],
          inputPerMTok: 2,
          outputPerMTok: 1.5,
          cacheReadPerMTok: 2.4,
          cacheWritePerMTok: null,
        },
      ]),
      { cliModels: { claude: [...CLI_MODELS, { id: 'claude-opus-6', source: 'cli' as const }] } },
    )
    expect(fresh.filter((r) => r.model === 'claude-opus-6').map((r) => [r.field, r.flags])).toEqual([
      ['inputPerMTok', ['inconsistent']],
      ['outputPerMTok', ['inconsistent']],
      ['cacheReadPerMTok', ['inconsistent']],
    ])
  })

  it('source host not in sources.ts → unofficial (http, another publisher, any other site)', () => {
    const rows = validateProposal(
      current(),
      proposal(
        allClaude({
          'claude-opus-5-5': { inputPerMTok: 4.4, sourceUrl: 'https://example.com/claude-prices' },
          'claude-sonnet-5-5': { inputPerMTok: 2.2, sourceUrl: 'http://docs.anthropic.com/pricing' },
          'claude-haiku-4-5-20251001': { inputPerMTok: 1.1, sourceUrl: 'https://openai.com/api/pricing' },
        }),
      ),
      ctx,
    )
    for (const m of [OPUS, SONNET, HAIKU]) {
      expect(rowOf(rows, m.model, 'inputPerMTok')).toMatchObject({
        flags: ['unofficial'],
        ticked: false,
        reason: 'The source is not an official page of this vendor.',
      })
      expect(rowOf(rows, m.model, 'inputPerMTok')?.verified).toBeUndefined()
    }
    // A host list in the context replaces sources.ts.
    const custom = validateProposal(
      current(),
      proposal(allClaude({ 'claude-opus-5-5': { inputPerMTok: 4.4, sourceUrl: 'https://example.com/x' } })),
      { ...ctx, sources: ['example.com'] },
    )
    expect(rowOf(custom, 'claude-opus-5-5', 'inputPerMTok')).toMatchObject({ flags: [], ticked: true })
  })

  it('model not reported by the CLI → notReportedByCli; aliases and snapshot dates are not; an unknown list flags only a new model', () => {
    const extra = {
      ...proposed(OPUS),
      model: 'claude-opus-6',
      aliases: [],
      inputPerMTok: 5,
      outputPerMTok: 25,
    }
    const rows = validateProposal(
      current(),
      proposal([
        ...allClaude({ 'claude-haiku-4-5-20251001': { model: 'claude-haiku-4-5', inputPerMTok: 1.1 } }),
        extra,
      ]),
      ctx,
    )
    expect(rowOf(rows, 'claude-opus-6', 'inputPerMTok')).toMatchObject({
      current: null,
      flags: ['notReportedByCli'],
      ticked: false,
      reason: 'The CLI does not list this model.',
    })
    // The proposal's undated id matched the stored entry (and the CLI's dated alias).
    expect(rowOf(rows, 'claude-haiku-4-5-20251001', 'inputPerMTok')).toMatchObject({
      flags: [],
      ticked: true,
    })
    // No CLI list known (not probed): a known model is not flagged; a model with no price yet waits for the user
    // (it used to be ticked whatever its price).
    const unknown = validateProposal(
      current(),
      proposal([...allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.2 } }), extra]),
      {},
    )
    expect(rowOf(unknown, 'claude-sonnet-5-5', 'inputPerMTok')).toMatchObject({ flags: [], ticked: true })
    expect(rowOf(unknown, 'claude-opus-6', 'inputPerMTok')).toMatchObject({
      flags: ['notReportedByCli'],
      ticked: false,
      reason: "The CLI's model list is not known yet, so this model could not be checked.",
    })
  })

  it('you edited the entry → userEdited ("You edited this price."), unticked; also from ctx.userEdited', () => {
    const rows = validateProposal(
      current(),
      proposal(
        allClaude({
          'claude-fable-5-1': { inputPerMTok: 11 },
          'claude-sonnet-5-5': { inputPerMTok: 2.2 },
        }),
      ),
      { ...ctx, userEdited: ['claude/claude-sonnet-5-5'] },
    )
    expect(rowOf(rows, 'claude-fable-5-1', 'inputPerMTok')).toMatchObject({
      flags: ['userEdited'],
      ticked: false,
      reason: 'You edited this price.',
    })
    expect(rowOf(rows, 'claude-sonnet-5-5', 'inputPerMTok')?.flags).toEqual(['userEdited'])
  })

  it('a model missing from the proposal → no deletion, a tickable deprecated row (unticked by default)', () => {
    const v = checkProposal(
      current(),
      proposal([proposed(OPUS), proposed(SONNET)], {
        unverifiable: [{ vendor: 'claude', model: 'fable', reason: 'The page does not list it.' }],
      }),
      ctx,
    )
    // Haiku is missing; Fable was named (unverifiable, by its alias); codex was not priced at all. (Opus and Sonnet,
    // repeated unchanged, are confirm rows.)
    expect(changes(v.rows)).toEqual([
      {
        id: 'deprecate|claude|claude-haiku-4-5-20251001',
        vendor: 'claude',
        model: 'claude-haiku-4-5-20251001',
        kind: 'deprecate',
        current: null,
        proposed: null,
        deltaPct: null,
        sourceUrl: null,
        sourceQuote: null,
        flags: ['deprecated'],
        ticked: false,
        reason: 'Not in this update: the vendor may have retired it. Tick to mark it deprecated.',
      },
    ])
    expect(v.unverifiable).toEqual([
      { vendor: 'claude', model: 'fable', reason: 'The page does not list it.' },
    ])
    // A vendor the proposal priced nothing for is never deprecated wholesale (an empty answer proposes nothing).
    expect(validateProposal(current(), proposal([]), { ...ctx, vendors: ['claude'] })).toEqual([])
    // A user's own entry missing from the proposal: deprecated + userEdited.
    const mine = validateProposal(current(), proposal([proposed(OPUS)]), ctx)
    expect(rowOf(mine, 'claude-fable-5-1')?.flags).toEqual(['userEdited', 'deprecated'])
    expect(mine.some((r) => r.vendor === 'codex')).toBe(false)
  })
})

describe('row defaults, quotes and verification', () => {
  it('a clean change is ticked, unflagged and verified (official page + quote)', () => {
    const rows = validateProposal(
      current(),
      proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } })),
      ctx,
    )
    expect(changes(rows)).toEqual([
      {
        id: 'price|claude|claude-sonnet-5-5|inputPerMTok',
        vendor: 'claude',
        model: 'claude-sonnet-5-5',
        kind: 'price',
        field: 'inputPerMTok',
        current: 2,
        proposed: 2.5,
        deltaPct: 25,
        sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
        sourceQuote: 'claude-sonnet-5-5 | $2 / MTok',
        flags: [],
        ticked: true,
        verified: true,
      },
    ])
  })

  it('every flag unticks; an official page without a quote is not verified', () => {
    const rows = validateProposal(
      current(),
      proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5, sourceQuote: '   ' } })),
      ctx,
    )
    const row = rowOf(rows, 'claude-sonnet-5-5', 'inputPerMTok')
    expect(row).toMatchObject({ ticked: true, sourceQuote: null })
    expect(row?.verified).toBeUndefined()
  })

  it('sourceQuote: one line, at most 200 characters kept (the start), never a split surrogate pair', () => {
    const long = `Claude\nSonnet  ${'x'.repeat(300)}`
    const rows = validateProposal(
      current(),
      proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5, sourceQuote: long } })),
      ctx,
    )
    const quote = rowOf(rows, 'claude-sonnet-5-5', 'inputPerMTok')?.sourceQuote
    expect(quote).toHaveLength(200)
    expect(quote?.startsWith('Claude Sonnet x')).toBe(true)
    const emoji = cleanQuote(`${'a'.repeat(199)}😀`)
    expect(emoji).toBe('a'.repeat(199))
  })

  it('malformed answers: a bad entry or a non-web source is rejected, a duplicate keeps the first; a non-object is empty', () => {
    const v = checkProposal(
      current(),
      proposal([
        ...allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } }),
        { vendor: 'claude', model: 'claude-x', inputPerMTok: '3', outputPerMTok: 4, sourceUrl: PRICING },
        { ...proposed(SONNET), inputPerMTok: 9 },
        { ...proposed(OPUS), model: 'claude-y', sourceUrl: 'javascript:alert(1)' },
        'nonsense',
      ]),
      ctx,
    )
    expect(rowOf(v.rows, 'claude-sonnet-5-5', 'inputPerMTok')?.proposed).toBe(2.5)
    // Shape failures first (in answer order), then what the rows found.
    expect(v.rejected.map((r) => [r.model, r.reason])).toEqual([
      [
        'claude-x',
        'Not a valid price entry (inputPerMTok: Invalid input: expected number, received string).',
      ],
      ['claude-y', 'The source is not a web page address.'],
      ['?', 'Not a valid price entry (Invalid input: expected object, received string).'],
      ['claude-sonnet-5-5', 'claude-sonnet-5-5 is listed more than once; the first listing is used.'],
    ])
    expect(checkProposal(current(), 'not json', ctx).rows).toEqual([])
    // `{proposal: …}` around the answer is read too.
    const wrapped = checkProposal(
      current(),
      { proposal: proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } })) },
      ctx,
    )
    expect(changes(wrapped.rows).map((r) => r.id)).toEqual(['price|claude|claude-sonnet-5-5|inputPerMTok'])
  })

  it('new models: offered when unknown (contextWindow as the proposed value), never when known', () => {
    const v = checkProposal(
      current(),
      proposal(allClaude(), {
        newModels: [
          {
            vendor: 'claude',
            id: 'claude-opus-6',
            displayName: 'Claude Opus 6',
            contextWindow: 1_000_000,
            sourceUrl: PRICING,
          },
          { vendor: 'claude', id: 'sonnet', sourceUrl: PRICING },
          { vendor: 'claude', id: 'claude-mystery', sourceUrl: 'https://blog.example.org/x' },
        ],
      }),
      { cliModels: { claude: [...CLI_MODELS, { id: 'claude-opus-6', source: 'cli' as const }] } },
    )
    expect(changes(v.rows).map((r) => [r.kind, r.model, r.proposed, r.flags, r.ticked])).toEqual([
      ['new-model', 'claude-mystery', null, ['unofficial', 'notReportedByCli'], false],
      ['new-model', 'claude-opus-6', 1_000_000, [], true],
    ])
  })

  it('a page saying deprecated → a deprecate row with its source (ticked when official and unflagged)', () => {
    const rows = validateProposal(
      current(),
      proposal(allClaude({ 'claude-haiku-4-5-20251001': { deprecated: true } })),
      ctx,
    )
    expect(rows.filter((r) => r.kind === 'deprecate')).toEqual([
      expect.objectContaining({
        id: 'deprecate|claude|claude-haiku-4-5-20251001',
        kind: 'deprecate',
        sourceUrl: PRICING,
        flags: [],
        ticked: true,
        verified: true,
      }),
    ])
  })

  it('confirm rows: the same prices on a verified page are rows of their own, shown and ticked', () => {
    const v = checkProposal(
      current(),
      proposal([...allClaude(), proposed(GPT, { sourceUrl: 'https://openai.com/api/pricing' })]),
      ctx,
    )
    // No price changes; one confirm row per unchanged entry the page repeats (never the user's own Fable).
    expect(v.rows.map((r) => [r.id, r.kind, r.flags, r.ticked, r.verified])).toEqual([
      ['confirm|claude|claude-haiku-4-5-20251001', 'confirm', [], true, true],
      ['confirm|claude|claude-opus-5-5', 'confirm', [], true, true],
      ['confirm|claude|claude-sonnet-5-5', 'confirm', [], true, true],
      ['confirm|codex|gpt-5.5', 'confirm', [], true, true],
    ])
    expect(v.rows[1]).toMatchObject({
      model: 'claude-opus-5-5',
      current: null,
      proposed: null,
      sourceUrl: PRICING,
      sourceQuote: 'claude-opus-5-5 | $4 / MTok',
    })
    expect(v.rows.some((r) => r.model === FABLE.model)).toBe(false)
    expect([...v.confirmations.keys()].sort()).toEqual(v.rows.map((r) => r.id).sort())
    // Not verified (an unofficial page, no quote): nothing to confirm, so no row.
    const weak = checkProposal(
      current([OPUS, SONNET]),
      proposal([
        proposed(OPUS, { sourceUrl: 'https://example.com/prices' }),
        proposed(SONNET, { sourceQuote: '' }),
      ]),
      ctx,
    )
    expect(weak.rows).toEqual([])
  })

  it('rows come in a fixed order (vendor, model, then fields, new model, deprecate) with deterministic ids', () => {
    const p = proposal(
      [
        proposed(SONNET, { cacheWritePerMTok: 4.4, inputPerMTok: 2.2 }),
        proposed(OPUS, { outputPerMTok: 22 }),
        proposed(GPT, { sourceUrl: 'https://openai.com/api/pricing', inputPerMTok: 1.3 }),
      ],
      { newModels: [{ vendor: 'claude', id: 'claude-opus-6', sourceUrl: PRICING }] },
    )
    const a = validateProposal(current(), p, ctx)
    const b = validateProposal(current(), structuredClone(p), ctx)
    expect(a).toEqual(b)
    expect(a.map((r) => r.id)).toEqual([
      'deprecate|claude|claude-fable-5-1',
      'deprecate|claude|claude-haiku-4-5-20251001',
      'price|claude|claude-opus-5-5|outputPerMTok',
      'new-model|claude|claude-opus-6',
      'price|claude|claude-sonnet-5-5|inputPerMTok',
      'price|claude|claude-sonnet-5-5|cacheWritePerMTok',
      'price|codex|gpt-5.5|inputPerMTok',
    ])
    expect(catalogRowId('price', 'claude', `m-${'x'.repeat(200)}`, 'inputPerMTok')).toMatch(
      /^price\|[0-9a-f]{40}$/,
    )
  })
})

describe('the cases the review found', () => {
  const GPT_NO_WRITE = { ...GPT, cacheWritePerMTok: null }
  const codex = (over: Partial<ProposedPrice>): ProposedPrice =>
    proposed(GPT_NO_WRITE, { sourceUrl: 'https://openai.com/api/pricing', ...over })

  it('a cache price where there was none is compared with the input price those tokens cost now', () => {
    const cur = current([OPUS, SONNET, HAIKU, GPT_NO_WRITE])
    const rows = (cacheWritePerMTok: number): CatalogDiffRow | undefined =>
      rowOf(
        validateProposal(cur, proposal([codex({ cacheWritePerMTok })]), ctx),
        'gpt-5.5',
        'cacheWritePerMTok',
      )
    // $999 for tokens that cost the input price ($1.25) now: suspicious, unticked.
    expect(rows(999)).toMatchObject({
      current: null,
      proposed: 999,
      flags: ['suspicious'],
      ticked: false,
      reason: 'More than 10 times what those tokens cost now: the input price ($1.25).',
    })
    // 1.1× the input price: an ordinary change, ticked.
    expect(rows(1.375)).toMatchObject({ flags: [], ticked: true })
    // Less than half the input price: over 50%, unticked.
    expect(rows(0.5)).toMatchObject({
      flags: ['bigChange'],
      ticked: false,
      reason: 'Changes by more than 50%: those tokens now cost the input price ($1.25).',
    })
  })

  it('cache writes below cache reads → inconsistent', () => {
    const rows = validateProposal(
      current(),
      proposal(allClaude({ 'claude-opus-5-5': { cacheWritePerMTok: 0.15 } })),
      ctx,
    )
    expect(rowOf(rows, 'claude-opus-5-5', 'cacheWritePerMTok')?.flags).toEqual(['suspicious', 'inconsistent'])
    expect(rowOf(rows, 'claude-opus-5-5', 'cacheWritePerMTok')?.reason).toContain(
      'Cache writes would cost less than cache reads.',
    )
  })

  it('verified needs a page the job read: a source on a host it never fetched is notFetched and unticked', () => {
    const p = proposal(
      allClaude({
        'claude-sonnet-5-5': { inputPerMTok: 2.2 },
        'claude-opus-5-5': { inputPerMTok: 4.2, sourceUrl: 'https://docs.anthropic.com/en/pricing' },
      }),
      {
        newModels: [{ vendor: 'claude', id: 'claude-opus-6', sourceUrl: 'https://www.anthropic.com/news/x' }],
      },
    )
    const v = checkProposal(current(), p, {
      cliModels: { claude: [...CLI_MODELS, { id: 'claude-opus-6', source: 'cli' as const }] },
      fetchedHosts: ['platform.claude.com'],
    })
    expect(rowOf(v.rows, 'claude-sonnet-5-5', 'inputPerMTok')).toMatchObject({
      flags: [],
      ticked: true,
      verified: true,
    })
    const opus = rowOf(v.rows, 'claude-opus-5-5', 'inputPerMTok')
    expect(opus).toMatchObject({
      flags: ['notFetched'],
      ticked: false,
      reason: 'The update read no page on this site, so this price is not confirmed.',
    })
    expect(opus?.verified).toBeUndefined()
    expect(rowOf(v.rows, 'claude-opus-6')).toMatchObject({ kind: 'new-model', flags: ['notFetched'] })
    // A page it never read confirms nothing either.
    const none = checkProposal(current(), proposal(allClaude()), { ...ctx, fetchedHosts: [] })
    expect(none.rows).toEqual([])
  })

  it("a new model far (10×) from the vendor's other prices is suspicious, however small", () => {
    const cli = { claude: [...CLI_MODELS, { id: 'claude-tiny-9', source: 'cli' as const }] }
    const tiny = (inputPerMTok: number): CatalogDiffRow | undefined =>
      rowOf(
        validateProposal(
          current(),
          proposal([
            ...allClaude(),
            {
              ...proposed(OPUS),
              model: 'claude-tiny-9',
              aliases: [],
              inputPerMTok,
              outputPerMTok: 5,
              cacheReadPerMTok: null,
              cacheWritePerMTok: null,
            },
          ]),
          { cliModels: cli },
        ),
        'claude-tiny-9',
        'inputPerMTok',
      )
    expect(tiny(5e-324)).toMatchObject({ flags: ['suspicious'], ticked: false })
    expect(tiny(1e-7)?.reason).toBe("Far from this vendor's other input prices ($1 to $10).")
    expect(tiny(0.5)).toMatchObject({ flags: [], ticked: true })
  })

  it("the answer's aliases never match an entry nor count as the CLI's", () => {
    // A new model naming Opus's id as its alias: a new model, never Opus's price rows.
    const v = checkProposal(
      current(),
      proposal([
        ...allClaude(),
        {
          ...proposed(OPUS),
          model: 'totally-new',
          aliases: ['claude-opus-5-5', 'opus'],
          inputPerMTok: 9,
          outputPerMTok: 45,
        },
      ]),
      ctx,
    )
    expect(changes(v.rows).map((r) => [r.id, r.flags])).toEqual([
      ['price|claude|totally-new|inputPerMTok', ['notReportedByCli']],
      ['price|claude|totally-new|outputPerMTok', ['notReportedByCli']],
      ['price|claude|totally-new|cacheReadPerMTok', ['notReportedByCli']],
      ['price|claude|totally-new|cacheWritePerMTok', ['notReportedByCli']],
    ])
    expect(v.rows.some((r) => r.model === 'claude-opus-5-5' && r.kind !== 'confirm')).toBe(false)
  })

  it('a model the job named but its schema check refused is not offered as deprecated', () => {
    const p = proposal([proposed(OPUS), proposed(SONNET), proposed(FABLE)])
    const plain = checkProposal(current(), p, ctx)
    expect(rowOf(plain.rows, 'claude-haiku-4-5-20251001')?.kind).toBe('deprecate')
    const named = checkProposal(current(), p, {
      ...ctx,
      mentioned: [{ vendor: 'claude', model: 'claude-haiku-4-5-20251001' }],
    })
    expect(named.rows.some((r) => r.kind === 'deprecate')).toBe(false)
  })

  it('jobValidateContext reads status.json defensively', () => {
    expect(
      jobValidateContext({
        fetchedHosts: ['Platform.Claude.com'],
        vendors: ['claude'],
        mentioned: [{ vendor: 'claude', model: 'm' }, { vendor: 1 }, 'x'],
      }),
    ).toEqual({
      fetchedHosts: ['platform.claude.com'],
      vendors: ['claude'],
      mentioned: [{ vendor: 'claude', model: 'm' }],
    })
    expect(jobValidateContext({ fetchedHosts: [1], vendors: 'claude' })).toEqual({})
    expect(jobValidateContext(null)).toEqual({})
  })
})

describe('manual price bounds', () => {
  it('more than $0 and at most $1,000; cache prices may be empty', () => {
    const ok = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: null, cacheWritePerMTok: 1000 }
    expect(priceEditProblem(ok)).toBeNull()
    expect(priceEditProblem({ ...ok, inputPerMTok: 0 })).toBe(
      'The input price must be more than $0 and at most $1,000 per million tokens.',
    )
    expect(priceEditProblem({ ...ok, outputPerMTok: 1000.5 })).toContain('output price')
    expect(priceEditProblem({ ...ok, cacheReadPerMTok: -0.1 })).toBe(
      'The cache read price must be more than $0 and at most $1,000 per million tokens, or empty when the vendor has none.',
    )
    expect(priceEditProblem({ ...ok, inputPerMTok: Number.NaN })).not.toBeNull()
    expect(priceEditProblem({ ...ok, outputPerMTok: null })).not.toBeNull()
  })
})

const PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing'
