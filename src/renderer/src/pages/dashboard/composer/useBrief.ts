// The composer's Brief: core's brief.detect answer for the committed folder and the task text, the user's draft
// (brief-model.ts), saving it per folder, "Suggest choices", Reset, and the BriefInput the composer sends.
// - brief.detect runs when the folder changes (then the folder's saved brief is restored) and, debounced, when the
//   task text changes (its keyword choices refresh; the user's own choices stay). Only the newest answer counts.
// - Every user change saves the folder's brief (debounced); a pending save is sent before the folder changes.
// - "Suggest choices" calls brief.suggest only on the user's click.
// - A recipe chosen in the composer fills the groups the user has not set (applyRecipe), saved like Suggest's.
// - A preset (New project's template Brief, through the composer intent) is shown for its folder the way a saved brief
//   is restored, when core's detection for that folder arrives (or at once, when it already has).
// - Nothing moves on its own: while the panel is open, a new detection does not switch the category shown (it would
//   replace every group row); the newest detection is taken once the panel is closed again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BriefContext, BriefInput, PackView } from '@shared/brief.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import { invoke } from '../../../ipc/client.ts'
import { vendorName } from '../../../lib/format.ts'
import { toast } from '../../../state/toasts.ts'
import {
  EMPTY_DRAFT,
  applySuggestions,
  briefInputOf,
  briefKey,
  categoryOf,
  chooseCategory,
  decide,
  draftFromSaved,
  packOf,
  savedBriefOf,
  setOther,
  suggestHint,
  suggestedText,
  summaryOf,
  toggleOption,
} from './brief-model.ts'
import type { BriefDraft, BriefSummary } from './brief-model.ts'
import { overridesForRequest } from './overrides.ts'
import { applyRecipeToDraft } from './recipes.ts'
import type { Recipe } from '@shared/recipes.ts'

/** The task text settles this long before its keywords are detected again. */
export const BRIEF_DETECT_DEBOUNCE_MS = 600
/** A change is saved for the folder this long after the last one. */
export const BRIEF_SAVE_DEBOUNCE_MS = 400

export type SuggestState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; text: string }
  | { status: 'error'; text: string }

export interface BriefApi {
  /** `loading` until core answered for the committed folder; `error` when it could not. */
  status: 'loading' | 'ready' | 'error'
  error: string | null
  ctx: BriefContext | null
  draft: BriefDraft
  /** The category shown, and the detected one it follows unless the user chose another. */
  category: string | null
  detected: string | null
  pack: PackView | undefined
  /** What the composer sends (undefined: the brief says nothing). Keeps its identity until its content changes. */
  input: BriefInput | undefined
  summary: BriefSummary
  /** The chips take clicks (core answered for this folder). */
  ready: boolean
  setCategory: (id: string) => void
  toggle: (groupId: string, optionId: string) => void
  decide: (groupId: string) => void
  setOther: (groupId: string, text: string) => void
  suggest: { state: SuggestState; hint: string; disabledReason: string | null; run: () => void }
  reset: { disabledReason: string | null; run: () => void }
  /**
   * A chosen recipe's brief defaults, for the groups the user has not set (composer/recipes.ts). false while core has
   * not answered for this folder yet (the composer applies it once it has).
   */
  applyRecipe: (recipe: Recipe) => boolean
  /** Show `brief` for `folder` as its saved brief would be (New project's template choices). */
  preset: (folder: string, brief: BriefInput) => void
}

export interface UseBriefInput {
  /** The committed absolute folder, or null. */
  folder: string | null
  task: string
  overrides: RunOverrides
  /** The panel is open (detection then keeps the category shown). */
  open: boolean
}

