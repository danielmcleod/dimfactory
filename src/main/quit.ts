// Close and quit policy: what closing the window does per ui.closeToTray and
// platform, and the one quit path every trigger shares (tray Quit, app menu, Ctrl/Cmd+Q, app.quit IPC, OS session
// end): with runs to interrupt and no confirmation it asks the renderer (inline banner) instead of quitting;
// otherwise core.shutdown gets 8 s and the process exits. Electron-free; lifecycle.ts wires the events.
import { QUIT_BUDGET_MS } from './constants.ts'

export type QuitDecision = 'quit' | 'confirm' | 'already-quitting'

export function decideQuit(i: {
  quitting: boolean
  confirmed: boolean
  interruptible: number
}): QuitDecision {
  if (i.quitting) return 'already-quitting'
  if (i.interruptible > 0 && !i.confirmed) return 'confirm'
  return 'quit'
}

export type CloseToTray = boolean | 'auto'
export type CloseAction = 'allow' | 'hide' | 'minimize' | 'quit'

/**
 * Window close. `auto`: hide on Windows/macOS (tray / Dock), minimize on Linux (a tray is not guaranteed). `true`:
 * always hide. `false`: quit through the quit path, except on macOS where an app outlives its window by convention.
 */
export function decideClose(i: {
  quitting: boolean
  closeToTray: CloseToTray
  platform: NodeJS.Platform
}): CloseAction {
  if (i.quitting) return 'allow'
  if (i.closeToTray === 'auto') return i.platform === 'linux' ? 'minimize' : 'hide'
  if (i.closeToTray) return 'hide'
  return i.platform === 'darwin' ? 'hide' : 'quit'
}

export interface QuitResult {
  quitting: boolean
  activeRuns: number
}

export interface QuitControllerDeps {
  /** Runs a quit would interrupt. */
  interruptible: () => string[]
  /** Push `{kind:'app', state:'quit-requested', …}` and show the window. */
  requestConfirmation: (runIds: string[]) => void
  /** Before shutdown starts (dispose the tray, flush pushes). */
  beforeShutdown?: () => void
  shutdown: () => Promise<void>
  exit: (code: number) => void
  log?: {
    warn(msg: string, data?: Record<string, unknown>): void
    info(msg: string, data?: Record<string, unknown>): void
  }
  budgetMs?: number
  /** Lets the IPC reply leave before the shutdown starts (default setImmediate). */
  defer?: (fn: () => void) => void
}

export class QuitController {
  readonly #d: QuitControllerDeps
  #quitting = false
  #done: Promise<void> | undefined

  constructor(d: QuitControllerDeps) {
    this.#d = d
  }

  get quitting(): boolean {
    return this.#quitting
  }

  /** Resolves when the exit has been requested (tests). */
  get done(): Promise<void> | undefined {
    return this.#done
  }

  request(confirmed: boolean): Promise<QuitResult> {
    const runIds = this.#d.interruptible()
    const decision = decideQuit({ quitting: this.#quitting, confirmed, interruptible: runIds.length })
    switch (decision) {
      case 'already-quitting':
        return Promise.resolve({ quitting: true, activeRuns: runIds.length })
      case 'confirm':
        this.#d.requestConfirmation(runIds)
        return Promise.resolve({ quitting: false, activeRuns: runIds.length })
      case 'quit':
        this.#start(runIds.length)
        return Promise.resolve({ quitting: true, activeRuns: runIds.length })
    }
  }

  /**
   * The OS is ending the session: shut down without asking, starting inside the OS's handler (no deferral), so the
   * synchronous part (stop the heartbeat, flush pushes, drop the tray, signal core) runs before the handler returns
   * and Windows may end the process. Runs are persisted write-ahead at every transition, so whatever the OS cuts
   * short is recovered by the next launch.
   */
  endSession(reason: string): void {
    if (this.#quitting) return
    this.#d.log?.info('session ending; shutting down', { reason })
    this.#start(this.#d.interruptible().length, (fn) => fn())
  }

  #start(interrupted: number, now?: (fn: () => void) => void): void {
    this.#quitting = true
    const defer = now ?? this.#d.defer ?? ((fn: () => void) => void setImmediate(fn))
    this.#done = new Promise<void>((resolve) => {
      defer(() => {
        void this.#finish(interrupted).finally(resolve)
      })
    })
  }

  async #finish(interrupted: number): Promise<void> {
    const budget = this.#d.budgetMs ?? QUIT_BUDGET_MS
    try {
      this.#d.beforeShutdown?.()
    } catch (err) {
      this.#d.log?.warn('pre-shutdown step failed', { err })
    }
    this.#d.log?.info('quitting', { interrupted })
    let shutdown: Promise<void>
    try {
      shutdown = this.#d.shutdown()
    } catch (err) {
      shutdown = Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    const r = await withinBudget(shutdown, budget)
    if (r !== 'done')
      this.#d.log?.warn('core shutdown did not finish; exiting anyway', { outcome: r, budgetMs: budget })
    this.#d.exit(0)
  }
}

/** Race a promise against a budget; resolves 'timeout' when the budget runs out first. Never rejects. */
export async function withinBudget(p: Promise<unknown>, ms: number): Promise<'done' | 'timeout' | 'failed'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p.then(
        () => 'done' as const,
        () => 'failed' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
