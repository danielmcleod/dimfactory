// The compact Run bar (UI standard: once the composer is scrolled past, a compact sticky bar keeps the task and Run
// reachable). The full composer stays in the page at one height; once its Run row has
// scrolled out of view (under where this bar sits), this bar shows over the top of the page: the folder, the task on
// one line, and the same Run control with its status beside it.
//
// It never moves anything: it is an overlay hung from a zero-height sticky wrapper, so showing or hiding it changes no
// layout, and the IntersectionObserver that decides it (useViewPosition, rooted at <main>) cannot see it. Focus never
// moves when it appears. The task is a button: a click brings the composer back into view and puts the cursor in the
// task box (the user's action). If the bar hides while focus is in it, focus goes to the task box (no scroll).
// While it shows, the page scroller's top scroll padding is its height: keyboard focus moving up the page (Shift+Tab)
// and the text cursor land below the bar, never under it.
import { FolderOpen } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  scrollIntoMain,
  useMainScrollPadding,
  useMainScroller,
  useViewPosition,
} from '../../../components/shell/mainScroll.ts'
import { folderBaseName } from '../composer-model.ts'
import { RunControl } from './RunControl.tsx'
import type { RunState } from './RunControl.tsx'

/** The bar's height (px): the composer's Run row counts as out of view once it is under it. */
export const COMPACT_BAR_PX = 48
/** Room kept under the bar when the browser brings a focused control into view (px). */
const FOCUS_GAP_PX = 8

export interface CompactRunBarProps {
  /** The composer's Run row: the bar shows once it has scrolled past (above) the bar. */
  watch: RefObject<HTMLElement | null>
  /** The composer section: a click on the task brings it back to the top of the page. */
  composer: RefObject<HTMLElement | null>
  /** The composer's task box, focused after that click. */
  taskBox: RefObject<HTMLTextAreaElement | null>
  folder: string
  task: string
  run: RunState
}

export function CompactRunBar({
  watch,
  composer,
  taskBox,
  folder,
  task,
  run,
}: CompactRunBarProps): React.JSX.Element {
  const main = useMainScroller()
  const where = useViewPosition(watch, { top: COMPACT_BAR_PX })
  const shown = where === 'above'
  const bar = useRef<HTMLDivElement>(null)
  useMainScrollPadding({ top: shown ? COMPACT_BAR_PX + FOCUS_GAP_PX : 0, bottom: 0 })

  // Hidden with focus inside (the user scrolled back up): the task box takes it, where it is (no scroll). The bar's
  // content is gone by then, so where focus last went is followed as it moves.
  const focusInside = useRef(false)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      focusInside.current = e.target instanceof Node && bar.current?.contains(e.target) === true
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])
  useEffect(() => {
    if (shown || !focusInside.current) return
    focusInside.current = false
    const now = document.activeElement
    if (now === null || now === document.body) taskBox.current?.focus({ preventScroll: true })
  }, [shown, taskBox])

  const toTask = (): void => {
    const section = composer.current
    if (section !== null) scrollIntoMain(main, section)
    taskBox.current?.focus({ preventScroll: true })
  }

  const taskLine = task.trim().split('\n')[0] ?? ''
  const name = folder.trim() !== '' ? folderBaseName(folder.trim()) : 'No folder'
  return (
    <div className="sticky top-0 z-30 h-0" data-testid="compact-bar-anchor">
      <div
        ref={bar}
        role="region"
        aria-label="Run (compact)"
        data-testid="compact-bar"
        // Focus in the bar drops the top scroll padding kept for it (the `page-scroller` utility): Tab through its
        // controls never scrolls the page.
        data-sticky-bar="top"
        hidden={!shown}
        inert={!shown}
        style={{ height: COMPACT_BAR_PX }}
        className="absolute inset-x-0 top-0 border-b bg-background/95 px-6 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85"
      >
        {/* Drawn only while shown: hidden, nothing in it can be found, focused or read. */}
        {shown && (
          <div className="mx-auto flex h-full max-w-6xl items-center gap-3">
            <span
              className="flex max-w-40 shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              title={folder.trim() !== '' ? folder.trim() : undefined}
            >
              <FolderOpen aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate" data-testid="compact-folder">
                {name}
              </span>
            </span>
            <button
              type="button"
              data-testid="compact-task"
              title={task.trim() !== '' ? task.trim() : undefined}
              onClick={toTask}
              className="h-8 min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="sr-only">Edit the task: </span>
              {taskLine !== '' ? taskLine : <span className="text-muted-foreground">Describe the task</span>}
            </button>
            <RunControl
              run={run}
              buttonTestId="compact-run"
              statusId="compact-run-status"
              statusTestId="compact-run-status"
              // As wide as it needs, up to under half the bar; the task gives way first, then the status.
              className="max-w-[45%] flex-initial"
            />
          </div>
        )}
      </div>
    </div>
  )
}
