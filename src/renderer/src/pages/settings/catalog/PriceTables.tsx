// Settings → Catalog's price tables, editable (manual edits set confidence:'user'). Edit opens one row's four prices as boxes in place;
// Save sends catalog.savePrice (core stores the entry as `confidence: 'user'` through the same atomic write and history
// as an applied update) and the toast offers Undo (catalog.undo). A price you set is marked "Edited by you". Add a
// price opens the same boxes for a model core has no price for yet.
import { Pencil, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import type { CatalogState, PriceConfidence, PriceEdit, PriceEntry, PriceField } from '@shared/catalog.ts'
import { PRICE_FIELDS } from '@shared/catalog.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Input } from '../../../components/ui/Input.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { vendorName } from '../../../lib/format.ts'
import { saveCatalogPrice } from '../../../state/catalog.ts'
import { toast } from '../../../state/toasts.ts'
import { SETTINGS_TABLE } from '../kit.tsx'
import {
  PRICE_FIELD_LABEL,
  formatDay,
  formatPrice,
  hostOf,
  parseModelId,
  parsePriceInput,
  priceInputText,
} from './model.ts'

export const CONFIDENCE_WORD: Readonly<Record<PriceConfidence, string>> = {
  verified: 'Verified',
  unverified: 'Not verified',
  user: 'Edited by you',
}

const REQUIRED: ReadonlySet<PriceField> = new Set(['inputPerMTok', 'outputPerMTok'])

async function openSource(url: string): Promise<void> {
  const r = await invoke('shell.open', { target: 'url', url })
  if (!r.ok) toast({ level: 'error', message: r.error.message })
}

type Texts = Record<PriceField, string>

const textsOf = (e: Pick<PriceEntry, PriceField> | null): Texts => ({
  inputPerMTok: e === null ? '' : priceInputText(e.inputPerMTok),
  outputPerMTok: e === null ? '' : priceInputText(e.outputPerMTok),
  cacheReadPerMTok: e === null ? '' : priceInputText(e.cacheReadPerMTok),
  cacheWritePerMTok: e === null ? '' : priceInputText(e.cacheWritePerMTok),
})

/** The four boxes checked: the prices, or each field's message. */
function readPrices(
  texts: Texts,
):
  | { ok: true; prices: Pick<PriceEdit, PriceField> }
  | { ok: false; errors: Partial<Record<PriceField, string>> } {
  const errors: Partial<Record<PriceField, string>> = {}
  const values: Partial<Record<PriceField, number | null>> = {}
  for (const f of PRICE_FIELDS) {
    const r = parsePriceInput(texts[f], REQUIRED.has(f))
    if (r.ok) values[f] = r.value
    else errors[f] = r.message
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    prices: {
      inputPerMTok: values.inputPerMTok ?? 0,
      outputPerMTok: values.outputPerMTok ?? 0,
      cacheReadPerMTok: values.cacheReadPerMTok ?? null,
      cacheWritePerMTok: values.cacheWritePerMTok ?? null,
    },
  }
}

function errorText(errors: Partial<Record<PriceField, string>>, extra?: string): string[] {
  const out = PRICE_FIELDS.flatMap((f) => {
    const m = errors[f]
    return m !== undefined ? [`${PRICE_FIELD_LABEL[f]}: ${m}`] : []
  })
  return extra !== undefined ? [extra, ...out] : out
}

function PriceBox({
  label,
  value,
  invalid,
  describedBy,
  onChange,
  onKey,
  testId,
}: {
  label: string
  value: string
  invalid: boolean
  describedBy: string | undefined
  onChange: (v: string) => void
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void
  testId: string
}): React.JSX.Element {
  return (
    <Input
      aria-label={label}
      data-testid={testId}
      inputMode="decimal"
      spellCheck={false}
      value={value}
      placeholder="None"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKey}
      className="h-7 w-full px-1.5 text-xs tabular-nums"
    />
  )
}

const COLUMNS = ['Model', 'Input', 'Output', 'Cache read', 'Cache write', 'Source', 'Edit'] as const

