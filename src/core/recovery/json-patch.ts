// For the config_patch executor and resolved.json's `patches[]`: the RFC 6902 subset Dim Factory uses
// (add, replace, remove, test), applied to an in-memory JSON value such as resolved.json's config. Pure: the input is
// never mutated. A file on disk is patched by config/save.ts instead (jsonc.modify keeps its comments).
import type { JsonPatchOp } from '../../shared/failure.ts'
import { parseJsonPointer } from '../config/patch.ts'
import { DimFactoryError } from '../errors.ts'

const UNSAFE: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function refuse(path: string, why: string): DimFactoryError {
  return new DimFactoryError('VALIDATION', `This fix no longer matches the settings (${path}: ${why}).`)
}

/** Deep equality of JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => jsonEqual(x, b[i]))
  }
  if (!isObj(a) || !isObj(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
}

/** The value at a JSON pointer, or undefined (a missing key, an index out of range, a malformed pointer). */
export function valueAt(doc: unknown, pointer: string): unknown {
  const segs = parseJsonPointer(pointer)
  if (segs === null) return undefined
  let cur: unknown = doc
  for (const s of segs) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(s)) return undefined
      cur = cur[Number(s)]
    } else if (isObj(cur)) {
      if (!Object.hasOwn(cur, s)) return undefined
      cur = cur[s]
    } else return undefined
  }
  return cur
}

function applyOne(root: unknown, op: JsonPatchOp): unknown {
  const segs = parseJsonPointer(op.path)
  if (segs === null) throw refuse(op.path, 'not a JSON pointer')
  if (segs.some((s) => UNSAFE.has(s))) throw refuse(op.path, 'unsafe path')
  if (op.op === 'test') {
    if (!jsonEqual(valueAt(root, op.path), op.value)) throw refuse(op.path, 'the value changed')
    return root
  }
  if (segs.length === 0) {
    if (op.op === 'remove') throw refuse(op.path, 'cannot remove the whole document')
    return structuredClone(op.value)
  }
  const parentPath = segs.slice(0, -1)
  const last = segs[segs.length - 1] as string
  let parent: unknown = root
  for (const s of parentPath) {
    if (Array.isArray(parent)) parent = /^(0|[1-9]\d*)$/.test(s) ? parent[Number(s)] : undefined
    else if (isObj(parent)) parent = Object.hasOwn(parent, s) ? parent[s] : undefined
    else parent = undefined
    if (parent === undefined) throw refuse(op.path, 'its parent does not exist')
  }
  if (Array.isArray(parent)) {
    const len = parent.length
    if (op.op === 'add') {
      const i = last === '-' ? len : /^(0|[1-9]\d*)$/.test(last) ? Number(last) : -1
      if (i < 0 || i > len) throw refuse(op.path, 'index out of range')
      parent.splice(i, 0, structuredClone(op.value))
      return root
    }
    const i = /^(0|[1-9]\d*)$/.test(last) ? Number(last) : -1
    if (i < 0 || i >= len) throw refuse(op.path, 'index out of range')
    if (op.op === 'remove') parent.splice(i, 1)
    else parent[i] = structuredClone(op.value)
    return root
  }
  if (!isObj(parent)) throw refuse(op.path, 'its parent is not an object')
  if (op.op === 'add') {
    parent[last] = structuredClone(op.value)
    return root
  }
  if (!Object.hasOwn(parent, last)) throw refuse(op.path, 'it does not exist')
  if (op.op === 'remove') delete parent[last]
  else parent[last] = structuredClone(op.value)
  return root
}

/**
 * Apply `ops` in order to a copy of `doc`. VALIDATION ("This fix no longer matches the settings …") when an op does
 * not apply: a missing parent or target, an index out of range, a failed `test`.
 */
export function applyJsonPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  let out: unknown = structuredClone(doc)
  for (const op of ops) out = applyOne(out, op)
  return out as T
}
