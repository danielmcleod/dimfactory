// DIM_FACTORY_HOME/state.json has several writers in the one process that holds the home lock: main's state.get /
// state.set store, the catalog scheduler, first launch and the outside-agent settings. Every change goes through
// updateStateFile: one queue per file, and each change reads the file inside the queue and writes back the whole
// merged document, so no writer's change is lost to another's stale copy. Fields no writer knows are kept. Readers
// (and the `Dim Factory --mcp` bridge, another process that only reads) need no queue: writes are atomic renames.
import { resolve } from 'node:path'
import { isPlainObject, readVersionedJson, writeVersionedJson } from './versions.ts'

export interface StateFileRead {
  /** The file's document ({} when it is missing or corrupt). */
  kind: 'missing' | 'corrupt' | 'ok'
  /** Written by a newer Dim Factory: a change that writes is refused (NEWER_SCHEMA). */
  readOnly: boolean
}

/** What a change does: `next` (absent: write nothing) and what updateStateFile answers. */
export interface StateChange<T> {
  next?: Record<string, unknown>
  value: T
}

const queues = new Map<string, Promise<unknown>>()

const keyOf = (file: string): string => {
  const abs = resolve(file)
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs
}

/**
 * Read state.json, apply `change` to its document and write the result, one change at a time per file. A change
 * that throws writes nothing and does not stop the next one. NEWER_SCHEMA when a newer Dim Factory wrote the file.
 */
export function updateStateFile<T>(
  file: string,
  change: (raw: Record<string, unknown>, read: StateFileRead) => StateChange<T> | Promise<StateChange<T>>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const r = await readVersionedJson<Record<string, unknown>>(file)
    const raw: Record<string, unknown> = r.kind === 'ok' && isPlainObject(r.value) ? { ...r.value } : {}
    const out = await change(raw, { kind: r.kind, readOnly: r.kind === 'ok' && r.readOnly })
    // writeVersionedJson refuses (NEWER_SCHEMA) a state.json a newer Dim Factory wrote.
    if (out.next !== undefined) await writeVersionedJson(file, out.next)
    return out.value
  }
  const key = keyOf(file)
  const prev = queues.get(key) ?? Promise.resolve()
  const p = prev.then(run, run)
  const tail = p.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return p
}