function PriceRow({
  entry,
  editing,
  onEdit,
  onDone,
  busy,
  setBusy,
}: {
  entry: PriceEntry
  editing: boolean
  onEdit: () => void
  onDone: () => void
  busy: boolean
  setBusy: (b: boolean) => void
}): React.JSX.Element {
  const [texts, setTexts] = useState<Texts>(() => textsOf(entry))
  const [errors, setErrors] = useState<Partial<Record<PriceField, string>>>({})
  const errorId = useId()
  const key = `${entry.vendor}-${entry.model}`
  const host = entry.sourceUrl !== '' ? hostOf(entry.sourceUrl) : null

  const cancel = (): void => {
    setTexts(textsOf(entry))
    setErrors({})
    onDone()
  }
  const save = async (): Promise<void> => {
    const r = readPrices(texts)
    if (!r.ok) {
      setErrors(r.errors)
      return
    }
    setErrors({})
    const same = PRICE_FIELDS.every((f) => r.prices[f] === entry[f])
    if (same) {
      onDone()
      return
    }
    setBusy(true)
    const ok = await saveCatalogPrice({
      vendor: entry.vendor,
      model: entry.model,
      ...r.prices,
      ...(entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}),
    })
    setBusy(false)
    if (ok) onDone()
  }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }
  const messages = errorText(errors)

  return (
    <>
      <tr data-testid={`catalog-price-${key}`} data-editing={editing || undefined} className="border-t">
        <th scope="row" className={cn(SETTINGS_TABLE.cell, 'font-normal')}>
          <span className="font-mono">{entry.model}</span>
          {entry.aliases.length > 0 && (
            <span className="block text-muted-foreground">{entry.aliases.join(', ')}</span>
          )}
          {entry.deprecated === true && <span className="block text-warning">Deprecated</span>}
        </th>
        {PRICE_FIELDS.map((f) => (
          <td key={f} className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>
            {editing ? (
              <PriceBox
                label={`${entry.model} ${PRICE_FIELD_LABEL[f].toLowerCase()} price`}
                testId={`catalog-edit-${key}-${f}`}
                value={texts[f]}
                invalid={errors[f] !== undefined}
                describedBy={messages.length > 0 ? errorId : undefined}
                onChange={(v) => setTexts((t) => ({ ...t, [f]: v }))}
                onKey={onKey}
              />
            ) : (
              formatPrice(entry[f])
            )}
          </td>
        ))}
        <td className={SETTINGS_TABLE.cell}>
          <span
            className={cn('flex items-center gap-1', entry.confidence === 'user' && 'text-primary')}
            {...(entry.confidence === 'user' ? { 'data-testid': `catalog-edited-${key}` } : {})}
          >
            {entry.confidence === 'user' && <Pencil aria-hidden className="size-3 shrink-0" />}
            {CONFIDENCE_WORD[entry.confidence] ?? entry.confidence}
          </span>
          <span className="block text-muted-foreground">{formatDay(entry.fetchedAt)}</span>
          {/* The host and the quote are in the tooltip: the column is narrow at a large page zoom. */}
          {host !== null && (
            <button
              type="button"
              title={entry.sourceQuote !== undefined ? `${host}: ${entry.sourceQuote}` : entry.sourceUrl}
              aria-label={`Price page on ${host}`}
              className="rounded-sm text-left text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => void openSource(entry.sourceUrl)}
            >
              Price page
            </button>
          )}
        </td>
        <td className={SETTINGS_TABLE.cell}>
          {editing ? (
            <span className="flex flex-col items-start gap-1">
              <Button
                size="sm"
                data-testid={`catalog-save-${key}`}
                loading={busy}
                onClick={() => void save()}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`catalog-edit-${key}`}
              aria-label={`Edit ${entry.model} prices`}
              icon={<Pencil aria-hidden />}
              disabled={busy}
              onClick={() => {
                setTexts(textsOf(entry))
                setErrors({})
                onEdit()
              }}
            >
              Edit
            </Button>
          )}
        </td>
      </tr>
      {editing && messages.length > 0 && (
        <tr>
          <td colSpan={COLUMNS.length} className={SETTINGS_TABLE.cell}>
            <p
              id={errorId}
              role="alert"
              data-testid={`catalog-edit-error-${key}`}
              className="text-destructive"
            >
              {messages.join(' ')}
            </p>
          </td>
        </tr>
      )}
    </>
  )
}

