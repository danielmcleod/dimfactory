// The Plops page's lineup from core's UsageData (`usage.get{range}`): one Plop per vendor, and per vendor an "All
// <vendor>" Plop followed by one per model. Core gives the figures; this only words them and applies the Plop rules
// (src/shared/plops.ts): vendor sizes share one log scale; on the models' floor the "All" Plops and the models share
// another across every vendor, both over the active Plops (tokens in the period) only; the mood rests at puddle (used
// before, no tokens in the period: as wide as its lifetime tokens on that scale, no emission, never grows), sleepy,
// happy or idle and turns growing (once) when the Plop crossed a stage since the previous period; the emission follows
// the step signals. What plays from moment to moment (gas or smoke, snacks, the snack before growing) is
// plopAnimation.ts, not this.
import {
  crossedStage,
  logScale,
  modelColor,
  plopEmit,
  restingMood,
  stageOf,
  vendorColor,
} from '@shared/plops.ts'
import type { PlopEmit, PlopMood, PlopStage } from '@shared/plops.ts'
import type { ModelUsage, UsageData, UsageFigures, UsageSignals } from '@shared/usage.ts'
import { formatTokens, formatUsd, vendorName } from '../../lib/format.ts'

export interface PlopView {
  /** Stable per period, vendor and model (a growing Plop plays once per key). */
  key: string
  name: string
  color: string
  growth: number
  stage: PlopStage
  resting: Exclude<PlopMood, 'growing'>
  /** Crossed into a bigger stage since the previous period. */
  grew: boolean
  emit: PlopEmit
  tokensText: string
  costText: string
  /** Extra words for the accessible name (an API-equivalent price). */
  costNote?: string
}

export interface VendorView extends PlopView {
  vendor: string
  modelColors: string[]
  modelCountText: string
  /** The "All <vendor>" Plop on the models' floor. */
  all: PlopView
  models: PlopView[]
}

export const NO_PRICE_TEXT = 'No price'
export const DEFAULT_MODEL_NAME = 'Default model'

export function tokensText(n: number): string {
  return `${formatTokens(n)} ${n === 1 ? 'token' : 'tokens'}`
}

/** The cost line: a price, at least a price (some steps had none), or no price at all. */
export function costText(f: UsageFigures): string {
  if (f.costUsd === null) return NO_PRICE_TEXT
  return f.costPartial ? `At least ${formatUsd(f.costUsd)}` : formatUsd(f.costUsd)
}

export const modelName = (m: Pick<ModelUsage, 'model'>): string => m.model ?? DEFAULT_MODEL_NAME

// Running now shows as gas or smoke at random (plopAnimation.ts), so the name says both and stays put while the
// animation changes.
const EMIT_WORDS: Readonly<Record<PlopEmit, string>> = {
  none: '',
  smoke: 'gas or smoke (running now)',
  gas: 'gas or smoke (running now)',
  steam: 'steam (a rate or spend limit in the last 24 hours)',
  oil: 'oil (failed steps or re-runs)',
}

/** A mood's words in the accessible name, where the word alone would not say what it means. */
const MOOD_WORDS: Partial<Readonly<Record<PlopMood, string>>> = {
  puddle: 'puddle (used before, no tokens in this period)',
}

/** The SVG's accessible name: what it stands for, its usage, then its stage, mood and emission. */
export function plopLabel(v: PlopView, mood: PlopMood): string {
  const cost = v.costNote !== undefined ? `${v.costText} ${v.costNote}` : v.costText
  const emit = v.emit !== 'none' ? `, giving off ${EMIT_WORDS[v.emit]}` : ''
  return `${v.name}: ${v.tokensText}, ${cost}. ${v.stage} Plop, ${MOOD_WORDS[mood] ?? mood}${emit}`
}

function view(
  key: string,
  name: string,
  color: string,
  f: UsageFigures & UsageSignals & { previous: UsageFigures; lifetimeTokens: number },
  scale: (v: number) => number,
  now: number,
): PlopView {
  const resting = restingMood({
    tokens: f.tokens,
    previousTokens: f.previous.tokens,
    lastUsedAt: f.lastUsedAt,
    now,
    lifetimeTokens: f.lifetimeTokens,
    live: f.live,
  })
  // A puddle is as wide as its lifetime usage on the active Plops' scale; its label still says the period's usage.
  if (resting === 'puddle') {
    const growth = scale(f.lifetimeTokens)
    return {
      key,
      name,
      color,
      growth,
      stage: stageOf(growth),
      resting,
      grew: false,
      emit: 'none',
      tokensText: tokensText(f.tokens),
      // Nothing was spent in the period (not "No price", which says a cost is unknown).
      costText: f.costUsd === null ? formatUsd(0) : costText(f),
    }
  }
  const growth = scale(f.tokens)
  return {
    key,
    name,
    color,
    growth,
    stage: stageOf(growth),
    resting,
    grew: crossedStage(growth, f.previous.tokens > 0 ? scale(f.previous.tokens) : 0),
    emit: plopEmit(f),
    tokensText: tokensText(f.tokens),
    costText: costText(f),
  }
}

const active = (tokens: number): boolean => tokens > 0

export function buildLineup(data: UsageData): VendorView[] {
  const now = data.to
  // Both scales run over the active Plops only (tokens in the period): a puddle's lifetime tokens never stretch them.
  const vendorScale = logScale(data.vendors.map((v) => v.tokens).filter(active))
  // The models' floor: one scale over every model and every vendor total, so an "All <vendor>" Plop is never smaller
  // than one of its own models beside it.
  const floorScale = logScale(
    data.vendors.flatMap((v) => [v.tokens, ...v.models.map((m) => m.tokens)]).filter(active),
  )
  return data.vendors.map((v) => {
    const name = vendorName(v.vendor)
    const color = vendorColor(v.vendor)
    const base = view(`${data.range}:${v.vendor}`, name, color, v, vendorScale, now)
    const costNote = v.apiEquivalent && v.costUsd !== null ? 'API-equivalent' : undefined
    const vendorPlop: PlopView = { ...base, ...(costNote !== undefined ? { costNote } : {}) }
    const models = v.models.map((m, i) => {
      const mv = view(
        `${data.range}:${v.vendor}:${m.model ?? ''}`,
        modelName(m),
        modelColor(v.vendor, m.model, i),
        m,
        floorScale,
        now,
      )
      return costNote !== undefined && m.costUsd !== null ? { ...mv, costNote } : mv
    })
    return {
      ...vendorPlop,
      vendor: v.vendor,
      modelColors: models.map((m) => m.color),
      modelCountText: `${models.length} ${models.length === 1 ? 'model' : 'models'}`,
      all: {
        ...view(`${data.range}:${v.vendor}:all`, `All ${name}`, color, v, floorScale, now),
        ...(costNote !== undefined ? { costNote } : {}),
      },
      models,
    }
  })
}

/** The keys whose growing Plop has played this session (it plays once, then rests). */
const played = new Set<string>()

export function hasPlayed(key: string): boolean {
  return played.has(key)
}

export function markPlayed(key: string): void {
  played.add(key)
}

export function resetPlayedForTests(): void {
  played.clear()
}
