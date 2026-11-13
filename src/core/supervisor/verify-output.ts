// A verify round's combined output as `runs.output` serves it
// for the file `verify:<n>`. The round writes runs/<id>/verify/<round>/live.log (src/core/verify LiveTail: the last
// 256 KB of everything, rewritten as output arrives), which is what the Run view follows. output.log (each
// command capped at 1 MB head + 4 MB tail) reaches the disk past a command's first 1 MB only when the command ends, so
// it is read only for a round without live.log (one written before the fix).
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunPaths } from '../home.ts'
import type { VerifyRound } from './types.ts'

/** The most of a round's output one `runs.output` answer carries (its end). */
export const VERIFY_OUTPUT_SERVE_BYTES = 256 * 1024

export function isVerifyOutputFile(file: string): file is VerifyRound {
  return file === 'verify:0' || file === 'verify:1' || file === 'verify:2'
}

/** The dependency install's output (the PrepareCard), served as `runs.output` `prepare`. */
export function isPrepareOutputFile(file: string): file is 'prepare' {
  return file === 'prepare'
}

/** runs/<id>/prepare/live.log (src/core/prepare install: the last 256 KB of the install's output, kept current). */
export function prepareLivePath(run: Pick<RunPaths, 'dir'>): string {
  return join(run.dir, 'prepare', 'live.log')
}

/** runs/<id>/prepare/deps.log (each command capped like a verify command's log). */
export function prepareLogPath(run: Pick<RunPaths, 'dir'>): string {
  return join(run.dir, 'prepare', 'deps.log')
}

/** The install's output, its last `max` bytes (live.log, else deps.log). Throws ENOENT before it started. */
export async function readPrepareOutput(
  run: Pick<RunPaths, 'dir'>,
  max: number = VERIFY_OUTPUT_SERVE_BYTES,
): Promise<{ text: string; mtime: number }> {
  return readTail(prepareLivePath(run), prepareLogPath(run), max)
}

/** runs/<id>/verify/<round>/output.log */
export function verifyOutputPath(run: Pick<RunPaths, 'verify'>, round: VerifyRound): string {
  return join(run.verify(round), 'output.log')
}

/** runs/<id>/verify/<round>/live.log */
export function verifyLivePath(run: Pick<RunPaths, 'verify'>, round: VerifyRound): string {
  return join(run.verify(round), 'live.log')
}

/**
 * The round's output, its last `max` bytes (cut at a line start, after a note saying how much came before). Throws
 * ENOENT while the round has not started.
 */
export async function readVerifyOutput(
  run: Pick<RunPaths, 'verify'>,
  round: VerifyRound,
  max: number = VERIFY_OUTPUT_SERVE_BYTES,
): Promise<{ text: string; mtime: number }> {
  return readTail(verifyLivePath(run, round), verifyOutputPath(run, round), max)
}

/** The live view `live` (when it holds the end), else the end of `full`. */
async function readTail(live: string, full: string, max: number): Promise<{ text: string; mtime: number }> {
  const liveStat = await stat(live).catch(() => null)
  if (liveStat !== null && liveStat.size <= max + 1024) {
    // Already the end of the output (with its own note about what came before).
    const text = await readFile(live, 'utf8').catch(() => null)
    if (text !== null) return { text, mtime: liveStat.mtimeMs }
  }
  const path = liveStat !== null ? live : full
  const st = liveStat ?? (await stat(path))
  const size = st.size
  const from = Math.max(0, size - max)
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(size - from)
    let read = 0
    while (read < buf.length) {
      const r = await fh.read(buf, read, buf.length - read, from + read)
      if (r.bytesRead === 0) break
      read += r.bytesRead
    }
    let text = buf.subarray(0, read).toString('utf8')
    if (from > 0) {
      const nl = text.indexOf('\n')
      text = `[Earlier output: ${Math.round(from / 1024)} KB, in the round's logs]\n${nl >= 0 ? text.slice(nl + 1) : text}`
    }
    return { text, mtime: st.mtimeMs }
  } finally {
    await fh.close()
  }
}
