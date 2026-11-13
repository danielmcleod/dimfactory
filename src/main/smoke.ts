// `--smoke-test` runner (contract in smoke-args.ts): after the normal boot it waits for the
// renderer's app.ready (≤ 45 s), runs one core round trip (runs.list), shuts the core down and prints the single
// result line. Any failure reported on the way (renderer gone, page failed to load, core boot) ends it with
// SMOKE FAIL. Electron-free: printing and exiting are injected.
import { SMOKE_READY_TIMEOUT_MS } from './constants.ts'
import { smokeFailLine, smokeOkLine } from './smoke-args.ts'
import type { SmokeReport } from './smoke-args.ts'

export interface SmokeDeps {
  /** One core round trip; throws or returns an error message on failure. */
  verify: () => Promise<string | null>
  report: () => SmokeReport
  /** core.shutdown within its budget (never rejects). */
  shutdown: () => Promise<void>
  print: (line: string) => Promise<void>
  exit: (code: number) => void
  readyTimeoutMs?: number
}

export class SmokeRun {
  readonly #d: SmokeDeps
  #finished = false
  #ready: () => void = () => undefined
  readonly #readyP: Promise<void>
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(d: SmokeDeps) {
    this.#d = d
    this.#readyP = new Promise<void>((resolve) => {
      this.#ready = resolve
    })
  }

  get finished(): boolean {
    return this.#finished
  }

  /** The renderer called app.ready. */
  rendererReady(): void {
    this.#ready()
  }

  /** Start waiting for app.ready; resolves when the run has ended (exit requested). */
  async start(): Promise<void> {
    const ms = this.#d.readyTimeoutMs ?? SMOKE_READY_TIMEOUT_MS
    const timedOut = new Promise<'timeout'>((resolve) => {
      this.#timer = setTimeout(() => resolve('timeout'), ms)
    })
    const r = await Promise.race([this.#readyP.then(() => 'ready' as const), timedOut])
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    if (this.#finished) return
    if (r === 'timeout') {
      await this.fail(`the renderer did not call app.ready within ${Math.round(ms / 1000)} s`)
      return
    }
    let problem: string | null
    try {
      problem = await this.#d.verify()
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
    if (problem !== null) {
      await this.fail(`core round trip failed: ${problem}`)
      return
    }
    if (this.#finished) return
    this.#finished = true
    const report = this.#d.report()
    await this.#d.shutdown()
    await this.#d.print(smokeOkLine(report))
    this.#d.exit(0)
  }

  /** End the run with SMOKE FAIL (first failure wins). */
  async fail(reason: string): Promise<void> {
    if (this.#finished) return
    this.#finished = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    await this.#d.shutdown()
    await this.#d.print(smokeFailLine(reason))
    this.#d.exit(1)
  }
}

/** Write one line to a stream and wait until it is flushed (bounded), so the exit never cuts it off. */
export function printLine(line: string, stream: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(finish, 2_000)
    try {
      stream.write(`${line}\n`, () => finish())
    } catch {
      finish()
    }
  })
}
