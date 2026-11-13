// Settings → Preview (Run & Preview): where Open preview shows a preview's page. In Dim Factory (its sandboxed preview
// window), in the system browser, or Ask (both buttons are offered each time). The value is core's resolved
// `preview.openIn` (config.resolve, read again on every config change); a choice writes the user file with
// config.patch (`/preview/openIn`, user-only) and applies at once.
import { AppWindow, ExternalLink, MessageCircleQuestionMark } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PreviewOpenTarget } from '@shared/preview.ts'
import { invoke } from '../../ipc/client.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { TILE_CLASS } from './kit.tsx'

export const PREVIEW_OPEN_POINTER = '/preview/openIn'
/** How long the section is open before it reads its value (a section switch costs no IPC). */
export const PREVIEW_LOAD_DELAY_MS = 150

// Mirrors PREVIEW_OPEN_TARGETS in shared/preview.ts; a test keeps them equal.
export const OPEN_IN_OPTIONS: readonly {
  value: PreviewOpenTarget
  label: string
  description: string
  icon: LucideIcon
}[] = [
  {
    value: 'ask',
    label: 'Ask each time',
    description: 'Both Open preview and Open in browser are offered.',
    icon: MessageCircleQuestionMark,
  },
  {
    value: 'app',
    label: 'In Dim Factory',
    description: 'A separate, sandboxed window that can only show the preview.',
    icon: AppWindow,
  },
  {
    value: 'browser',
    label: 'In your browser',
    description: 'Your default browser opens the page on this computer.',
    icon: ExternalLink,
  },
]

export function PreviewSection(): React.JSX.Element {
  const epoch = useConfigEpoch()
  const [value, setValue] = useState<PreviewOpenTarget | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void invoke('config.resolve', {}).then((r) => {
        if (alive && r.ok) setValue(r.value.config.preview.openIn)
      })
    }, PREVIEW_LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [epoch])

  const choose = async (next: PreviewOpenTarget): Promise<void> => {
    if (next === value) return
    const before = value
    setValue(next)
    setPending(true)
    const r = await invoke('config.patch', {
      scope: 'user',
      ops: [{ op: 'replace', path: PREVIEW_OPEN_POINTER, value: next }],
    })
    setPending(false)
    if (!r.ok) {
      setValue(before)
      toast({ level: 'error', message: `The preview setting was not saved: ${r.error.message}` })
    }
  }

  return (
    <div className="flex flex-col gap-6" aria-busy={pending || undefined}>
      <fieldset className="flex flex-col gap-2" data-setting-field={PREVIEW_OPEN_POINTER}>
        <legend className="mb-2 text-sm font-medium">Open a preview</legend>
        <div className="flex flex-wrap gap-2">
          {OPEN_IN_OPTIONS.map(({ value: v, label, icon: Icon }) => (
            <label key={v} className={TILE_CLASS} data-testid={`preview-open-${v}`}>
              <input
                type="radio"
                name="preview-open-in"
                value={v}
                className="sr-only"
                disabled={value === null}
                checked={value === v}
                onChange={() => void choose(v)}
              />
              <Icon aria-hidden className="size-4" />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="preview-open-description">
          {OPEN_IN_OPTIONS.find((o) => o.value === value)?.description ?? '\u00a0'}
        </p>
      </fieldset>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          A preview runs only a command you trusted, on this computer only. Dim Factory never starts one on
          its own, and stops every preview when it quits.
        </p>
        <p>
          The preview window has no access to your files or to Dim Factory, asks for no permissions and stays
          on the preview&apos;s own address.
        </p>
      </div>
    </div>
  )
}
