// Settings writes (one click saves, an undo toast follows; all writes go through config.patch / config.save). One config.patch per user action; its toast offers Undo, which restores core's backup
// of the file (config.restoreBackup) or, when the write created the file, puts back what the ops replaced.
import type { ConfigScope } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import { invoke } from '../../../ipc/client.ts'
import { toast } from '../../../state/toasts.ts'

/** Which dimfactory.json a write goes to: the user's, or the project file of `folder`. */
export interface ConfigTarget {
  scope: ConfigScope
  /** Required for the project scope. */
  folder?: string
}

export function targetReq(t: ConfigTarget): { scope: ConfigScope; folder?: string } {
  return t.folder !== undefined ? { scope: t.scope, folder: t.folder } : { scope: t.scope }
}

/** RFC 6901 pointer from segments (`~` → `~0`, `/` → `~1`). */
export function pointer(...segs: readonly string[]): string {
  return segs.map((s) => '/' + s.replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

function unescapeSeg(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~')
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The value at a JSON pointer in a parsed config file, or undefined when absent. */
export function valueAt(doc: unknown, ptr: string): unknown {
  if (ptr === '') return doc
  let cur: unknown = doc
  for (const raw of ptr.split('/').slice(1)) {
    if (!isObj(cur)) return undefined
    const key = unescapeSeg(raw)
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined
    cur = cur[key]
  }
  return cur
}

/** The ops that put back what `ops` change, read from the file's value before the write (applied in reverse). */
export function inverseOps(before: unknown, ops: readonly JsonPatchOp[]): JsonPatchOp[] {
  const out: JsonPatchOp[] = []
  const seen = new Set<string>()
  for (const op of [...ops].reverse()) {
    if (op.op === 'test' || seen.has(op.path)) continue
    seen.add(op.path)
    const prev = valueAt(before, op.path)
    out.push(
      prev === undefined ? { op: 'remove', path: op.path } : { op: 'replace', path: op.path, value: prev },
    )
  }
  return out
}

export interface WriteConfigOptions {
  target: ConfigTarget
  ops: JsonPatchOp[]
  /** The file's parsed value before the write (for the Undo of a write that created the file). */
  before?: unknown
  /** What the toast says was done. */
  message: string
  /** One toast per section: a newer change replaces the older one's toast. */
  toastId: string
  /** After the write and after its Undo (re-read the views). */
  onSettled?: () => void
}

/**
 * Write through config.patch and show the Undo toast. Core's refusal (a value the schema or the semantic rules reject)
 * becomes an error toast with core's message. Resolves to core's answer, or null when nothing was written.
 */
export async function writeConfig(o: WriteConfigOptions): Promise<ConfigWriteResult | null> {
  const r = await invoke('config.patch', { ...targetReq(o.target), ops: o.ops })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    o.onSettled?.()
    return null
  }
  const res = r.value
  o.onSettled?.()
  if (!res.changed) return res
  const undo = async (): Promise<void> => {
    const u =
      res.backupId !== null
        ? await invoke('config.restoreBackup', { ...targetReq(o.target), backupId: res.backupId })
        : await invoke('config.patch', { ...targetReq(o.target), ops: inverseOps(o.before ?? {}, o.ops) })
    if (!u.ok) toast({ level: 'error', message: u.error.message })
    o.onSettled?.()
  }
  toast({ id: o.toastId, level: 'info', message: o.message, action: { label: 'Undo', onClick: undo } })
  return res
}
