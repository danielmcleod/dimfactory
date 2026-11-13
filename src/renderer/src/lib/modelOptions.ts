// Model picker lists (a pass row's model: the CLI's list plus the catalog's, or free text, with a 'no pricing' chip).
// Core's vendors.models already joins the CLI's models with the
// catalog's and says which have a price; a picker shows the CLI's models first, then the catalog's, each id once, the
// value in use kept even when neither lists it, and "no pricing" beside a model core cannot price. Nothing here
// decides a price: `hasPricing` is core's.
import type { ModelOption } from '@shared/vendors.ts'

/** The note a model without a price carries in a picker. */
export const NO_PRICING = 'no pricing'

/** A picker row: one of core's options, or the value in use that no option lists. */
export type PickerRow = Pick<ModelOption, 'id'> & Partial<Omit<ModelOption, 'id'>>

/**
 * CLI models first (in core's order), then the catalog's (in core's order), each id once; `current` first when no
 * option answers to it (a model typed into the config by hand).
 */
export function pickerOptions(options: readonly ModelOption[], current?: string | null): PickerRow[] {
  const seen = new Set<string>()
  const cli: ModelOption[] = []
  const catalog: ModelOption[] = []
  for (const o of options) {
    if (seen.has(o.id)) continue
    seen.add(o.id)
    if (o.source === 'catalog') catalog.push(o)
    else cli.push(o)
  }
  const out: PickerRow[] = [...cli, ...catalog]
  if (
    current !== undefined &&
    current !== null &&
    current !== '' &&
    !options.some((o) => o.id === current || o.aliases?.includes(current) === true)
  )
    out.unshift({ id: current })
  return out
}

/** `Opus 5.5 (claude-opus-5-5)`, then ` · no pricing` when core knows no price for it and ` · deprecated`. */
export function modelOptionText(o: PickerRow): string {
  const name = o.label !== undefined && o.label !== o.id ? `${o.label} (${o.id})` : o.id
  const notes = [o.hasPricing === false ? NO_PRICING : null, o.deprecated === true ? 'deprecated' : null]
  return [name, ...notes.filter((n): n is string => n !== null)].join(' · ')
}
