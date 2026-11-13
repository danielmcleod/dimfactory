// Live preflight + estimate for the composer.
// preflight.run and estimates.get for {folder, overrides, brief, recipe}, debounced 300 ms after the folder, the overrides, the recipe, the
// Brief (Test-first needs Verify and adds the Tests step to the estimate), a
// config-changed or a probe event, a change to the catalog's prices, a folder trusted or no longer trusted for
// a vendor in this window (Gemini's readiness `trust` reads trust.json), or a run's status changed (core's
// folder.lock and the estimates' history follow the runs), with a request counter: an answer to anything but the newest request is dropped. Core runs only
// cheap/io checks here and never spawns a vendor. UNSUPPORTED (an older core) is remembered as "unavailable" so the
// composer keeps its older behaviour instead of showing an error. Whether this core answers preflight.run at all is
// learned from its first answer of the session (`coreChecks`): from then on only core's answers count, also before
// it has answered for a new folder.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BriefInput } from '@shared/brief.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { RunEstimate } from '@shared/estimates.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import { invoke } from '../../../ipc/client.ts'
import { overridesForRequest } from './overrides.ts'

export const LIVE_DEBOUNCE_MS = 300
/** "Checking…" replaces the Run label only when a check takes longer than this (no flicker). */
export const CHECKING_LABEL_MS = 300

export type LiveState<T> =
  | { status: 'idle' }
  | { status: 'ok'; folder: string; value: T }
  | { status: 'unavailable' }
  | { status: 'error'; folder: string; message: string }

/** Does this core answer preflight.run? 'unknown' until its first answer this session (any folder, any composer). */
export type LiveSupport = 'unknown' | 'yes' | 'no'
let support: LiveSupport = 'unknown'

/** Tests: what the session has learned about preflight.run (default: nothing yet). */
export function setLiveSupportForTests(s: LiveSupport = 'unknown'): void {
  support = s
}

export interface LiveChecks {
  /**
   * This core answers preflight.run (learned from an answer this session): Queue ("Folder busy") and the other Run
   * states then come from core's answers only; false while that is unknown or for an older core (UNSUPPORTED).
   */
  coreChecks: boolean
  preflight: LiveState<PreflightReport>
  estimate: LiveState<RunEstimate>
  /** A preflight request is in flight (for longer than CHECKING_LABEL_MS when `slow`). */
  checking: boolean
  slow: boolean
  /** Check now (no debounce): "I ran it → Re-check", Check again, after git init. */
  recheck: () => Promise<void>
  /** Drop whatever is in flight (runs.start answered with its own report). */
  invalidate: () => void
}

export interface LiveInput {
  /** The committed absolute folder, or null (no checks). */
  folder: string | null
  overrides: RunOverrides
  /** The composer's Brief (undefined: none; it is then left out of the requests). Same content, same object. */
  brief?: BriefInput | undefined
  /** The chosen recipe's id (undefined: none): core resolves it as the recipe layer. */
  recipe?: string | undefined
  /** Bumped by config-changed events. */
  configEpoch: number
  /** Bumped when the catalog's prices change (state/catalog.ts), so the estimate uses them at once. */
  catalogEpoch?: number
  /** Bumped by every vendorFolder grant or revoke made in this window (state/trust.ts). */
  trustEpoch?: number
  /** Core's probe views (a new object on every probe event). */
  probes: unknown
  /** Bumped by the composer when the folder itself changed (git init). */
  nonce: number
  /** Changes whenever a run starts, changes status or ends (a key over the runs' statuses). */
  runs?: string
}

export function useLiveChecks({
  folder,
  overrides,
  brief,
  recipe,
  configEpoch,
  catalogEpoch,
  trustEpoch,
  probes,
  nonce,
  runs,
}: LiveInput): LiveChecks {
  const [preflight, setPreflight] = useState<LiveState<PreflightReport>>({ status: 'idle' })
  const [estimate, setEstimate] = useState<LiveState<RunEstimate>>({ status: 'idle' })
  const [checking, setChecking] = useState(false)
  const [slow, setSlow] = useState(false)
  const seq = useRef(0)
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  const input = useRef<{
    folder: string | null
    overrides: RunOverrides
    brief: BriefInput | undefined
    recipe: string | undefined
  }>({ folder, overrides, brief, recipe })
  input.current = { folder, overrides, brief, recipe }

  useEffect(() => {
    mounted.current = true
    const timer = slowTimer
    return () => {
      // Answers that arrive after unmount are dropped by `current()` (it checks `mounted`).
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const stopChecking = useCallback(() => {
    if (slowTimer.current !== null) clearTimeout(slowTimer.current)
    slowTimer.current = null
    setChecking(false)
    setSlow(false)
  }, [])

  const run = useCallback(async (): Promise<void> => {
    const { folder: f, overrides: o, brief: b, recipe: rc } = input.current
    if (f === null) return
    const n = ++seq.current
    const sent = overridesForRequest(o)
    const req = {
      folder: f,
      ...(sent !== undefined ? { overrides: sent } : {}),
      ...(b !== undefined ? { brief: b } : {}),
      ...(rc !== undefined ? { recipe: rc } : {}),
    }
    setChecking(true)
    if (slowTimer.current !== null) clearTimeout(slowTimer.current)
    slowTimer.current = setTimeout(() => {
      if (seq.current === n && mounted.current) setSlow(true)
    }, CHECKING_LABEL_MS)
    const current = (): boolean => mounted.current && seq.current === n
    const pre = invoke('preflight.run', req).then((r) => {
      // Any answer but UNSUPPORTED means the command exists, even one for a request that is no longer current.
      support = r.ok || r.error.code !== 'UNSUPPORTED' ? 'yes' : 'no'
      if (!current()) return
      stopChecking()
      if (r.ok) setPreflight({ status: 'ok', folder: f, value: r.value })
      else if (r.error.code === 'UNSUPPORTED') setPreflight({ status: 'unavailable' })
      else setPreflight({ status: 'error', folder: f, message: r.error.message })
    })
    const est = invoke('estimates.get', req).then((r) => {
      if (!current()) return
      if (r.ok) setEstimate({ status: 'ok', folder: f, value: r.value })
      else if (r.error.code === 'UNSUPPORTED') setEstimate({ status: 'unavailable' })
      else setEstimate({ status: 'error', folder: f, message: r.error.message })
    })
    await Promise.all([pre, est])
  }, [stopChecking])

  // Debounced on every change of what core's answer depends on.
  useEffect(() => {
    if (folder === null) {
      seq.current++
      stopChecking()
      return
    }
    const t = setTimeout(() => void run(), LIVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [
    folder,
    overrides,
    brief,
    recipe,
    configEpoch,
    catalogEpoch,
    trustEpoch,
    probes,
    nonce,
    runs,
    run,
    stopChecking,
  ])

  const invalidate = useCallback(() => {
    seq.current++
    stopChecking()
  }, [stopChecking])

  return { coreChecks: support === 'yes', preflight, estimate, checking, slow, recheck: run, invalidate }
}

/** The state's value when it answers for `folder`, else null (another folder's answer never applies). */
export function valueFor<T>(s: LiveState<T>, folder: string | null): T | null {
  return s.status === 'ok' && folder !== null && s.folder === folder ? s.value : null
}
