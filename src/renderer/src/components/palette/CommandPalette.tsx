// The ⌘/Ctrl+K command palette (cmdk, the app's only modal: Actions, Needs you, Runs, Folders, Settings index; with
// its keys and accessibility). A cmdk menu in a Radix dialog: the search box takes
// the focus, arrows / Home / End move through the results, Enter chooses, Escape (or ⌘/Ctrl+K again, or a press
// outside) closes, and the focus goes back where it was. A choice runs once the dialog has closed and given the focus
// back, so what the choice focuses (the composer's task box, a settings row, an ask) keeps it.
//
// While open, the palette's keys stay in the palette: no app shortcut behind it fires (⌘/Ctrl+Enter would start a
// run, ⌘/Ctrl+1 change the page under it). One scroll region per screen, nothing moves on its own: the dialog has one
// fixed height whatever it finds, sits over the page without moving it, and its results are its own scroll region
// (data-scroll-region="palette", which exists only while the dialog is open). Results are built from the store when
// the palette opens (items.ts); fuzzy search is cmdk's command-score over each result's label, context and keywords.
import { Command, defaultFilter } from 'cmdk'
import { Search, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Platform } from '@shared/ipc.ts'
import type { RunSummary } from '@shared/run.ts'
import { getDimFactory } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { ariaKeyShortcuts, KEYS, matches, parseCombo, useShortcut } from '../../lib/keys.ts'
import { currentHash, useRoute } from '../../lib/router.ts'
import { readInitialTheme } from '../../lib/theme.ts'
import { useRecentFolders } from '../../pages/dashboard/composer/FolderPicker.tsx'
import { useAppInfo, useProbes, useTheme } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { REGION } from '../run/follow.tsx'
import { Kbd } from '../ui/Kbd.tsx'
import { cancelFollowUp } from './followUp.ts'
import { PALETTE_GROUPS, paletteItems } from './items.ts'
import type { PaletteItem } from './items.ts'
import { useExperience } from '../../state/experience.ts'

export const PALETTE_TITLE = 'Command palette'
export const PALETTE_SEARCH_LABEL = 'Search actions, runs, folders and settings'
export const PALETTE_PLACEHOLDER = 'Type an action, a run, a folder or a setting'
export const PALETTE_EMPTY = 'Nothing matches.'
export const PALETTE_KEYS_HINT = '↑ ↓ to move · Enter to choose · Esc to close'

const PALETTE_COMBO = parseCombo(KEYS.palette)

/** Fuzzy match over the label, context and keywords (cmdk's command-score); the item id is not searched. */
function filter(value: string, search: string, keywords?: string[]): number {
  return defaultFilter(keywords !== undefined && keywords.length > 0 ? keywords.join(' ') : value, search)
}

function usePlatform(): Platform {
  const info = useAppInfo()
  return info?.platform ?? getDimFactory()?.platform ?? 'linux'
}

function Row({
  item,
  onChoose,
}: {
  item: PaletteItem
  onChoose: (item: PaletteItem) => void
}): React.JSX.Element {
  const Icon = item.icon
  const side = item.disabled ?? item.hint
  return (
    <Command.Item
      value={item.id}
      keywords={[item.label, ...(item.hint !== undefined ? [item.hint] : []), ...item.keywords]}
      disabled={item.disabled !== undefined}
      onSelect={() => onChoose(item)}
      data-testid={`palette-item-${item.id}`}
      aria-keyshortcuts={item.combo !== undefined ? ariaKeyShortcuts(item.combo) : undefined}
      className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={item.label}>
        {item.label}
      </span>
      {side !== undefined && (
        <span className="max-w-[45%] min-w-0 shrink truncate text-xs text-muted-foreground" title={side}>
          {side}
        </span>
      )}
      {item.combo !== undefined && <Kbd aria-hidden combo={item.combo} className="shrink-0" />}
    </Command.Item>
  )
}

