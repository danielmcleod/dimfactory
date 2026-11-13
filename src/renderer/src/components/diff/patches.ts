// One file's patch and blobs for the Diff tab (IPC `diff.file`, `diff.blob`), fetched only
// when the file's section asks (near the viewport, expanded). Answers are cached by what names the content (run,
// segment, path, both blob ids, the line-ending choice), so a re-render, a refetched list or a tab switch never asks
// core again for a file that did not change; a request already out is shared.
import { useEffect, useState } from 'react'
import type { DiffBlob, DiffFilePatch, DiffSegment, FileChange } from '@shared/ipc.ts'
import { invoke } from '../../ipc/client.ts'

export type Loaded<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; message: string }

const CACHE_MAX = 300

const cache = new Map<string, Loaded<unknown>>()
const inflight = new Map<string, Promise<Loaded<unknown>>>()

function remember(key: string, v: Loaded<unknown>): void {
  cache.delete(key)
  cache.set(key, v)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function load<T>(key: string, fetch: () => Promise<Loaded<T>>): Promise<Loaded<T>> {
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(hit as Loaded<T>)
  const out = inflight.get(key)
  if (out !== undefined) return out as Promise<Loaded<T>>
  const p = fetch().then((v) => {
    inflight.delete(key)
    // A failure is not kept: the next time the file shows, it is asked again.
    if (v.kind === 'ready') remember(key, v)
    return v
  })
  inflight.set(key, p)
  return p
}

function useLoaded<T>(key: string | null, fetch: () => Promise<Loaded<T>>): Loaded<T> | null {
  const [state, setState] = useState<{ key: string; value: Loaded<T> } | null>(null)
  useEffect(() => {
    if (key === null) return
    let live = true
    void load(key, fetch).then((v) => {
      if (live) setState({ key, value: v })
    })
    return () => {
      live = false
    }
    // The key names everything the fetch reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (key === null) return null
  if (state !== null && state.key === key) return state.value
  const hit = cache.get(key)
  return hit !== undefined ? (hit as Loaded<T>) : { kind: 'loading' }
}

const SEP = '\u0000'

export function patchKey(runId: string, seg: DiffSegment, f: FileChange, ignoreEol: boolean): string {
  return ['patch', runId, seg, f.path, f.oldPath ?? '', f.oldSha, f.newSha, ignoreEol ? 'eol' : 'raw'].join(
    SEP,
  )
}

/** The file's patch from core, or null while `enabled` is false (not near the viewport, collapsed). */
export function usePatch(
  runId: string,
  seg: DiffSegment,
  f: FileChange,
  ignoreEol: boolean,
  enabled: boolean,
): Loaded<DiffFilePatch> | null {
  const key = enabled ? patchKey(runId, seg, f, ignoreEol) : null
  return useLoaded<DiffFilePatch>(key, async () => {
    const r = await invoke('diff.file', {
      runId,
      seg,
      path: f.path,
      ...(ignoreEol ? { ignoreEol: true } : {}),
    })
    return r.ok ? { kind: 'ready', value: r.value } : { kind: 'error', message: r.error.message }
  })
}

export type BlobSide = 'old' | 'new'

/** One side of a binary file from core (an image up to 2 MB comes with its bytes), or null while not enabled. */
export function useBlob(
  runId: string,
  seg: DiffSegment,
  f: FileChange,
  side: BlobSide,
  enabled: boolean,
): Loaded<DiffBlob> | null {
  const path = side === 'old' ? (f.oldPath ?? f.path) : f.path
  const sha = side === 'old' ? f.oldSha : f.newSha
  const key = enabled ? ['blob', runId, seg, side, path, sha].join(SEP) : null
  return useLoaded<DiffBlob>(key, async () => {
    const r = await invoke('diff.blob', { runId, seg, side, path })
    return r.ok ? { kind: 'ready', value: r.value } : { kind: 'error', message: r.error.message }
  })
}

/** Tests: forget every answer. */
export function clearPatchCache(): void {
  cache.clear()
  inflight.clear()
}
