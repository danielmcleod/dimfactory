// Chaos (ENOSPC, EPERM storms): filesystem faults on the real write paths, injected through
// `vi.mock('node:fs/promises')` (the apply-eperm pattern) so no product seam is needed. A rule names a path test
// (`match`), an operation and an errno; the faulty module fails each matching call the way the OS does:
//   - ENOSPC on a write: a short write first (half the bytes, as write(2) returns when the disk fills part way), then
//     the error, so a file written without temp-and-rename is left partial (fs.promises.writeFile / appendFile and
//     FileHandle.writeFile loop over write, so they leave the prefix and throw);
//   - EPERM / EBUSY / EACCES on rename, open or unlink (an antivirus scanner or the indexer holding the file), for the
//     first `times` calls (a storm that passes) or for good.
// Every injected failure is counted per rule. `faults.clear()` ends them all ("space returns").
import type * as FsPromises from 'node:fs/promises'
import { basename } from 'node:path'

export type FaultOp = 'write' | 'rename' | 'open' | 'unlink' | 'mkdir' | 'copyFile'
export type FaultCode = 'ENOSPC' | 'EPERM' | 'EBUSY' | 'EACCES'

export interface FaultRule {
  op: FaultOp
  code: FaultCode
  /** The path (for rename: the target) the rule applies to. */
  match: (path: string) => boolean
  /** Fail only this many matching calls (default: every one while the rule stands). */
  times?: number
  /**
   * A storm that comes and goes: of every `fail + pass` matching calls, the first `fail` fail and the next `pass` go
   * through (an antivirus scan holding each new file for a moment).
   */
  cycle?: { fail: number; pass: number }
  /** How many calls this rule failed. */
  hits: number
  /** How many matching calls this rule saw (failed or let through by its cycle), per path. */
  seen: Map<string, number>
}

const ERRNO: Record<FaultCode, number> = { ENOSPC: -4055, EPERM: -4048, EBUSY: -4082, EACCES: -4092 }
const MESSAGE: Record<FaultCode, string> = {
  ENOSPC: 'no space left on device',
  EPERM: 'operation not permitted',
  EBUSY: 'resource busy or locked',
  EACCES: 'permission denied',
}

export function fsError(
  code: FaultCode,
  syscall: string,
  path: string,
  dest?: string,
): NodeJS.ErrnoException {
  const target = dest !== undefined ? `'${path}' -> '${dest}'` : `'${path}'`
  return Object.assign(new Error(`${code}: ${MESSAGE[code]}, ${syscall} ${target}`), {
    code,
    errno: ERRNO[code],
    syscall,
    path,
    ...(dest !== undefined ? { dest } : {}),
  })
}

class Faults {
  rules: FaultRule[] = []
  /** Every injected failure, `<op> <code> <file name>`. */
  log: string[] = []

  add(rule: Omit<FaultRule, 'hits' | 'seen'>): FaultRule {
    const r: FaultRule = { ...rule, hits: 0, seen: new Map() }
    this.rules.push(r)
    return r
  }

  clear(): void {
    this.rules = []
  }

  reset(): void {
    this.rules = []
    this.log = []
  }

  /** The rule that fails this call now (counted), or undefined. */
  take(op: FaultOp, path: string): FaultRule | undefined {
    const r = this.rules.find(
      (x) => x.op === op && (x.times === undefined || x.hits < x.times) && x.match(path),
    )
    if (r === undefined) return undefined
    const n = r.seen.get(path) ?? 0
    r.seen.set(path, n + 1)
    if (r.cycle !== undefined && n % (r.cycle.fail + r.cycle.pass) >= r.cycle.fail) return undefined
    r.hits++
    this.log.push(`${op} ${r.code} ${basename(path)}`)
    return r
  }
}

export const faults = new Faults()

type Fsp = typeof FsPromises
type Handle = Awaited<ReturnType<Fsp['open']>>

const pathOf = (p: unknown): string => (p instanceof URL ? p.pathname : String(p))

