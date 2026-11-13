// Sleep and wake (powerMonitor drives the timers; IPC `e2e.power`
// / `e2e.clock`, DIM_FACTORY_E2E=1 only). powerMonitor 'suspend'/'resume' and the e2e.power command take one path to
// core.power; a repeated state (Windows can report a wake twice) is dropped. Electron-free: powerMonitor is injected.
import type { Logger } from '@core/log.ts'

export type PowerState = 'suspend' | 'resume'

export interface PowerRouterOptions {
  /** core.power (resolves once every loaded run has reduced it). */
  apply: (state: PowerState) => Promise<void>
  log?: Pick<Logger, 'info' | 'warn'>
}

export type PowerSource = 'os' | 'e2e'

export class PowerRouter {
  readonly #o: PowerRouterOptions
  #state: PowerState = 'resume'
  #queue: Promise<void> = Promise.resolve()

  constructor(o: PowerRouterOptions) {
    this.#o = o
  }

  get state(): PowerState {
    return this.#state
  }

  /**
   * Forward a sleep/wake to the core, in arrival order. Resolves when the core has taken it; false when it repeated
   * the current state and was dropped.
   */
  handle(state: PowerState, source: PowerSource): Promise<boolean> {
    if (state === this.#state) {
      this.#o.log?.info('power event repeated; ignored', { state, source })
      return Promise.resolve(false)
    }
    this.#state = state
    this.#o.log?.info('power', { state, source })
    const run = async (): Promise<boolean> => {
      try {
        await this.#o.apply(state)
      } catch (err) {
        this.#o.log?.warn('power event failed', { state, err })
      }
      return true
    }
    const p = this.#queue.then(run, run)
    this.#queue = p.then(() => undefined)
    return p
  }
}

/** The part of Electron's powerMonitor this uses. */
export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
}

export function installPowerMonitor(pm: PowerMonitorLike, router: PowerRouter): void {
  pm.on('suspend', () => void router.handle('suspend', 'os'))
  pm.on('resume', () => void router.handle('resume', 'os'))
}
