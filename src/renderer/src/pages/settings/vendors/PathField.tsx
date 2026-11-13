// A vendor's executable path (Change / Auto-detect / candidates). There
// is no file picker command, so the path is typed (or taken from the candidates the resolver found) and saved with
// vendors.setPath, which re-probes; Auto-detect is vendors.setPath {path:null}. Core validates the path: its message
// shows under the field. A change offers Undo. An npm shim's CLI (Gemini) also says how it is started.
import { Save, ScanSearch } from 'lucide-react'
import { useState } from 'react'
import type { ResultCode } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Input } from '../../../components/ui/Input.tsx'
import { invoke } from '../../../ipc/client.ts'
import { upsertProbes } from '../../../state/actions.ts'
import { toast } from '../../../state/toasts.ts'

const SOURCE_TEXT: Readonly<Record<string, string>> = {
  config: 'your setting',
  known: 'a well-known location',
  path: 'PATH',
  'npm-prefix': 'the npm global folder',
  'desktop-bundle': 'the desktop app',
}

/** How an npm shim's CLI (Gemini) is started: its script with the system Node.js. */
export function nodeEntryText(command: string, argvPrefix: readonly string[]): string {
  return `Runs with your system Node.js: ${[command, ...argvPrefix].join(' ')}`
}

/** vendors.setPath, storing the re-probed view; core's error when it refused the path. */
async function setPath(
  vendor: string,
  path: string | null,
): Promise<{ ok: true } | { ok: false; message: string; code: ResultCode }> {
  const r = await invoke('vendors.setPath', { vendor, path })
  if (!r.ok) return { ok: false, message: r.error.message, code: r.error.code }
  upsertProbes([r.value])
  return { ok: true }
}

export function PathField({
  view,
  configured,
  inputId,
  onSaved,
}: {
  view: ProbeView
  /** The path in the user's settings (undefined/null: auto-detect). */
  configured: string | null | undefined
  inputId: string
  onSaved: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(configured ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'detect' | null>(null)
  const errorId = `${inputId}-error`
  const binary = view.probe?.binary
  const trimmed = value.trim()
  const name = view.displayName

  const apply = async (path: string | null, kind: 'save' | 'detect'): Promise<void> => {
    const previous = configured ?? null
    setBusy(kind)
    setError(null)
    const r = await setPath(view.vendor, path)
    setBusy(null)
    if (!r.ok) {
      if (r.code === 'VALIDATION' || r.code === 'NOT_FOUND') setError(r.message)
      else toast({ level: 'error', message: r.message })
      return
    }
    if (path === null) setValue('')
    onSaved()
    toast({
      level: 'info',
      message: path === null ? `${name} is found automatically again` : `${name} path saved`,
      action: {
        label: 'Undo',
        onClick: async () => {
          const back = await setPath(view.vendor, previous)
          if (!back.ok) toast({ level: 'error', message: back.message })
          else {
            setValue(previous ?? '')
            onSaved()
          }
        },
      },
    })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          data-testid={`vendor-path-${view.vendor}`}
          aria-label={`${name} executable path`}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          placeholder={binary?.path ?? `Path to the ${name} executable`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed !== '' && busy === null) void apply(trimmed, 'save')
          }}
          className="h-8 min-w-[min(10rem,100%)] flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          data-testid={`vendor-path-save-${view.vendor}`}
          icon={<Save aria-hidden />}
          loading={busy === 'save'}
          disabled={busy !== null || trimmed === '' || trimmed === (configured ?? '')}
          onClick={() => void apply(trimmed, 'save')}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`vendor-autodetect-${view.vendor}`}
          icon={<ScanSearch aria-hidden />}
          loading={busy === 'detect'}
          disabled={busy !== null}
          title="Forget the saved path and look for the CLI again"
          onClick={() => void apply(null, 'detect')}
        >
          Auto-detect
        </Button>
      </div>
      {error !== null && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {binary !== undefined
          ? `In use: ${binary.path} (from ${SOURCE_TEXT[binary.source] ?? binary.source})`
          : `No ${name} executable in use.`}
      </p>
      {binary?.kind === 'node-entry' && (
        // An npm-installed CLI (Gemini) runs as its script with the system Node.js, never through its .cmd shim.
        <p
          className="text-xs [overflow-wrap:anywhere] text-muted-foreground"
          data-testid={`vendor-runs-as-${view.vendor}`}
        >
          {nodeEntryText(binary.command, binary.argvPrefix)}
        </p>
      )}
      {view.candidates.length > 0 && (
        <ul aria-label={`${name} executables found`} className="flex flex-col gap-1">
          {view.candidates.map((c) => (
            <li key={c} className="flex items-center gap-2 text-xs">
              <code className="min-w-0 flex-1 truncate font-mono" title={c}>
                {c}
              </code>
              {c === binary?.path && <span className="text-muted-foreground">in use</span>}
              <Button
                size="sm"
                variant="ghost"
                className="h-6"
                aria-label={`Use ${c}`}
                onClick={() => {
                  setValue(c)
                  setError(null)
                }}
              >
                Use
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