/** A FileHandle whose writes fail per the rules for `file` (the path it was opened with). */
function faultyHandle(handle: Handle, file: string): Handle {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (prop === 'write') {
        return async (buf: unknown, ...rest: unknown[]) => {
          const r = faults.take('write', file)
          if (r === undefined)
            return (target.write as (...a: unknown[]) => Promise<unknown>).call(target, buf, ...rest)
          if (r.code === 'ENOSPC' && Buffer.isBuffer(buf) && r.hits === 1) {
            // The disk filled part way: a short write; the next call fails.
            const offset = typeof rest[0] === 'number' ? rest[0] : 0
            const length = typeof rest[1] === 'number' ? rest[1] : buf.length - offset
            const half = Math.max(1, Math.floor(length / 2))
            return target.write(buf, offset, half, (rest[2] as number | null | undefined) ?? null)
          }
          throw fsError(r.code, 'write', file)
        }
      }
      if (prop === 'writeFile' || prop === 'appendFile') {
        return async (data: string | Uint8Array, ...rest: unknown[]) => {
          const r = faults.take('write', file)
          if (r === undefined)
            return (target[prop] as (...a: unknown[]) => Promise<void>).call(target, data, ...rest)
          if (r.code === 'ENOSPC') {
            const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
            await target.write(bytes, 0, Math.floor(bytes.length / 2), null)
          }
          throw fsError(r.code, 'write', file)
        }
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

/** node:fs/promises with the rules applied (the vi.mock factory's result). */
export function faultyFsPromises(actual: Fsp): Fsp {
  const writeLike =
    (name: 'writeFile' | 'appendFile') =>
    async (file: unknown, data: string | Uint8Array, ...rest: unknown[]): Promise<void> => {
      const p = pathOf(file)
      const r = faults.take('write', p)
      if (r === undefined) return (actual[name] as (...a: unknown[]) => Promise<void>)(file, data, ...rest)
      if (r.code === 'ENOSPC') {
        const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
        await (actual[name] as (...a: unknown[]) => Promise<void>)(file, bytes.subarray(0, bytes.length >> 1))
      }
      throw fsError(r.code, 'write', p)
    }
  return {
    ...actual,
    open: async (file: unknown, ...rest: unknown[]) => {
      const p = pathOf(file)
      const r = faults.take('open', p)
      if (r !== undefined) throw fsError(r.code, 'open', p)
      const h = await (actual.open as (...a: unknown[]) => Promise<Handle>)(file, ...rest)
      return faultyHandle(h, p)
    },
    writeFile: writeLike('writeFile') as Fsp['writeFile'],
    appendFile: writeLike('appendFile') as Fsp['appendFile'],
    rename: async (from: unknown, to: unknown) => {
      const r = faults.take('rename', pathOf(to))
      if (r !== undefined) throw fsError(r.code, 'rename', pathOf(from), pathOf(to))
      return actual.rename(from as string, to as string)
    },
    unlink: async (file: unknown) => {
      const r = faults.take('unlink', pathOf(file))
      if (r !== undefined) throw fsError(r.code, 'unlink', pathOf(file))
      return actual.unlink(file as string)
    },
    mkdir: (async (file: unknown, ...rest: unknown[]) => {
      // Making a folder takes space; asking for one that exists does not.
      const exists = await actual.stat(file as string).then(
        () => true,
        () => false,
      )
      const r = exists ? undefined : faults.take('mkdir', pathOf(file))
      if (r !== undefined) throw fsError(r.code, 'mkdir', pathOf(file))
      return (actual.mkdir as (...a: unknown[]) => Promise<unknown>)(file, ...rest)
    }) as Fsp['mkdir'],
    copyFile: async (from: unknown, to: unknown, ...rest: unknown[]) => {
      const r = faults.take('copyFile', pathOf(to))
      if (r !== undefined) throw fsError(r.code, 'copyfile', pathOf(from), pathOf(to))
      return (actual.copyFile as (...a: unknown[]) => Promise<void>)(from, to, ...rest)
    },
  }
}

/** A path test: under `dir` (case-insensitive on Windows) and, when given, a file name matching `name`. */
export function under(dir: string, name?: RegExp): (path: string) => boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  const d = norm(dir).replace(/\/+$/, '')
  return (p) => {
    const n = norm(p)
    return (n === d || n.startsWith(`${d}/`)) && (name === undefined || name.test(basename(p)))
  }
}