/** The palette's content, mounted only while it is open: what it lists is read from the store then. */
function PaletteBody({
  onChoose,
  onClose,
}: {
  onChoose: (item: PaletteItem) => void
  onClose: () => void
}): React.JSX.Element {
  const route = useRoute()
  const summaries = useStore(
    useShallow((s) =>
      s.summaries.order.map((id) => s.summaries.byId[id]).filter((x): x is RunSummary => x !== undefined),
    ),
  )
  const attention = useStore((s) => s.attention.items)
  const probes = useProbes()
  const stored = useTheme()
  const [fallbackTheme] = useState(readInitialTheme)
  const theme = stored ?? fallbackTheme
  const folders = useRecentFolders(usePlatform())
  const experience = useExperience()
  const groups = useMemo(
    () => paletteItems({ route, summaries, attention, probes, folders, theme, experience }),
    [route, summaries, attention, probes, folders, theme, experience],
  )

  // The page under the palette changed (a link from outside, a notification): what it listed no longer applies.
  const [openedAt] = useState(currentHash)
  useEffect(() => {
    if (currentHash() !== openedAt) onClose()
  }, [route, openedAt, onClose])

  return (
    <Command
      label={PALETTE_SEARCH_LABEL}
      filter={filter}
      vimBindings={false}
      onKeyDown={(e) => {
        if (matches(PALETTE_COMBO, e.nativeEvent)) {
          e.preventDefault()
          if (!e.repeat) onClose()
        }
        // The palette is modal: its keys never reach the app's shortcuts behind it (lib/keys.ts listens on window).
        // Only the native event stops (at the portal's container): the dialog's own handlers still see it (Tab).
        e.nativeEvent.stopPropagation()
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Dialog.Title className="text-xs font-medium text-muted-foreground">{PALETTE_TITLE}</Dialog.Title>
        <Kbd aria-hidden combo={KEYS.palette} />
        <Dialog.Close
          aria-label="Close the command palette"
          data-testid="palette-close"
          className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </Dialog.Close>
      </div>
      {/* The search box keeps the focus while the results are browsed (aria-activedescendant): its row shows it. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring has-[input:focus-visible]:ring-inset">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          data-testid="palette-input"
          placeholder={PALETTE_PLACEHOLDER}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Command.List
        label={PALETTE_SEARCH_LABEL}
        data-testid="palette-list"
        data-scroll-region="palette"
        className={cn(REGION, 'max-h-full min-h-0 flex-1 p-1')}
      >
        <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
          {PALETTE_EMPTY}
        </Command.Empty>
        {PALETTE_GROUPS.map((g) =>
          groups[g.id].length === 0 ? null : (
            <Command.Group
              key={g.id}
              heading={g.heading}
              data-testid={`palette-group-${g.id}`}
              className="[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {groups[g.id].map((item) => (
                <Row key={item.id} item={item} onChoose={onChoose} />
              ))}
            </Command.Group>
          ),
        )}
      </Command.List>
      <Dialog.Description
        title={PALETTE_KEYS_HINT}
        className="h-8 shrink-0 truncate border-t px-3 text-xs leading-8 text-muted-foreground"
      >
        {PALETTE_KEYS_HINT}
      </Dialog.Description>
    </Command>
  )
}

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** Where the focus was when the palette opened: it goes back there on close. */
  const returnTo = useRef<HTMLElement | null>(null)
  /** The chosen item's action, run once the palette has closed. */
  const chosen = useRef<(() => void) | null>(null)

  useShortcut(
    KEYS.palette,
    () => {
      if (open) {
        setOpen(false)
        return
      }
      const active = document.activeElement
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null
      chosen.current = null
      // A deep link still waiting for its target gives way: the user has moved on.
      cancelFollowUp()
      setOpen(true)
    },
    { reserved: true, description: PALETTE_TITLE },
  )

  const close = useCallback(() => setOpen(false), [])
  const choose = useCallback((item: PaletteItem): void => {
    chosen.current = item.run
    setOpen(false)
  }, [])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay data-testid="palette-overlay" className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="palette"
          aria-keyshortcuts={ariaKeyShortcuts(KEYS.palette)}
          onOpenAutoFocus={(e) => {
            // The search box, not the first button in the dialog.
            e.preventDefault()
            document
              .querySelector<HTMLElement>('[data-testid="palette-input"]')
              ?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            const back = returnTo.current
            returnTo.current = null
            if (back !== null && back.isConnected) back.focus({ preventScroll: true })
            const run = chosen.current
            chosen.current = null
            run?.()
          }}
          className="fixed top-[12vh] left-1/2 z-50 flex h-[min(28rem,76vh)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none"
        >
          <PaletteBody onChoose={choose} onClose={close} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
