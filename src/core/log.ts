// JSONL app logger (`logs/{main,cli}.log`: 5 MB rotation, metadata only).
// Every string is redacted (diagnostics mode: tokens, emails, home/user/host) and capped, so prompts, plans and
// vendor output never land in a log. Logging never throws and never blocks the caller.
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname } from 'node:path'
import { isSecretKey, redactText } from '../shared/redact.ts'
import type { RedactOptions } from '../shared/redact.ts'
import { homePaths } from './home.ts'
import type { HomePaths, LogKind } from './home.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_KEEP = 5
/** Strings longer than this are cut: logs carry metadata, not content. */
export const LOG_MAX_STRING = 2000
/** Strings are redacted before the cut; longer ones are first cut to this (redaction work stays bounded). */
const LOG_PRECUT = LOG_MAX_STRING * 32

export type LogData = Record<string, unknown>

export interface LogRecord {
  ts: number
  level: LogLevel
  msg: string
  [key: string]: unknown
}

export interface Logger {
  debug(msg: string, data?: LogData): void
  info(msg: string, data?: LogData): void
  warn(msg: string, data?: LogData): void
  error(msg: string, data?: LogData): void
  /** A logger that adds `bindings` to every record. */
  child(bindings: LogData): Logger
  /** Resolves once every record logged so far is on disk. */
  flush(): Promise<void>
}

const rank = (l: LogLevel): number => LOG_LEVELS.indexOf(l)

let defaultRedact: Omit<RedactOptions, 'mode'> | undefined
function machineRedact(): Omit<RedactOptions, 'mode'> {
  if (defaultRedact !== undefined) return defaultRedact
  const out: Omit<RedactOptions, 'mode'> = {}
  try {
    out.home = homedir()
  } catch {
    // unknown home
  }
  try {
    out.username = userInfo().username
  } catch {
    // no passwd entry
  }
  try {
    out.hostname = hostname()
  } catch {
    // unknown host
  }
  defaultRedact = out
  return out
}

/** Make a value safe for a log line: redacted, capped strings; errors flattened; depth/size bounded. */
export function sanitizeLogValue(
  value: unknown,
  redact: Omit<RedactOptions, 'mode'> = machineRedact(),
): unknown {
  const opts: RedactOptions = { mode: 'diagnostics', ...redact }
  // Redact first, then cut: a secret straddling the cut would otherwise be too short for the length-anchored rules
  // (ghp_…{36,}, sk-…{16,}, AKIA…{16}) and land in the log half-visible. Huge strings are pre-cut far beyond the
  // limit (bounded work); only if redaction shrank that prefix below the limit is the whole string redacted.
  const str = (s: string): string => {
    let r = s.length > LOG_PRECUT ? redactText(s.slice(0, LOG_PRECUT), opts).text : redactText(s, opts).text
    if (s.length > LOG_PRECUT && r.length <= LOG_MAX_STRING) r = redactText(s, opts).text
    return r.length > LOG_MAX_STRING ? `${r.slice(0, LOG_MAX_STRING)}…[+${r.length - LOG_MAX_STRING}]` : r
  }
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return str(v)
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
    if (typeof v === 'bigint') return v.toString()
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined
    if (depth > 6) return '[depth]'
    if (v instanceof Error) {
      const e: Record<string, unknown> = { name: v.name, message: str(v.message) }
      const code = (v as { code?: unknown }).code
      if (typeof code === 'string') e['code'] = code
      if (v.stack !== undefined) e['stack'] = str(v.stack.split('\n').slice(0, 8).join('\n'))
      if (v.cause !== undefined) e['cause'] = walk(v.cause, depth + 1)
      return e
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, 50).map((x) => walk(x, depth + 1))
      if (v.length > 50) items.push(`[+${v.length - 50}]`)
      return items
    }
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      let n = 0
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (n++ >= 50) {
          out['…'] = 'truncated'
          break
        }
        // A secret-named field (apiKey, access_token, password, …) is secret whatever its value
        // looks like, as in a diagnostics bundle (shared/redact.ts isSecretKey).
        const w = typeof child === 'string' && isSecretKey(k) ? '[REDACTED]' : walk(child, depth + 1)
        if (w !== undefined) out[k] = w
      }
      return out
    }
    return '[unserializable]'
  }
  return walk(value, 0)
}

abstract class BaseLogger implements Logger {
  protected readonly level: LogLevel
  protected readonly bindings: LogData

  protected constructor(level: LogLevel, bindings: LogData) {
    this.level = level
    this.bindings = bindings
  }

  protected abstract write(rec: LogRecord): void
  abstract child(bindings: LogData): Logger
  abstract flush(): Promise<void>

  #log(level: LogLevel, msg: string, data?: LogData): void {
    if (rank(level) < rank(this.level)) return
    try {
      this.write(this.record(level, msg, data))
    } catch {
      // logging never throws
    }
  }

  protected record(level: LogLevel, msg: string, data?: LogData): LogRecord {
    return { ts: Date.now(), level, msg, ...this.bindings, ...(data ?? {}) }
  }

  debug(msg: string, data?: LogData): void {
    this.#log('debug', msg, data)
  }
  info(msg: string, data?: LogData): void {
    this.#log('info', msg, data)
  }
  warn(msg: string, data?: LogData): void {
    this.#log('warn', msg, data)
  }
  error(msg: string, data?: LogData): void {
    this.#log('error', msg, data)
  }
}

