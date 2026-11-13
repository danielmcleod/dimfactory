// Diff tab test helpers: FileChange builders, an IntersectionObserver the test drives
// (happy-dom's never reports), and a stand-in for the @pierre/diffs view that shows what it was given.
import { useEffect } from 'react'
import type { DiffFiles, FileChange } from '@shared/ipc.ts'
import type { PatchViewProps } from '@renderer/components/diff/PatchView.tsx'

export function change(path: string, over: Partial<FileChange> = {}): FileChange {
  return {
    status: 'M',
    path,
    oldMode: '100644',
    newMode: '100644',
    oldSha: '1111111111111111111111111111111111111111',
    newSha: '2222222222222222222222222222222222222222',
    added: 3,
    deleted: 1,
    binary: false,
    gitlink: false,
    eolOnly: false,
    ...over,
  }
}

export function files(list: FileChange[], over: Partial<DiffFiles> = {}): DiffFiles {
  return {
    seg: 'combined',
    files: list,
    reviewed: [],
    available: ['implement', 'combined'],
    persisted: false,
    ...over,
  }
}

export function patchFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '',
  ].join('\n')
}

/**
 * Whether the stand-in view draws at once (false: as the real one does while its highlighter loads; its draws wait in
 * `held` until the test calls them).
 */
export const fakeView: { draws: boolean; held: (() => void)[] } = { draws: true, held: [] }

/** The @pierre/diffs view, replaced: its props as data attributes, the patch as text. */
export function FakePatchView(p: PatchViewProps): React.JSX.Element {
  const { onDrawn } = p
  useEffect(() => {
    if (fakeView.draws) onDrawn?.()
    else if (onDrawn !== undefined) fakeView.held.push(onDrawn)
  }, [onDrawn])
  return (
    <div data-testid="patch-view" data-layout={p.layout} data-theme={p.theme} data-cache-key={p.cacheKey}>
      {p.patch}
    </div>
  )
}

// ---- an IntersectionObserver the test drives -------------------------------------------------------------------

export class FakeIO {
  static all: FakeIO[] = []
  readonly targets = new Set<Element>()
  readonly callback: IntersectionObserverCallback
  readonly options: IntersectionObserverInit
  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback
    this.options = options
    FakeIO.all.push(this)
  }
  observe(el: Element): void {
    this.targets.add(el)
  }
  unobserve(el: Element): void {
    this.targets.delete(el)
  }
  disconnect(): void {
    this.targets.clear()
    FakeIO.all = FakeIO.all.filter((o) => o !== this)
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/** Every observer watching `el` reports it near the view. */
export function bringNear(el: Element): void {
  for (const io of [...FakeIO.all]) {
    if (!io.targets.has(el)) continue
    const entry = {
      target: el,
      isIntersecting: true,
      intersectionRatio: 1,
      boundingClientRect: { top: 200, bottom: 400 },
      rootBounds: { top: 0 },
    } as unknown as IntersectionObserverEntry
    io.callback([entry], io as unknown as IntersectionObserver)
  }
}

export function installFakeIO(): () => void {
  const before = globalThis.IntersectionObserver
  FakeIO.all = []
  globalThis.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver
  return () => {
    globalThis.IntersectionObserver = before
    FakeIO.all = []
  }
}
