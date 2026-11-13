// The composer's Tools row, for this run only: [Tools] (a menu of your MCP servers and skills for the vendors this run
// uses, ticked as they stand for this run: your Allowed list, plus what you pick, minus what you untick), [Use skill]
// (a skill the passes that change files are asked to use: it is allowed for them and named in their prompt), and
// suggestion chips when the task names a tool you have set up ("…in Linear" suggests your Linear server). Nothing is
// turned on until you click; read-only passes never get a tool from here; core says what each pass gets (shared
// passExtensionsPlan). Names are found by core's extensions.discover (names only, no tokens).
// UI standards: one row at one height whatever it shows (the chips and the summary share the space beside the two
// controls and are cut, never wrapped), the controls keep fixed labels and widths, and nothing here moves on its own.
import { Plug, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ResolvedConfig, RunOverrides } from '@shared/config-schema.ts'
import type { DiscoveredExtensions } from '@shared/extensions.ts'
import { resolvedRunTools } from '@shared/extensions.ts'
import { Button } from '../../../components/ui/Button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/DropdownMenu.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { invoke } from '../../../ipc/client.ts'
import type { OverridesUpdate } from './state.ts'
import {
  isToolOn,
  pickedCount,
  removedCount,
  setTool,
  setUseSkill,
  skillChoices,
  suggestTools,
  toolItems,
  toolsReachText,
} from './tools.ts'
import type { ToolItem } from './tools.ts'

export const TOOLS_LABEL = 'Tools'
export const USE_SKILL_LABEL = 'Use skill'
const NO_SKILL = '\u0000none'
const VENDOR_LABEL: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
const vendorLabel = (v: string): string => VENDOR_LABEL[v] ?? v
const skillValue = (s: { vendor: string; name: string }): string => `${s.vendor}|${s.name}`

/** core's extensions.discover for the folder (names only), asked once per folder while the row is shown. */
function useDiscovered(folder: string | null): DiscoveredExtensions | null {
  const [found, setFound] = useState<{ folder: string | null; value: DiscoveredExtensions } | null>(null)
  useEffect(() => {
    let live = true
    void invoke('extensions.discover', folder !== null ? { folder } : {}).then((r) => {
      if (live && r.ok) setFound({ folder, value: r.value })
    })
    return () => {
      live = false
    }
  }, [folder])
  return found !== null && found.folder === folder ? found.value : null
}

/** The words beside the controls: what this run picked and took off, or what the row is for. */
export function toolsSummary(o: RunOverrides): string {
  const picked = pickedCount(o)
  const removed = removedCount(o)
  const parts: string[] = []
  if (picked > 0) parts.push(`${picked} on for this run`)
  if (removed > 0) parts.push(`${removed} off for this run`)
  return parts.length > 0
    ? parts.join(' · ')
    : 'Your own tools for this run: nothing is turned on unless you pick it.'
}

export interface ToolsRowProps {
  config: Pick<ResolvedConfig, 'passes' | 'extensions'> | null
  folder: string | null
  task: string
  overrides: RunOverrides
  update: (fn: OverridesUpdate) => void
}

export function ToolsRow({ config, folder, task, overrides, update }: ToolsRowProps): React.JSX.Element {
  const found = useDiscovered(folder)
  const items = config !== null ? toolItems(config, found) : []
  const skills = config !== null ? skillChoices(config, found) : []
  const chips = suggestTools(task, items, overrides)
  const skill = resolvedRunTools(overrides.tools).skill
  const vendors = [...new Set(items.map((i) => i.vendor))]
  const tick = (i: ToolItem, on: boolean): void => update((o) => setTool(o, i, on))

  return (
    <div data-testid="composer-tools-row" className="flex h-7 min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            icon={<Plug aria-hidden />}
            data-testid="composer-tools"
            aria-label="Tools for this run"
            disabled={config === null}
          >
            {TOOLS_LABEL}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-96" data-testid="composer-tools-menu">
          <p className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="composer-tools-reach">
            {config !== null ? toolsReachText(config) : ''}
          </p>
          {items.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="composer-tools-empty">
              {found === null
                ? 'Looking for your tools…'
                : 'No MCP servers or skills found for the vendors this run uses. Add them in the vendor’s own settings.'}
            </p>
          ) : (
            vendors.map((v) => (
              <div key={v}>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{vendorLabel(v)}</DropdownMenuLabel>
                {items
                  .filter((i) => i.vendor === v)
                  .map((i) => (
                    <DropdownMenuCheckboxItem
                      key={`${i.kind}:${i.name}`}
                      data-testid={`composer-tool-${v}-${i.kind}-${i.name}`}
                      checked={isToolOn(overrides, i)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(on) => tick(i, on)}
                    >
                      <span className="min-w-0 flex-1 truncate">{i.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {i.kind === 'mcp' ? 'server' : 'skill'}
                        {i.inSettings ? ' · in settings' : ''}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
              </div>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select
        value={skill !== null ? skillValue(skill) : NO_SKILL}
        disabled={config === null || skills.length === 0}
        onValueChange={(v) => {
          const pick = skills.find((s) => skillValue(s) === v)
          update((o) => setUseSkill(o, pick !== undefined ? { vendor: pick.vendor, name: pick.name } : null))
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="composer-use-skill"
          aria-label={USE_SKILL_LABEL}
          className="w-44 shrink-0"
        >
          <SelectValue placeholder={USE_SKILL_LABEL} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SKILL}>{USE_SKILL_LABEL}: none</SelectItem>
          {skills.map((s) => (
            <SelectItem key={skillValue(s)} value={skillValue(s)}>
              {s.label}
              {vendors.length > 1 || s.vendor !== 'claude' ? ` (${vendorLabel(s.vendor)})` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
        {chips.map((c) => (
          <button
            key={`${c.vendor}:${c.name}`}
            type="button"
            data-testid={`composer-tool-hint-${c.vendor}-${c.name}`}
            title="Lets this run's passes that change files use it, under your account"
            onClick={() => tick(c, true)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-info/50 bg-info/10 px-2 text-xs text-foreground hover:bg-info/20"
          >
            <Plus aria-hidden className="size-3" />
            Use {c.label} for this run
          </button>
        ))}
        <span
          data-testid="composer-tools-summary"
          title={toolsSummary(overrides)}
          className="min-w-0 truncate text-xs text-muted-foreground"
        >
          {toolsSummary(overrides)}
        </span>
      </div>
    </div>
  )
}
