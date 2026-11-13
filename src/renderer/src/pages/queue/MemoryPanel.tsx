// Project memory for a folder: its file (DIM_FACTORY.md at the project root, as core names it), how large it is and
// whether passes get all of it, and the updates proposed after runs with their diff, each with [Approve] (memory.apply:
// core writes it only onto the file it was made from, and only while no run works in the folder) and [Dismiss].
// Nothing is written without the approval here (an Auto run writes only in a project that opted in). With `runId`,
// only that run's update shows (the run's end panel), and nothing at all when it has none.
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MemoryProposalView, MemoryView } from '@shared/factory.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { useMemoryVersion } from '../../state/queue.ts'
import { toast } from '../../state/toasts.ts'
import { APPROVE_LABEL, DISMISS_LABEL } from './text.ts'

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`

export function memoryFileText(m: MemoryView): string {
  if (!m.enabled) return 'Project memory is off for this folder.'
  if (!m.exists)
    return `${m.file} does not exist yet. After a run, an update that starts it is proposed here.`
  return m.capped
    ? `${m.file} (${kb(m.bytes)}). Each pass gets its first ${kb(m.maxBytes)}.`
    : `${m.file} (${kb(m.bytes)}) goes to every pass.`
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-st-completed'
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-st-failed'
  return 'text-muted-foreground'
}

function Proposal({
  folder,
  p,
  onAnswer,
}: {
  folder: string
  p: MemoryProposalView
  onAnswer: (v: MemoryView) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null)
  const act = async (what: 'apply' | 'dismiss'): Promise<void> => {
    setBusy(what)
    const r = await invoke(what === 'apply' ? 'memory.apply' : 'memory.dismiss', { folder, id: p.id })
    setBusy(null)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    onAnswer(r.value)
  }
  return (
    <li data-testid={`memory-proposal-${p.id}`} className="flex flex-col gap-2 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 text-sm">
          Update from run #{p.displayNo} ({p.title}): {p.added} {p.added === 1 ? 'line' : 'lines'} added
          {p.removed > 0 ? `, ${p.removed} removed` : ''}.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            data-testid="memory-approve"
            icon={<Check aria-hidden />}
            loading={busy === 'apply'}
            disabled={busy !== null && busy !== 'apply'}
            onClick={() => void act('apply')}
          >
            {APPROVE_LABEL}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="memory-dismiss"
            icon={<X aria-hidden />}
            loading={busy === 'dismiss'}
            disabled={busy !== null && busy !== 'dismiss'}
            onClick={() => void act('dismiss')}
          >
            {DISMISS_LABEL}
          </Button>
        </div>
      </div>
      <pre
        data-testid="memory-diff"
        className="rounded bg-muted px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap"
      >
        {p.diff
          .replace(/\n$/, '')
          .split('\n')
          .map((l, i) => (
            <span key={i} className={`block ${diffLineClass(l)}`}>
              {l === '' ? ' ' : l}
            </span>
          ))}
      </pre>
    </li>
  )
}

export function MemoryPanel({
  folder,
  runId,
  testId = 'memory-panel',
}: {
  folder: string
  runId?: string
  testId?: string
}): React.JSX.Element | null {
  const version = useMemoryVersion(folder)
  const [view, setView] = useState<MemoryView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void invoke('memory.get', { folder }).then((r) => {
      if (!alive) return
      if (r.ok) {
        setView(r.value)
        setError(null)
      } else setError(r.error.message)
    })
    return () => {
      alive = false
    }
  }, [folder, version])
  const pending = (view?.pending ?? []).filter((p) => runId === undefined || p.runId === runId)
  if (runId !== undefined) {
    if (pending.length === 0) return null
    return (
      <section aria-label="Project memory" data-testid={testId} className="flex flex-col gap-1.5">
        <h4 className="text-sm font-semibold">Project memory</h4>
        <p className="text-xs text-muted-foreground">
          An update to the project memory file is proposed. It is written only when you approve it.
        </p>
        <ul className="flex flex-col gap-2">
          {pending.map((p) => (
            <Proposal key={p.id} folder={folder} p={p} onAnswer={setView} />
          ))}
        </ul>
      </section>
    )
  }
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <p className="min-h-4 text-xs text-muted-foreground" data-testid={`${testId}-file`}>
        {error !== null
          ? `The project memory could not be read: ${error}`
          : view !== null
            ? memoryFileText(view)
            : ''}
      </p>
      {pending.length > 0 && (
        <ul className="flex flex-col gap-2">
          {pending.map((p) => (
            <Proposal key={p.id} folder={folder} p={p} onAnswer={setView} />
          ))}
        </ul>
      )}
    </div>
  )
}
