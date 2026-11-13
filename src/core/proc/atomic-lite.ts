// Minimal atomic file write for proc-table (temp file + fsync + rename, retried on Windows sharing errors).
// Stand-in for src/core/store/atomic.ts; same retry policy (atomic writes): the temp
// open and the rename are retried on EPERM/EBUSY/EACCES, and a write that fails anywhere takes its temp file with it
// (chaos tests: an antivirus storm on the temp open failed the shadow's writes, and ENOSPC left partial temps behind).
// Errors are thrown as the filesystem raised them (callers read their errno).
import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const ATOMIC_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800]
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

const errCode = (err: unknown): string | undefined =>
  err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined

export async function writeFileAtomicLite(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number; retryDelaysMs?: readonly number[] } = {},
): Promise<void> {
  const delays = opts.retryDelaysMs ?? ATOMIC_RETRY_DELAYS_MS
  const retrying = async <T>(op: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op()
      } catch (err) {
        const code = errCode(err)
        const wait = delays[attempt]
        if (code === undefined || !RETRYABLE.has(code) || wait === undefined) throw err
        await delay(wait)
      }
    }
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const handle = await retrying(() => open(tmp, 'w', opts.mode ?? 0o600))
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await retrying(() => rename(tmp, file))
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
