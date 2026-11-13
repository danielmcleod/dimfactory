// Settings → Vendors → Local models (`local.presets`, user-only: add, a `/models` dropdown, a context warning, Test).
// A preset is an OpenAI-compatible server on this
// computer (Ollama, LM Studio) that Codex runs as `dim_factory_local`; passes pick it as `local-<id>` ("Local · <label>").
//
// - Add / Edit open one inline form (never a dialog): name, id (from the name until edited; kept once saved, since
//   passes name it), the server's address (a loopback host only: Dim Factory never sends a request off this computer),
//   the model, the API key's environment variable (its name only; the key is never read or stored) and the context
//   window, with each problem under its field. Save writes `/local/presets` in your settings (config.patch, user file)
//   with Undo; Remove too (and the preset's own `vendors.local-<id>` settings, which would no longer name anything).
// - The model dropdown lists the server's `/models` (core asks the server: vendors.models `local-<id>`), read when the
//   list is opened or a Test ran. A context window under 32k tokens (set, or the server's) gets a warning.
// - Test (= what core can check without tokens): a forced probe of `local-<id>` when core probes presets (its checks
//   local-server, local-responses, local-context with their fixes), else the server's model list; the answer is the
//   row's status line.
//
// The section's data is read once it has been open a moment (sectionData.ts, performance.spec.ts), and the list is the section's last
// content, below [Add a local model], so its arrival moves nothing. Test ids: `local-presets`, `local-preset-add`,
// `local-preset-<id>` with `-status`, `-test`, `-edit`, `-remove`, `-model`, `-context`, `-context-warning`, `-checks`;
// the form `local-preset-form` and its fields `local-preset-field-<field>` (`-error` under each).
import { Pencil, PlugZap, Plus, Save, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import type { CheckResult } from '@shared/preflight.ts'
import type { LocalPreset, ModelInfo } from '@shared/vendors.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { DisabledHint } from '../../../components/ui/DisabledHint.tsx'
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
import { useConfigEpoch } from '../../../state/selectors.ts'
import { toast } from '../../../state/toasts.ts'
import { forVendor } from '../../dashboard/composer/useVendorModels.ts'
import { settingFieldProps } from '../index.ts'
import { Group } from '../kit.tsx'
import { useSectionData } from '../sectionData.ts'
import { ChecksList } from './ChecksList.tsx'
import {
  contextWarning,
  draftOf,
  EMPTY_DRAFT,
  hasVendorSettings,
  MAX_PRESETS,
  parseContext,
  POINTER,
  presetsOf,
  presetsOps,
  presetVendor,
  slugId,
  tokensText,
  URL_EXAMPLE,
  validateDraft,
} from './localPresets.ts'
import type { DraftErrors, DraftField, PresetDraft } from './localPresets.ts'

export const ADD_LABEL = 'Add a local model'
const NEW = '\u0000new'

// ---- Test -----------------------------------------------------------------------------------------------------------

export interface PresetTestResult {
  /** ok: the server answered as a preset needs; failed: it did not; unknown: this core cannot check it from here. */
  status: 'ok' | 'failed' | 'unknown'
  /** One line for the row's status. */
  line: string
  /** Core's checks of the preset (local-server, local-responses, local-context), when core probes presets. */
  checks: CheckResult[]
  /** The server's models (`GET {baseUrl}/models`), when they were read. */
  models: ModelInfo[]
}

function modelsLine(n: number): string {
  return `Server answered · ${n} ${n === 1 ? 'model' : 'models'}`
}

function lists(models: readonly ModelInfo[], model: string): boolean {
  return models.some((m) => m.id === model || m.aliases?.includes(model) === true)
}

/** What Test says when this core reads no local server from Settings (it still checks one before each run). */
export const NOT_CHECKED_HERE =
  'Not checked from here: the preflight checks the server before each run that uses it (no tokens).'

/**
 * Test a saved preset without spending tokens (core's HTTP goes to loopback only). First core's
 * forced probe of `local-<id>` when it answers for presets (its local-server, local-responses and local-context checks
 * and the server's models); else the server's model list (vendors.models `local-<id>`, source `local-server`). A core
 * that answers with Codex's own models has not read the server: that is said, never taken for a failure.
 */
export async function testPreset(p: LocalPreset): Promise<PresetTestResult> {
  const vendor = presetVendor(p.id)
  const probed = await invoke('vendors.probe', { vendor, force: true })
  const view = probed.ok ? probed.value.find((v) => v.vendor === vendor) : undefined
  if (view?.probe !== undefined && view.probe !== null) {
    const checks = view.probe.checks
    const models = view.probe.models.filter((m) => m.source === 'local-server')
    const failing = checks.find((c) => c.status === 'fail')
    if (failing !== undefined) return { status: 'failed', line: failing.title, checks, models }
    const warning = checks.find((c) => c.status === 'warn')
    return {
      status: 'ok',
      line:
        warning !== undefined
          ? warning.title
          : models.length > 0
            ? modelsLine(models.length)
            : view.healthDetail,
      checks,
      models,
    }
  }
  const listed = await invoke('vendors.models', { vendor, force: true })
  if (!listed.ok) {
    return listed.error.code === 'NOT_FOUND' || listed.error.code === 'UNSUPPORTED'
      ? { status: 'unknown', line: NOT_CHECKED_HERE, checks: [], models: [] }
      : {
          status: 'failed',
          line: `Could not reach the server: ${listed.error.message}`,
          checks: [],
          models: [],
        }
  }
  const models = forVendor(vendor, listed.value)
  if (models.length === 0) {
    // Codex's own list came back: this core did not ask the local server.
    if (listed.value.length > 0) return { status: 'unknown', line: NOT_CHECKED_HERE, checks: [], models: [] }
    return {
      status: 'failed',
      line: `Could not list the server's models. Is it running at ${p.baseUrl}?`,
      checks: [],
      models: [],
    }
  }
  if (!lists(models, p.model))
    return { status: 'failed', line: `The server does not list ${p.model}`, checks: [], models }
  return { status: 'ok', line: modelsLine(models.length), checks: [], models }
}

type TestState = { state: 'running' } | ({ state: 'done' } & PresetTestResult)
type ModelsState = ModelInfo[] | 'loading' | { error: string }

// ---- the form -------------------------------------------------------------------------------------------------------

const FIELD_LABEL: Readonly<Record<DraftField, string>> = {
  label: 'Name',
  id: 'Id',
  baseUrl: 'Server address',
  model: 'Model',
  apiKeyEnv: 'API key variable',
  contextWindow: 'Context window',
}

const FIELD_HINT: Partial<Record<DraftField, string>> = {
  id: 'Passes name it as local-<id>. It cannot change once saved.',
  baseUrl: 'A server on this computer with the OpenAI Responses API.',
  apiKeyEnv:
    'Optional. The name of the environment variable Codex reads the key from; Dim Factory never stores a key.',
  contextWindow: 'Optional, in tokens. Leave it empty to use what the server says.',
}

const FIELD_PLACEHOLDER: Partial<Record<DraftField, string>> = {
  label: 'Qwen on Ollama',
  baseUrl: URL_EXAMPLE,
  model: 'qwen2.5-coder:14b',
  apiKeyEnv: 'LOCAL_LLM_API_KEY',
  contextWindow: '32768',
}

function FormField({
  name: field,
  draft,
  error,
  disabled,
  onChange,
  list,
  inputMode,
}: {
  /** Which draft field. Named `name`: the Settings index test reads a `field` attribute as a row id. */
  name: DraftField
  draft: PresetDraft
  error: string | undefined
  disabled?: boolean
  onChange: (field: DraftField, value: string) => void
  list?: string | undefined
  inputMode?: 'numeric' | undefined
}): React.JSX.Element {
  const id = useId()
  const hint = FIELD_HINT[field]
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`local-preset-field-${field}-row`}>
      <label htmlFor={id} className="text-xs font-medium">
        {FIELD_LABEL[field]}
      </label>
      <Input
        id={id}
        data-testid={`local-preset-field-${field}`}
        value={draft[field]}
        disabled={disabled}
        spellCheck={false}
        placeholder={FIELD_PLACEHOLDER[field]}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={`${id}-hint ${id}-error`}
        list={list}
        inputMode={inputMode}
        onChange={(e) => onChange(field, e.target.value)}
        className={cn('h-8 text-xs', field === 'baseUrl' || field === 'model' ? 'font-mono' : undefined)}
      />
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <p
        id={`${id}-error`}
        role={error !== undefined ? 'alert' : undefined}
        data-testid={`local-preset-field-${field}-error`}
        className="text-xs text-destructive empty:hidden"
      >
        {error ?? ''}
      </p>
    </div>
  )
}

