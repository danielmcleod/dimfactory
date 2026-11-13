// Terminal I/O for the dev CLI, injectable so integration tests can drive `main()` in-process (fake stdin, a fake
// Ctrl+C, captured output).
import { Readable } from 'node:stream'

export interface CliIo {
  /** A line on stdout. */
  out: (line: string) => void
  /** Raw text on stdout (streamed vendor text). */
  write: (text: string) => void
  /** A line on stderr (logs, prompts in --json mode, notices). */
  err: (line: string) => void
  stdin: NodeJS.ReadableStream
  /** stdin and stdout are both terminals: cards and asks are prompted. */
  isTTY: boolean
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  /** Ctrl+C. Returns an unsubscribe. */
  onInterrupt: (fn: () => void) => () => void
}

export function processIo(): CliIo {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`)
    },
    write: (text) => {
      process.stdout.write(text)
    },
    err: (line) => {
      process.stderr.write(`${line}\n`)
    },
    stdin: process.stdin,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
    onInterrupt: (fn) => {
      const handler = (): void => fn()
      process.on('SIGINT', handler)
      return () => {
        process.off('SIGINT', handler)
      }
    },
  }
}

/** `main(argv, out)` (the original signature) or a partial CliIo; everything missing comes from the process. */
export function toIo(x?: Partial<CliIo> | ((line: string) => void)): CliIo {
  const base = processIo()
  if (x === undefined) return base
  if (typeof x === 'function') {
    return {
      ...base,
      out: x,
      write: (t) => x(t.replace(/\n$/, '')),
      err: x,
      stdin: Readable.from([]),
      isTTY: false,
    }
  }
  return { ...base, ...x }
}

/** Reads stdin one line at a time (TTY prompts) or whole (`run <folder> -`, `--plan-file -`). */
export class LineReader {
  readonly #stdin: NodeJS.ReadableStream
  #buf = ''
  #lines: string[] = []
  #ended = false
  #waiters: (() => void)[] = []
  #started = false

  constructor(stdin: NodeJS.ReadableStream) {
    this.#stdin = stdin
  }

  #start(): void {
    if (this.#started) return
    this.#started = true
    this.#stdin.setEncoding?.('utf8')
    this.#stdin.on('data', (chunk: string | Buffer) => {
      this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let nl = this.#buf.indexOf('\n')
      while (nl >= 0) {
        this.#lines.push(this.#buf.slice(0, nl).replace(/\r$/, ''))
        this.#buf = this.#buf.slice(nl + 1)
        nl = this.#buf.indexOf('\n')
      }
      this.#wake()
    })
    const end = (): void => {
      if (this.#buf !== '') this.#lines.push(this.#buf)
      this.#buf = ''
      this.#ended = true
      this.#wake()
    }
    this.#stdin.on('end', end)
    this.#stdin.on('error', end)
    this.#stdin.resume?.()
  }

  #wake(): void {
    for (const w of this.#waiters.splice(0)) w()
  }

  /** The next line, or null at end of input or when `signal` aborts. */
  async line(signal?: AbortSignal): Promise<string | null> {
    this.#start()
    for (;;) {
      if (signal?.aborted === true) return null
      const l = this.#lines.shift()
      if (l !== undefined) return l
      if (this.#ended) return null
      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve()
        signal?.addEventListener('abort', onAbort, { once: true })
        this.#waiters.push(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
  }

  /** Everything until end of input. */
  async all(): Promise<string> {
    const out: string[] = []
    for (;;) {
      const l = await this.line()
      if (l === null) break
      out.push(l)
    }
    return out.join('\n')
  }

  /** Lines until one that is exactly `.` (or end of input). */
  async until(terminator = '.'): Promise<string> {
    const out: string[] = []
    for (;;) {
      const l = await this.line()
      if (l === null || l === terminator) break
      out.push(l)
    }
    return out.join('\n')
  }

  /** Stop reading so the process can exit. */
  pause(): void {
    this.#stdin.pause?.()
  }
}
