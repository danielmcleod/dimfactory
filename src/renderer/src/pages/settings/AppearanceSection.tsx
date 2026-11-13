// Settings → Appearance: theme
// (System / Light / Dark) and the six accents through ui.setTheme, and the stream font size (12, 13 or 14 px) through
// config.patch (`/ui/streamFontSize`, user-only). Main owns the theme: the reply and the `theme` event carry the
// ThemeState this reflects. Every choice applies at once to the whole window, and the preview at the end shows the
// result (buttons, a link, status badges, stream text and diff lines) in the theme, accent and size chosen. Each accent
// swatch is drawn in the theme now showing, so a dark window previews the dark accents. Nothing is read when the
// section opens: the size shown is the one applied now (lib/streamFont.ts keeps it in step with the config).
import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { Accent, Theme } from '@shared/config-schema.ts'
import type { ThemeState } from '@shared/ipc.ts'
import { Badge } from '../../components/ui/Badge.tsx'
import { buttonVariants } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import {
  applyTheme,
  readInitialTheme,
  setStreamFontSize,
  STREAM_FONT_SIZES,
  useStreamFontSize,
} from '../../lib/theme.ts'
import type { StreamFontSize } from '../../lib/theme.ts'
import { setThemeState } from '../../state/actions.ts'
import { useTheme } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { Group, TILE_CLASS } from './kit.tsx'

// Mirrors THEMES/ACCENTS in config-schema.ts (importing values would bundle zod); a test keeps them equal.
export const THEME_OPTIONS: readonly { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export const ACCENT_OPTIONS: readonly { value: Accent; label: string }[] = [
  { value: 'slate', label: 'Slate' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'amber', label: 'Amber' },
  { value: 'rose', label: 'Rose' },
  { value: 'violet', label: 'Violet' },
]

export const FONT_SIZE_OPTIONS: readonly { value: StreamFontSize; label: string }[] = STREAM_FONT_SIZES.map(
  (px) => ({ value: px, label: `${px} px` }),
)

export const STREAM_FONT_POINTER = '/ui/streamFontSize'

export function AppearanceSection(): React.JSX.Element {
  const stored = useTheme()
  const [fallback] = useState(readInitialTheme)
  const current: ThemeState = stored ?? fallback
  const fontSize = useStreamFontSize()
  const [pending, setPending] = useState(false)
  const [fontPending, setFontPending] = useState(false)

  const set = async (req: { theme?: Theme; accent?: Accent }): Promise<void> => {
    setPending(true)
    const r = await invoke('ui.setTheme', req)
    setPending(false)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    // The `theme` event brings the same state; applying the reply too keeps this window right if it is late.
    applyTheme(r.value)
    setThemeState(r.value)
  }

  // The size applies at once (the preview and every stream follow it); a refused write puts the old size back.
  const setFontSize = async (px: StreamFontSize): Promise<void> => {
    if (px === fontSize) return
    const before = fontSize
    setStreamFontSize(px)
    setFontPending(true)
    const r = await invoke('config.patch', {
      scope: 'user',
      ops: [{ op: 'replace', path: STREAM_FONT_POINTER, value: px }],
    })
    setFontPending(false)
    if (!r.ok) {
      setStreamFontSize(before)
      toast({ level: 'error', message: `The stream font size was not saved: ${r.error.message}` })
    }
  }

  return (
    <div className="flex flex-col gap-6" aria-busy={pending || fontPending || undefined}>
      <fieldset className="flex flex-col gap-2" data-setting-field="/ui/theme">
        <legend className="mb-2 text-sm font-medium">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <label key={value} className={TILE_CLASS} data-testid={`theme-${value}`}>
              <input
                type="radio"
                name="theme"
                value={value}
                className="sr-only"
                checked={current.theme === value}
                onChange={() => void set({ theme: value })}
              />
              <Icon aria-hidden className="size-4" />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {current.theme === 'system'
            ? `Follows your system, which is ${current.resolved} now.`
            : `Always ${current.resolved}.`}
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2" data-setting-field="/ui/accent">
        <legend className="mb-2 text-sm font-medium">Accent</legend>
        <div className="flex flex-wrap gap-2">
          {ACCENT_OPTIONS.map(({ value, label }) => (
            <label key={value} className={TILE_CLASS} data-testid={`accent-${value}`}>
              <input
                type="radio"
                name="accent"
                value={value}
                className="sr-only"
                checked={current.accent === value}
                onChange={() => void set({ accent: value })}
              />
              {/* tokens.css sets the dark accents on `.dark[data-accent]`: the swatch carries both in a dark window. */}
              <span
                aria-hidden
                data-accent={value}
                data-testid={`accent-swatch-${value}`}
                className={cn('size-4 rounded-full bg-primary', current.resolved === 'dark' && 'dark')}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Buttons, links, checked controls and the focus ring take the accent.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2" data-setting-field={STREAM_FONT_POINTER}>
        <legend className="mb-2 text-sm font-medium">Stream font size</legend>
        <div className="flex flex-wrap gap-2">
          {FONT_SIZE_OPTIONS.map(({ value, label }) => (
            <label key={value} className={TILE_CLASS} data-testid={`stream-font-${value}`}>
              <input
                type="radio"
                name="stream-font-size"
                value={value}
                className="sr-only"
                checked={fontSize === value}
                onChange={() => void setFontSize(value)}
              />
              <span aria-hidden className="w-5 font-mono leading-none" style={{ fontSize: `${value}px` }}>
                Aa
              </span>
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">The size of vendor output and the log.</p>
      </fieldset>

      <Group title="Preview" description="How the choices above look together." testId="appearance-preview">
        <Preview />
      </Group>
    </div>
  )
}

/**
 * The preview: drawn with the same tokens as the app, so it follows the theme, accent and stream size at once. It is
 * a picture of controls, not controls: hidden from screen readers and never focusable.
 */
function Preview(): React.JSX.Element {
  return (
    <div aria-hidden className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className={buttonVariants({ variant: 'default', size: 'sm' })}>Approve</span>
        <span className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</span>
        <span className="text-sm text-primary underline underline-offset-4">View changes</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="running">Running</Badge>
        <Badge variant="waiting">Waiting</Badge>
        <Badge variant="done">Done</Badge>
        <Badge variant="failed">Failed</Badge>
        <Badge variant="auto">AUTO</Badge>
      </div>
      <div className="stream-text flex flex-col rounded-md border bg-muted/40 p-2 [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">Reading src/version.ts</span>
        <span className="bg-diff-del-bg px-1 text-diff-del">- export const version = '1.1.0'</span>
        <span className="bg-diff-add-bg px-1 text-diff-add">+ export const version = '1.2.0'</span>
      </div>
    </div>
  )
}