function PresetForm({
  initial,
  isNew,
  others,
  models,
  saving,
  onSave,
  onCancel,
}: {
  initial: PresetDraft
  isNew: boolean
  /** The other presets' ids. */
  others: ReadonlySet<string>
  /** The server's models for the datalist, when known. */
  models: readonly ModelInfo[]
  saving: boolean
  onSave: (preset: LocalPreset) => Promise<boolean>
  onCancel: () => void
}): React.JSX.Element {
  const listId = useId()
  const [draft, setDraft] = useState<PresetDraft>(initial)
  const [idTouched, setIdTouched] = useState(!isNew)
  const [errors, setErrors] = useState<DraftErrors>({})
  const change = (field: DraftField, value: string): void => {
    setDraft((d) => {
      const next = { ...d, [field]: value }
      if (field === 'label' && isNew && !idTouched) next.id = slugId(value, others)
      return next
    })
    if (field === 'id') setIdTouched(true)
    if (errors[field] !== undefined) setErrors((e) => ({ ...e, [field]: undefined }))
  }
  const warning = contextWarning(parseContext(draft.contextWindow))
  const submit = async (): Promise<void> => {
    const v = validateDraft(draft, others)
    if (!v.ok) {
      setErrors(v.errors)
      return
    }
    setErrors({})
    await onSave(v.preset)
  }
  return (
    <form
      data-testid="local-preset-form"
      aria-label={isNew ? ADD_LABEL : `Edit ${initial.label}`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3"
    >
      <div className="grid grid-cols-1 gap-3 @min-[37.5rem]:grid-cols-2">
        <FormField name="label" draft={draft} error={errors.label} onChange={change} />
        <FormField name="id" draft={draft} error={errors.id} disabled={!isNew} onChange={change} />
        <FormField name="baseUrl" draft={draft} error={errors.baseUrl} onChange={change} />
        <FormField
          name="model"
          draft={draft}
          error={errors.model}
          onChange={change}
          list={models.length > 0 ? listId : undefined}
        />
        <FormField name="apiKeyEnv" draft={draft} error={errors.apiKeyEnv} onChange={change} />
        <FormField
          name="contextWindow"
          draft={draft}
          error={errors.contextWindow}
          onChange={change}
          inputMode="numeric"
        />
      </div>
      {models.length > 0 && (
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.contextWindow !== undefined ? `${tokensText(m.contextWindow)} context` : ''}
            </option>
          ))}
        </datalist>
      )}
      {warning !== null && (
        <p data-testid="local-preset-form-context-warning" className="text-xs text-warning">
          {warning}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="submit"
          data-testid="local-preset-save"
          icon={<Save aria-hidden />}
          loading={saving}
        >
          Save
        </Button>
        <Button size="sm" type="button" variant="ghost" data-testid="local-preset-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ---- a saved preset ---------------------------------------------------------------------------------------------------

/** The context window a row states: the preset's own, else the server's for its model. */
function contextOf(
  p: LocalPreset,
  models: ModelsState | undefined,
): { tokens?: number; from: 'preset' | 'server' } {
  if (p.contextWindow !== undefined) return { tokens: p.contextWindow, from: 'preset' }
  const m = Array.isArray(models) ? models.find((x) => x.id === p.model) : undefined
  return m?.contextWindow !== undefined ? { tokens: m.contextWindow, from: 'server' } : { from: 'server' }
}

function ModelSelect({
  preset: p,
  models,
  busy,
  onOpen,
  onChoose,
}: {
  preset: LocalPreset
  models: ModelsState | undefined
  busy: boolean
  onOpen: () => void
  onChoose: (model: string) => void
}): React.JSX.Element {
  const listed = Array.isArray(models) ? models : []
  const rows = [...(listed.some((m) => m.id === p.model) ? [] : [{ id: p.model } as ModelInfo]), ...listed]
  const note =
    models === undefined
      ? null
      : models === 'loading'
        ? "Reading the server's models…"
        : !Array.isArray(models)
          ? `Could not read the server's models: ${models.error}`
          : models.length === 0
            ? 'The server listed no models'
            : null
  return (
    <Select
      value={p.model}
      disabled={busy}
      onOpenChange={(open) => {
        if (open) onOpen()
      }}
      onValueChange={(v) => {
        if (v !== p.model) onChoose(v)
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-64 max-w-full font-mono"
        data-testid={`local-preset-${p.id}-model`}
        aria-label={`${p.label} model`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {rows.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.id}
            {m.contextWindow !== undefined ? ` · ${tokensText(m.contextWindow)} context` : ''}
          </SelectItem>
        ))}
        {note !== null && (
          <SelectItem value="__note__" disabled>
            {note}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}

function PresetRow({
  preset: p,
  test,
  models,
  editing,
  writing,
  onTest,
  onEdit,
  onRemove,
  onOpenModels,
  onChooseModel,
  form,
}: {
  preset: LocalPreset
  test: TestState | undefined
  models: ModelsState | undefined
  editing: boolean
  writing: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  onOpenModels: () => void
  onChooseModel: (model: string) => void
  form: React.ReactNode
}): React.JSX.Element {
  const testing = test?.state === 'running'
  const status = test === undefined ? '' : test.state === 'running' ? 'Testing…' : test.line
  const statusTone =
    test?.state !== 'done'
      ? 'text-muted-foreground'
      : test.status === 'ok'
        ? 'text-success'
        : test.status === 'failed'
          ? 'text-destructive'
          : 'text-muted-foreground'
  const ctx = contextOf(p, models)
  const warning = contextWarning(ctx.tokens)
  const checks = test?.state === 'done' ? test.checks : []
  return (
    <li data-testid={`local-preset-${p.id}`} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="max-w-full truncate text-sm font-medium" title={p.label}>
          {p.label}
        </span>
        <code className="text-xs text-muted-foreground">{presetVendor(p.id)}</code>
        <p
          role="status"
          data-testid={`local-preset-${p.id}-status`}
          data-result={test?.state === 'done' ? test.status : test?.state}
          title={status !== '' ? status : undefined}
          className={cn('min-w-32 flex-1 truncate text-xs', statusTone)}
        >
          {status}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            data-testid={`local-preset-${p.id}-test`}
            icon={<PlugZap aria-hidden />}
            loading={testing}
            title="Check the server now (no tokens are spent)"
            onClick={onTest}
          >
            Test
          </Button>
          {editing ? (
            <DisabledHint reason="The form below edits it">
              <Button
                size="sm"
                variant="outline"
                disabled
                icon={<Pencil aria-hidden />}
                data-testid={`local-preset-${p.id}-edit`}
              >
                Edit
              </Button>
            </DisabledHint>
          ) : (
            <Button
              size="sm"
              variant="outline"
              icon={<Pencil aria-hidden />}
              data-testid={`local-preset-${p.id}-edit`}
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 aria-hidden />}
            loading={writing}
            data-testid={`local-preset-${p.id}-remove`}
            aria-label={`Remove ${p.label}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Server</dt>
        <dd className="font-mono [overflow-wrap:anywhere]">{p.baseUrl}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="min-w-0">
          <ModelSelect
            preset={p}
            models={models}
            busy={writing}
            onOpen={onOpenModels}
            onChoose={onChooseModel}
          />
        </dd>
        <dt className="text-muted-foreground">Context</dt>
        <dd data-testid={`local-preset-${p.id}-context`}>
          {ctx.tokens !== undefined
            ? `${tokensText(ctx.tokens)} tokens${ctx.from === 'server' ? " (the server's)" : ''}`
            : "Not set: the server's own"}
        </dd>
        {p.apiKeyEnv !== undefined && (
          <>
            <dt className="text-muted-foreground">API key</dt>
            <dd>
              From <code className="font-mono">{p.apiKeyEnv}</code>
            </dd>
          </>
        )}
      </dl>
      {warning !== null && (
        <p data-testid={`local-preset-${p.id}-context-warning`} className="text-xs text-warning">
          {warning}
        </p>
      )}
      {checks.length > 0 && (
        <div data-testid={`local-preset-${p.id}-checks`}>
          <ChecksList label={`${p.label} checks`} checks={checks} />
        </div>
      )}
      {form}
    </li>
  )
}

// ---- the group ------------------------------------------------------------------------------------------------------

export function LocalPresetsGroup(): React.JSX.Element {
  const epoch = useConfigEpoch()
  const data = useSectionData('local-presets', () => invoke('config.read', { scope: 'user' }), epoch)
  const value = data.value?.value
  const presets = data.value !== null ? presetsOf(value) : null
  const [editing, setEditing] = useState<string | null>(null)
  const [writing, setWriting] = useState<string | null>(null)
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({})
  const [models, setModels] = useState<Readonly<Record<string, ModelsState>>>({})

  const write = async (
    next: readonly LocalPreset[],
    said: string,
    tag: string,
    removeVendorOf?: string,
  ): Promise<boolean> => {
    const before = presets ?? []
    setWriting(tag)
    const r = await invoke('config.patch', { scope: 'user', ops: presetsOps(next, removeVendorOf) })
    setWriting(null)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return false
    }
    data.reload()
    const backupId = r.value.backupId
    toast({
      id: 'local-presets-write',
      level: 'info',
      message: said,
      action: {
        label: 'Undo',
        onClick: async () => {
          const u =
            backupId !== null
              ? await invoke('config.restoreBackup', { scope: 'user', backupId })
              : await invoke('config.patch', { scope: 'user', ops: presetsOps(before) })
          if (!u.ok) toast({ level: 'error', message: u.error.message })
          data.reload()
        },
      },
    })
    return true
  }

  /** The server's models for the dropdown: read once (again after a failure); a Test reads them too. */
  const readModels = async (p: LocalPreset): Promise<void> => {
    const cur = models[p.id]
    if (cur === 'loading' || Array.isArray(cur)) return
    setModels((m) => ({ ...m, [p.id]: 'loading' }))
    const vendor = presetVendor(p.id)
    const r = await invoke('vendors.models', { vendor, force: true })
    setModels((m) => ({ ...m, [p.id]: r.ok ? forVendor(vendor, r.value) : { error: r.error.message } }))
  }

  const test = async (p: LocalPreset): Promise<void> => {
    setTests((t) => ({ ...t, [p.id]: { state: 'running' } }))
    const result = await testPreset(p)
    setTests((t) => ({ ...t, [p.id]: { state: 'done', ...result } }))
    if (result.models.length > 0) setModels((m) => ({ ...m, [p.id]: result.models }))
  }

  const save = async (preset: LocalPreset, isNew: boolean): Promise<boolean> => {
    const list = presets ?? []
    const next = isNew ? [...list, preset] : list.map((x) => (x.id === preset.id ? preset : x))
    const ok = await write(next, isNew ? `Added ${preset.label}` : `Saved ${preset.label}`, 'form')
    if (ok) setEditing(null)
    return ok
  }

  const remove = (p: LocalPreset): void => {
    const list = presets ?? []
    void write(
      list.filter((x) => x.id !== p.id),
      `Removed ${p.label}`,
      `remove:${p.id}`,
      hasVendorSettings(value, p.id) ? p.id : undefined,
    ).then((ok) => {
      if (ok && editing === p.id) setEditing(null)
    })
  }

  const chooseModel = (p: LocalPreset, model: string): void => {
    const list = presets ?? []
    void write(
      list.map((x) => (x.id === p.id ? { ...x, model } : x)),
      `${p.label} runs ${model}`,
      `model:${p.id}`,
    )
  }

  const ids = new Set((presets ?? []).map((p) => p.id))
  const othersOf = (id: string | null): ReadonlySet<string> => new Set([...ids].filter((x) => x !== id))
  const full = presets !== null && presets.length >= MAX_PRESETS
  const addReason =
    presets === null
      ? 'Reading your settings…'
      : full
        ? `At most ${MAX_PRESETS} local models`
        : editing === NEW
          ? 'The form below adds one'
          : null
  const listedModels = (id: string): ModelInfo[] => {
    const m = models[id]
    return Array.isArray(m) ? m : []
  }

  const addButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<Plus aria-hidden />}
      data-testid="local-preset-add"
      disabled={addReason !== null}
      onClick={() => setEditing(NEW)}
    >
      {ADD_LABEL}
    </Button>
  )

  return (
    <Group
      title="Local models"
      description="A model served on this computer by an OpenAI-compatible server with the Responses API (Ollama, LM Studio), run through Codex. Dim Factory sends its requests only to this computer, and their cost is zero."
      testId="local-presets"
    >
      <div {...settingFieldProps(POINTER)} className="flex flex-wrap gap-2">
        {addReason !== null ? <DisabledHint reason={addReason}>{addButton}</DisabledHint> : addButton}
      </div>
      {editing === NEW && presets !== null && (
        <PresetForm
          initial={EMPTY_DRAFT}
          isNew
          others={othersOf(null)}
          models={[]}
          saving={writing === 'form'}
          onSave={(p) => save(p, true)}
          onCancel={() => setEditing(null)}
        />
      )}
      {presets === null ? (
        <p className="text-xs text-muted-foreground" data-testid="local-presets-reading">
          {data.error !== null ? `Could not read your settings: ${data.error}` : 'Reading your local models…'}
        </p>
      ) : presets.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="local-presets-empty">
          No local models yet.
        </p>
      ) : (
        <ul aria-label="Local models" className="flex flex-col gap-2">
          {presets.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              test={tests[p.id]}
              models={models[p.id]}
              editing={editing === p.id}
              writing={writing === `remove:${p.id}` || writing === `model:${p.id}`}
              onTest={() => void test(p)}
              onEdit={() => {
                setEditing(p.id)
                void readModels(p)
              }}
              onRemove={() => remove(p)}
              onOpenModels={() => void readModels(p)}
              onChooseModel={(m) => chooseModel(p, m)}
              form={
                editing === p.id ? (
                  <PresetForm
                    initial={draftOf(p)}
                    isNew={false}
                    others={othersOf(p.id)}
                    models={listedModels(p.id)}
                    saving={writing === 'form'}
                    onSave={(next) => save(next, false)}
                    onCancel={() => setEditing(null)}
                  />
                ) : null
              }
            />
          ))}
        </ul>
      )}
    </Group>
  )
}