function PriceTable({
  vendor,
  entries,
  editing,
  setEditing,
  busy,
  setBusy,
}: {
  vendor: string
  entries: readonly PriceEntry[]
  editing: string | null
  setEditing: (key: string | null) => void
  busy: boolean
  setBusy: (b: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{vendorName(vendor)}</h4>
      <div className={SETTINGS_TABLE.frame}>
        <table
          aria-label={`${vendorName(vendor)} prices`}
          data-testid={`catalog-prices-${vendor}`}
          className={SETTINGS_TABLE.table}
        >
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {COLUMNS.map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={cn(
                    SETTINGS_TABLE.cell,
                    'font-medium',
                    i === 0 && 'w-1/5',
                    i === 5 && 'w-1/6',
                    i === 6 && 'w-20',
                  )}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const key = `${e.vendor}/${e.model}`
              return (
                <PriceRow
                  key={key}
                  entry={e}
                  editing={editing === key}
                  onEdit={() => setEditing(key)}
                  onDone={() => setEditing(null)}
                  busy={busy && editing === key}
                  setBusy={setBusy}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A price for a model core has none for (Add a price): vendor, model id and the four prices. */
function AddPrice({
  vendors,
  onDone,
}: {
  vendors: readonly string[]
  onDone: () => void
}): React.JSX.Element {
  const [vendor, setVendor] = useState(vendors[0] ?? 'claude')
  const [model, setModel] = useState('')
  const [texts, setTexts] = useState<Texts>(() => textsOf(null))
  const [errors, setErrors] = useState<Partial<Record<PriceField, string>>>({})
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const errorId = useId()

  const save = async (): Promise<void> => {
    const id = parseModelId(model)
    const r = readPrices(texts)
    setModelError(id.ok ? undefined : id.message)
    setErrors(r.ok ? {} : r.errors)
    if (!id.ok || !r.ok) return
    setBusy(true)
    const ok = await saveCatalogPrice({ vendor, model: id.model, ...r.prices })
    setBusy(false)
    if (ok) onDone()
  }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onDone()
    }
  }
  const messages = errorText(errors, modelError !== undefined ? `Model: ${modelError}` : undefined)

  return (
    <div data-testid="catalog-add-form" className="flex flex-col gap-2 rounded-md border p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Vendor</span>
          <Select value={vendor} onValueChange={setVendor}>
            <SelectTrigger
              size="sm"
              className="w-full"
              aria-label="New price vendor"
              data-testid="catalog-add-vendor"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {vendors.map((v) => (
                <SelectItem key={v} value={v}>
                  {vendorName(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Model id</span>
          <Input
            aria-label="New price model id"
            data-testid="catalog-add-model"
            spellCheck={false}
            value={model}
            aria-invalid={modelError !== undefined || undefined}
            aria-describedby={messages.length > 0 ? errorId : undefined}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={onKey}
            className="h-7 w-full px-1.5 font-mono text-xs"
          />
        </label>
        {PRICE_FIELDS.map((f) => (
          <label key={f} className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {PRICE_FIELD_LABEL[f]}
              {REQUIRED.has(f) ? '' : ' (optional)'}
            </span>
            <PriceBox
              label={`New price ${PRICE_FIELD_LABEL[f].toLowerCase()}`}
              testId={`catalog-add-${f}`}
              value={texts[f]}
              invalid={errors[f] !== undefined}
              describedBy={messages.length > 0 ? errorId : undefined}
              onChange={(v) => setTexts((t) => ({ ...t, [f]: v }))}
              onKey={onKey}
            />
          </label>
        ))}
      </div>
      {messages.length > 0 && (
        <p id={errorId} role="alert" data-testid="catalog-add-error" className="text-xs text-destructive">
          {messages.join(' ')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" data-testid="catalog-add-save" loading={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Every vendor's price table, one row editable at a time, and Add a price. */
export function PriceTables({
  state,
  vendors,
}: {
  state: CatalogState
  vendors: readonly string[]
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const byVendor = new Map<string, PriceEntry[]>()
  for (const e of state.pricing.entries) byVendor.set(e.vendor, [...(byVendor.get(e.vendor) ?? []), e])
  const addVendors = [...new Set([...vendors, ...byVendor.keys()])]
  return (
    <>
      {byVendor.size === 0 ? (
        <p className="text-xs text-muted-foreground">No prices are recorded.</p>
      ) : (
        [...byVendor].map(([vendor, entries]) => (
          <PriceTable
            key={vendor}
            vendor={vendor}
            entries={entries}
            editing={editing}
            setEditing={(k) => {
              setAdding(false)
              setEditing(k)
            }}
            busy={busy}
            setBusy={setBusy}
          />
        ))
      )}
      {adding ? (
        <AddPrice vendors={addVendors.length > 0 ? addVendors : ['claude']} onDone={() => setAdding(false)} />
      ) : (
        <div data-setting-field="addPrice">
          <Button
            size="sm"
            variant="outline"
            data-testid="catalog-add-price"
            icon={<Plus aria-hidden />}
            disabled={busy}
            onClick={() => {
              setEditing(null)
              setAdding(true)
            }}
          >
            Add a price
          </Button>
        </div>
      )}
    </>
  )
}
