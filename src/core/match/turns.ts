// A match's sides take turns at the checks Dim Factory runs itself (a Verify round with its page-load check and
// play-test, a security scan's audits): two dev servers or two test suites started at once fight over a port and the
// machine, and a check that fails for that reason would be counted against a side. The model passes are not queued;
// they run side by side. In memory, per process: one queue per match, first come first served.
//
// A round that is stopped while it waits goes ahead at once (its signal is already aborted, so it ends without
// starting anything), and still keeps its place in line for whoever waits behind it.
export class MatchTurns {
  readonly #tails = new Map<string, Promise<void>>()

  /** How many matches have a turn taken or waited for right now. */
  get active(): number {
    return this.#tails.size
  }

  async run<T>(matchId: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const before = this.#tails.get(matchId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const mine = new Promise<void>((r) => {
      release = r
    })
    const tail = before.then(() => mine)
    this.#tails.set(matchId, tail)
    try {
      await waitOrAbort(before, signal)
      return await fn()
    } finally {
      release()
      // The queue is forgotten once its last turn ends.
      void tail.then(() => {
        if (this.#tails.get(matchId) === tail) this.#tails.delete(matchId)
      })
    }
  }
}

/** Resolves when `p` does, or as soon as `signal` aborts. Never rejects (`p` is a chain of turns, which never reject). */
function waitOrAbort(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return p
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    void p.then(done)
  })
}