export interface FileLoggerOptions {
  file: string
  level?: LogLevel
  maxBytes?: number
  /** Rotated files kept: `<file>.1` … `<file>.<keep>`. */
  keep?: number
  /** Redaction context (default: this machine's home, user and host names). */
  redact?: Omit<RedactOptions, 'mode'>
  /** Also echo to stderr (dev). */
  echo?: boolean
}

/** Shared state of one log file (children write through their root). */
class LogSink {
  readonly #o: Required<Omit<FileLoggerOptions, 'level' | 'redact' | 'echo'>> & FileLoggerOptions
  #queue: string[] = []
  #size: number | null = null
  #chain: Promise<void> = Promise.resolve()
  #scheduled = false
  #closed = false

  constructor(opts: FileLoggerOptions) {
    this.#o = { maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP, ...opts }
  }

  enqueue(rec: LogRecord): void {
    if (this.#closed) return
    const line = JSON.stringify(sanitizeLogValue(rec, this.#o.redact))
    if (this.#o.echo === true) process.stderr.write(`${line}\n`)
    this.#queue.push(line)
    if (!this.#scheduled) {
      this.#scheduled = true
      queueMicrotask(() => {
        this.#scheduled = false
        this.#chain = this.#chain.then(() => this.#drain())
      })
    }
  }

  flush(): Promise<void> {
    // Let a scheduled microtask enqueue its drain first.
    return Promise.resolve().then(() => {
      this.#chain = this.#chain.then(() => this.#drain())
      return this.#chain
    })
  }

  async close(): Promise<void> {
    await this.flush()
    this.#closed = true
  }

  async #drain(): Promise<void> {
    if (this.#queue.length === 0) return
    const lines = this.#queue.splice(0)
    const data = `${lines.join('\n')}\n`
    const bytes = Buffer.byteLength(data)
    try {
      if (this.#size === null) {
        await mkdir(dirname(this.#o.file), { recursive: true, mode: 0o700 })
        this.#size = await stat(this.#o.file).then(
          (s) => s.size,
          () => 0,
        )
      }
      if (this.#size > 0 && this.#size + bytes > this.#o.maxBytes) await this.#rotate()
      await appendFile(this.#o.file, data, { mode: 0o600 })
      this.#size += bytes
    } catch {
      // A log that cannot be written is dropped silently; it must never take the app down.
      this.#size = null
    }
  }

  async #rotate(): Promise<void> {
    const f = this.#o.file
    await rm(`${f}.${this.#o.keep}`, { force: true }).catch(() => undefined)
    for (let i = this.#o.keep - 1; i >= 1; i--) {
      await rename(`${f}.${i}`, `${f}.${i + 1}`).catch(() => undefined)
    }
    try {
      await rename(f, `${f}.1`)
      this.#size = 0
    } catch {
      // Windows: another process holds the file; keep appending and try again next time.
    }
  }
}

class FileLogger extends BaseLogger {
  readonly #sink: LogSink

  constructor(sink: LogSink, level: LogLevel, bindings: LogData) {
    super(level, bindings)
    this.#sink = sink
  }

  protected write(rec: LogRecord): void {
    this.#sink.enqueue(rec)
  }

  child(bindings: LogData): Logger {
    return new FileLogger(this.#sink, this.level, { ...this.bindings, ...bindings })
  }

  flush(): Promise<void> {
    return this.#sink.flush()
  }

  close(): Promise<void> {
    return this.#sink.close()
  }
}

export type ClosableLogger = Logger & { close(): Promise<void> }

/** A rotating JSONL file logger (`logs/main.log` for the app, `logs/cli.log` for the CLI). */
export function createFileLogger(opts: FileLoggerOptions): ClosableLogger {
  return new FileLogger(new LogSink(opts), opts.level ?? 'info', {})
}

/** `<home>/logs/<kind>.log` with the default 5 MB × 5 rotation. */
export function createHomeLogger(
  home: string | HomePaths,
  kind: LogKind,
  opts: Omit<FileLoggerOptions, 'file'> = {},
): ClosableLogger {
  const paths = typeof home === 'string' ? homePaths(home) : home
  return createFileLogger({ ...opts, file: paths.log(kind) })
}

class MemoryLogger extends BaseLogger {
  readonly records: LogRecord[]

  constructor(records: LogRecord[], level: LogLevel, bindings: LogData) {
    super(level, bindings)
    this.records = records
  }
  protected write(rec: LogRecord): void {
    this.records.push(sanitizeLogValue(rec) as LogRecord)
  }
  child(bindings: LogData): Logger {
    return new MemoryLogger(this.records, this.level, { ...this.bindings, ...bindings })
  }
  flush(): Promise<void> {
    return Promise.resolve()
  }
}

/** In-memory logger for tests; `records` holds sanitized records. */
export function createMemoryLogger(level: LogLevel = 'debug'): Logger & { records: LogRecord[] } {
  return new MemoryLogger([], level, {})
}

class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this
  }
  flush(): Promise<void> {
    return Promise.resolve()
  }
}

export const silentLogger: Logger = new SilentLogger()
