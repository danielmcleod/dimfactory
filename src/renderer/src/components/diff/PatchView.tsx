// One file's diff, laid out by @pierre/diffs, from core's patch for the file (`diff.file`).
// - Split | Stacked is the library's split / unified layout.
// - Lines wrap (`overflow: 'wrap'`) and nothing in the view scrolls: the page scroller is the only scroll region
//   (UI standard: one scroll region per screen), so the code column's own horizontal scroller is turned off.
// - The app's tokens colour it: the --diff-* tokens (tokens.css) for added and deleted lines, the card surface for its
//   background, the app's monospace font at the stream size. CSS custom properties pass into the view's shadow root;
//   set on the host they win over the theme's own. The app's light or dark theme picks the Shiki theme (themeType).
// - Highlighting runs in the window's worker pool (highlighter.ts), keyed by `cacheKey` so a file laid out again
//   (a layout switch, the tab shown again) is not highlighted twice.
// - The Diff tab loads this module on demand (FileSection's lazy import): @pierre/diffs and Shiki are not in the app's
//   first bundle.
// - A patch the library cannot read is shown as plain text, never as a blank. A type change (a file that became a
//   link, or the reverse) is two of git's sections, its delete and its add: each is laid out, one after the other.
// The file header is the Diff tab's own (FileSection): the library's is off.
import { parsePatchFiles } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'
import { FileDiff, WorkerPoolContext } from '@pierre/diffs/react'
import type { FileDiffOptions } from '@pierre/diffs/react'
import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn.ts'
import { DIFF_THEMES, getDiffPool } from './highlighter.ts'
import { DIFF_UNREADABLE } from './text.ts'
import type { DiffLayout } from './text.ts'

export interface PatchViewProps {
  /** One file's section of a git patch (core's `diff.file`). */
  patch: string
  /** Names the content (run, segment, blob ids, line endings) for the highlighter's cache. */
  cacheKey: string
  layout: DiffLayout
  /** The app's theme now. */
  theme: 'light' | 'dark'
  /** False: highlight on the main thread (tests, where no worker runs). */
  worker?: boolean
  /**
   * The view has drawn its rows (the library's first post-render; until the highlighter pool is ready it draws
   * nothing). The section holds its estimated height until then.
   */
  onDrawn?: () => void
}

/** The app's tokens, mapped onto the library's variables. */
const TOKEN_STYLE = {
  '--diffs-addition-color-override': 'var(--diff-add)',
  '--diffs-deletion-color-override': 'var(--diff-del)',
  '--diffs-bg-addition-override': 'var(--diff-add-bg)',
  '--diffs-bg-deletion-override': 'var(--diff-del-bg)',
  '--diffs-light-bg': 'var(--card)',
  '--diffs-dark-bg': 'var(--card)',
  '--diffs-font-family': 'var(--font-mono)',
  '--diffs-header-font-family': 'var(--font-sans)',
  '--diffs-font-size': 'var(--stream-font-size, 13px)',
  // Wrapped lines never overflow; this keeps the code column from being a sideways scroller at all.
  '--diffs-overflow-override': 'clip',
} as CSSProperties

/** Most sections one file's patch has: a type change's delete and add. */
const MAX_SECTIONS = 2

function parse(patch: string, cacheKey: string): FileDiffMetadata[] | null {
  try {
    const files = parsePatchFiles(patch, cacheKey, false).flatMap((p) => p.files)
    return files.length >= 1 && files.length <= MAX_SECTIONS ? files : null
  } catch {
    return null
  }
}

export function PatchView({
  patch,
  cacheKey,
  layout,
  theme,
  worker = true,
  onDrawn,
}: PatchViewProps): React.JSX.Element {
  const fileDiffs = useMemo(() => parse(patch, cacheKey), [patch, cacheKey])
  // The latest callback, read from the render hook, so the options keep their identity.
  const drawn = useRef(onDrawn)
  useEffect(() => {
    drawn.current = onDrawn
  })
  const plain = fileDiffs === null
  useEffect(() => {
    if (plain) drawn.current?.()
  }, [plain])
  /** Sections drawn so far: the view has drawn once every one has. */
  const mounted = useRef(0)
  const total = fileDiffs?.length ?? 0
  const options = useMemo(
    (): FileDiffOptions<undefined, undefined> => ({
      theme: DIFF_THEMES,
      themeType: theme,
      diffStyle: layout === 'split' ? 'split' : 'unified',
      overflow: 'wrap',
      disableFileHeader: true,
      hunkSeparators: 'line-info',
      lineDiffType: 'word-alt',
      diffIndicators: 'bars',
      onPostRender: (_node, _instance, phase) => {
        if (phase !== 'mount') return
        mounted.current++
        if (mounted.current >= total) drawn.current?.()
      },
    }),
    [layout, theme, total],
  )
  if (fileDiffs === null) {
    return (
      <div data-testid="diff-plain" className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{DIFF_UNREADABLE}</p>
        <pre className="stream-text break-words whitespace-pre-wrap">{patch}</pre>
      </div>
    )
  }
  return (
    <WorkerPoolContext.Provider value={worker ? getDiffPool() : undefined}>
      {fileDiffs.map((fileDiff, i) => (
        <FileDiff
          key={i}
          fileDiff={fileDiff}
          options={options}
          style={TOKEN_STYLE}
          className={cn('block overflow-clip', i === fileDiffs.length - 1 && 'rounded-b-md')}
          disableWorkerPool={!worker}
        />
      ))}
    </WorkerPoolContext.Provider>
  )
}