export function useBrief({ folder, task, overrides, open }: UseBriefInput): BriefApi {
  const [ctx, setCtx] = useState<BriefContext | null>(null)
  const [status, setStatus] = useState<BriefApi['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BriefDraft>(EMPTY_DRAFT)
  const [suggestState, setSuggestState] = useState<SuggestState>({ status: 'idle' })
  // The detected category shown while the panel is open (null: follow detection).
  const [frozen, setFrozen] = useState<string | null>(null)

  const seq = useRef(0)
  const mounted = useRef(true)
  /** The folder whose saved brief the draft was restored from ('' for none). */
  const applied = useRef<string | null>(null)
  const latest = useRef({ folder, task, overrides, draft, ctx })
  latest.current = { folder, task, overrides, draft, ctx }
  /** A Brief to show for a folder once core has answered for it (null: the folder's saved brief). */
  const presetRef = useRef<{ folder: string; brief: BriefInput } | null>(null)
  const pendingSave = useRef<{
    folder: string
    timer: ReturnType<typeof setTimeout>
    send: () => void
  } | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // A change still waiting to be saved is sent now.
      const p = pendingSave.current
      if (p !== null) {
        clearTimeout(p.timer)
        p.send()
        pendingSave.current = null
      }
    }
  }, [])

  const flushSave = useCallback(() => {
    const p = pendingSave.current
    if (p === null) return
    clearTimeout(p.timer)
    pendingSave.current = null
    p.send()
  }, [])

  const detect = useCallback((f: string | null, t: string) => {
    const n = ++seq.current
    const req = { ...(f !== null ? { folder: f } : {}), ...(t.trim() !== '' ? { task: t } : {}) }
    void invoke('brief.detect', req).then((r) => {
      if (!mounted.current || n !== seq.current) return
      const key = f ?? ''
      if (!r.ok) {
        // A later detection for the same folder failing keeps what core said before.
        if (applied.current === key) return
        setCtx(null)
        setStatus('error')
        setError(r.error.message)
        return
      }
      setCtx(r.value)
      setStatus('ready')
      setError(null)
      if (applied.current !== key) {
        applied.current = key
        const p = presetRef.current
        const preset = p !== null && p.folder === key ? p.brief : null
        if (preset !== null) presetRef.current = null
        setDraft(draftFromSaved(r.value, preset ?? r.value.saved))
        // A preset is kept for the folder like any change the user makes (core may have saved it already).
        if (preset !== null && JSON.stringify(preset) !== JSON.stringify(r.value.saved)) {
          void invoke('brief.save', { folder: key, brief: preset }).then((s) => {
            if (!s.ok && s.error.code !== 'UNSUPPORTED') toast({ level: 'error', message: s.error.message })
          })
        }
        setFrozen(null)
        setSuggestState({ status: 'idle' })
      }
    })
  }, [])

  // The folder changed: send the old folder's pending save, then ask core about the new one.
  useEffect(() => {
    flushSave()
    applied.current = null
    setStatus('loading')
    setError(null)
    detect(folder, latest.current.task)
  }, [folder, detect, flushSave])

  // The task text changed: its keyword choices again, once the typing settles.
  const lastTask = useRef(task)
  useEffect(() => {
    if (lastTask.current === task) return
    lastTask.current = task
    const t = setTimeout(() => detect(latest.current.folder, task), BRIEF_DETECT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [task, detect])

  // While the panel is open, the category it shows stays put (adjusting state while rendering).
  if (open && frozen === null && ctx !== null) setFrozen(ctx.category.id)
  if (!open && frozen !== null) setFrozen(null)
  const detected = open && frozen !== null ? frozen : (ctx?.category.id ?? null)
  const category = categoryOf(ctx, draft, detected)
  const pack = packOf(ctx, category)

  const rawInput = briefInputOf(ctx, draft, detected)
  const inputKey = briefKey(rawInput)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content: same brief, same object
  const input = useMemo(() => rawInput, [inputKey])
  const summary = summaryOf(ctx, draft, detected)
  const ready = status === 'ready' && ctx !== null

  const scheduleSave = useCallback((next: BriefDraft, cat: string | null) => {
    const f = latest.current.folder
    if (f === null) return
    const p = pendingSave.current
    if (p !== null) clearTimeout(p.timer)
    const send = (): void => {
      void invoke('brief.save', { folder: f, brief: savedBriefOf(next, cat) }).then((r) => {
        if (!r.ok && r.error.code !== 'UNSUPPORTED') toast({ level: 'error', message: r.error.message })
      })
    }
    const timer = setTimeout(() => {
      pendingSave.current = null
      send()
    }, BRIEF_SAVE_DEBOUNCE_MS)
    pendingSave.current = { folder: f, timer, send }
  }, [])

  /** A user change: the new draft is shown at once and saved for the folder. */
  const change = (fn: (d: BriefDraft) => BriefDraft): void => {
    if (!ready) return
    const next = fn(draft)
    if (next === draft) return
    setDraft(next)
    scheduleSave(next, categoryOf(ctx, next, detected))
  }

  const groupOf = (groupId: string) => pack?.pack.groups.find((g) => g.id === groupId)

  const setCategory = (id: string): void =>
    change((d) => (packOf(ctx, id) === undefined ? d : chooseCategory(d, id)))
  const toggle = (groupId: string, optionId: string): void => {
    const g = groupOf(groupId)
    if (pack === undefined || g === undefined) return
    change((d) => toggleOption(ctx, d, pack.pack, g, optionId))
  }
  const decideGroup = (groupId: string): void => {
    const g = groupOf(groupId)
    if (pack === undefined || g === undefined) return
    change((d) => decide(d, pack.pack, g))
  }
  const other = (groupId: string, text: string): void => {
    const g = groupOf(groupId)
    if (pack === undefined || g === undefined) return
    change((d) => setOther(ctx, d, pack.pack, g, text))
  }

  const suggestDisabled =
    ctx === null
      ? status === 'error'
        ? 'The Brief is not available'
        : 'Reading this folder…'
      : ctx.suggest.vendor === null
        ? (ctx.suggest.reason ?? 'No vendor can answer this')
        : folder === null
          ? 'Choose a folder first'
          : task.trim() === ''
            ? 'Describe the task first'
            : null

  const runSuggest = (): void => {
    if (suggestDisabled !== null || folder === null || ctx === null || suggestState.status === 'busy') return
    const f = folder
    const sent = overridesForRequest(overrides)
    const brief: BriefInput = input ?? { category: category ?? ctx.category.id, fields: {} }
    setSuggestState({ status: 'busy' })
    void invoke('brief.suggest', {
      folder: f,
      task: task.trim(),
      brief,
      ...(sent !== undefined ? { overrides: sent } : {}),
    }).then((r) => {
      if (!mounted.current || latest.current.folder !== f) return
      if (!r.ok) {
        setSuggestState({ status: 'error', text: r.error.message })
        return
      }
      const cur = latest.current
      const shown = categoryOf(cur.ctx, cur.draft, detected)
      const out = applySuggestions(cur.ctx, cur.draft, r.value, shown)
      setSuggestState({ status: 'done', text: suggestedText(out.applied) })
      if (out.applied > 0) {
        setDraft(out.draft)
        scheduleSave(out.draft, out.category)
      }
    })
  }

  const applyRecipe = (recipe: Recipe): boolean => {
    if (!ready) return false
    const out = applyRecipeToDraft(ctx, draft, recipe)
    if (out.category !== null && out.draft !== draft) {
      setDraft(out.draft)
      scheduleSave(out.draft, out.category)
    }
    return true
  }

  const resetDisabled = folder === null ? 'Choose a folder first' : !ready ? 'Reading this folder…' : null
  const runReset = (): void => {
    if (resetDisabled !== null || folder === null) return
    const p = pendingSave.current
    if (p !== null) clearTimeout(p.timer)
    pendingSave.current = null
    setDraft(EMPTY_DRAFT)
    setSuggestState({ status: 'idle' })
    void invoke('brief.save', { folder, brief: null }).then((r) => {
      if (!r.ok && r.error.code !== 'UNSUPPORTED') toast({ level: 'error', message: r.error.message })
    })
  }

  const preset = useCallback((f: string, b: BriefInput): void => {
    const cur = latest.current
    if (applied.current === f && cur.folder === f && cur.ctx !== null) {
      setDraft(draftFromSaved(cur.ctx, b))
      setFrozen(null)
      setSuggestState({ status: 'idle' })
      return
    }
    presetRef.current = { folder: f, brief: b }
  }, [])

  return {
    status,
    error,
    ctx,
    draft,
    category,
    detected,
    pack,
    input,
    summary,
    ready,
    setCategory,
    toggle,
    decide: decideGroup,
    setOther: other,
    suggest: {
      state: suggestState,
      hint: suggestHint(ctx, vendorName),
      disabledReason: suggestDisabled,
      run: runSuggest,
    },
    reset: { disabledReason: resetDisabled, run: runReset },
    applyRecipe,
    preset,
  }
}
