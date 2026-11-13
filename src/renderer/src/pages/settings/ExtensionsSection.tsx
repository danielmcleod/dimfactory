// Settings > Extensions: which of the user's own MCP servers, skills, plugins and hooks each pass may use.
// - Project: with a project chosen, changes go to its dimfactory.json; without one, to the user's settings. A read-only
//   pass's Pass through always goes to the user's settings (a project file may not carry it), after its warning.
// - Passes: each pass's level (None, Allowed list, Pass through) with where it comes from and what it means for the
//   pass's vendor (shared extensionsCopy).
// - One group per vendor Dim Factory reads (Claude, Codex, Gemini): the MCP servers and skills its own settings define
//   (core's extensions.discover, names only), each with a tick for the Allowed list and the passes that may use it; the
//   plugins (or Gemini's extensions) for information. A name Dim Factory cannot pass on is shown, not tickable.
// Nothing is read until the section has been open a moment (sectionData.ts). The vendor groups, whose length is unknown
// until core answers, come last and keep their place from the start, so nothing above them moves when they arrive.
import { useEffect, useState } from 'react'
import type { JsonPatchOp } from '@shared/failure.ts'
import { PlugZap } from 'lucide-react'
import type {
  ConnectorsListResult,
  DiscoveredExtensions,
  DiscoveredItem,
  DiscoveredVendor,
  ExtensionLevel,
} from '@shared/extensions.ts'
import {
  CLAUDE_CONNECTORS_BUTTON,
  CLAUDE_CONNECTORS_NOTE,
  EXTENSION_LEVEL_LABEL,
  MCP_WITHOUT_ASKING_LABEL,
  MCP_WITHOUT_ASKING_NOTE,
  MCP_WITHOUT_ASKING_VENDORS,
  SKILLS_LIMIT_NOTE,
  connectorStatusText,
  isReadOnlyExtensionsPass,
} from '@shared/extensions.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import type { PassName } from '@shared/run.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { invoke } from '../../ipc/client.ts'
import { stepLabel, vendorName } from '../../lib/format.ts'
import { useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { ExtensionsCopy, ExtensionsSelect } from '../dashboard/composer/ExtensionsSelect.tsx'
import { pointer, writeConfig } from './general/configWrite.ts'
import type { ConfigTarget } from './general/configWrite.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { SourceBadge } from './general/SourceBadge.tsx'
import { allowedOf, passLevels, usedBy, usedByText, withTicked } from './extensions/model.ts'
import { ContextGroup } from './extensions/ContextGroup.tsx'
import type { PassLevel, ResolvedSlice } from './extensions/model.ts'
import { Group } from './kit.tsx'
import { useSectionData } from './sectionData.ts'

const UNDO_TOAST = 'extensions-undo'

export const READING_EXTENSIONS = 'Reading the vendors’ settings…'
export const NOT_ALLOWABLE =
  'Dim Factory can only allow names made of letters, digits, - and _ (and : for a plugin skill).'
const SCOPE_LABEL: Readonly<Record<DiscoveredItem['scope'], string>> = {
  user: 'Yours',
  project: 'Project',
  local: 'Local',
  plugin: 'Plugin',
  extension: 'Extension',
  account: 'Account',
}

/** What a vendor's plugins (Gemini's extensions) get below Pass through, before their names. */
export function pluginsNote(vendor: string): string {
  if (vendor === 'gemini')
    return 'Extensions (their context and commands load at every level; their MCP servers follow the list above)'
  if (vendor === 'claude')
    return 'Plugins (below Pass through only the plugin skills you allow load; their servers, hooks and subagents do not)'
  return 'Plugins (they load at Pass through only)'
}

export const AGENTS_NOTE =
  'Custom subagents (while any exist, read-only passes below Pass through run without the subagent tool)'

/** The list kinds of an allow list Settings writes. */
type ListKind = 'mcp' | 'skills' | 'mcpWithoutAsking'

/** What the last connector listing said, in plain words (empty before one). */
export function connectorsResultText(r: ConnectorsListResult | null): string {
  if (r === null) return ''
  if (r.ok)
    return r.count === 0
      ? 'No connectors on this account.'
      : `Listed ${r.count} connector${r.count === 1 ? '' : 's'}.`
  return r.blocked ?? `They could not be listed: ${r.error ?? 'unknown error'}`
}

function linkKey(route: Route): string {
  if (route.name !== 'settings') return ''
  return `${route.subpath.join('/')}?${new URLSearchParams(route.query).toString()}`
}

export function ExtensionsSection(): React.JSX.Element {
  const route = useRoute()
  const folder = route.name === 'settings' ? (route.query['folder'] ?? null) : null
  return <ExtensionsBody key={linkKey(route)} initialFolder={folder !== '' ? folder : null} />
}

function ItemRow({
  item,
  vendor,
  kind,
  ticked,
  canTick,
  levels,
  busy,
  onTick,
  noAsk,
}: {
  item: DiscoveredItem
  vendor: string
  kind: 'mcp' | 'skills'
  ticked: boolean
  canTick: boolean
  levels: readonly PassLevel[]
  busy: boolean
  onTick: (on: boolean) => void
  /** Claude MCP servers: the "Run without asking" opt-in (on every row, usable once the server is allowed). */
  noAsk?: { on: boolean; busy: boolean; onChange: (on: boolean) => void } | undefined
}): React.JSX.Element {
  const used = usedByText(usedBy(levels, vendor, ticked))
  const tickable = canTick && item.allowable
  const id = `extensions-${vendor}-${kind}-${item.name}`
  const status = connectorStatusText(item.status)
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 last:border-b-0"
      data-testid={id}
    >
      <label
        className="flex min-w-0 flex-1 items-center gap-2 text-sm"
        title={tickable ? undefined : NOT_ALLOWABLE}
      >
        <Checkbox
          data-testid={`${id}-allow`}
          aria-label={`Allow ${item.name} for ${vendorName(vendor)}`}
          checked={ticked}
          disabled={!tickable || busy}
          onCheckedChange={(v) => onTick(v === true)}
        />
        <span className="truncate font-mono text-xs" title={item.label !== undefined ? item.name : undefined}>
          {item.label ?? item.name}
        </span>
        <span className="shrink-0 rounded-md border px-1 text-[10px] leading-4 text-muted-foreground">
          {SCOPE_LABEL[item.scope]}
        </span>
        {status !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground" data-testid={`${id}-status`}>
            {status}
          </span>
        )}
      </label>
      {noAsk !== undefined && (
        <label
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          title={MCP_WITHOUT_ASKING_NOTE}
        >
          <Checkbox
            data-testid={`${id}-no-ask`}
            aria-label={`${MCP_WITHOUT_ASKING_LABEL}: ${item.label ?? item.name}`}
            checked={ticked && noAsk.on}
            disabled={!ticked || !tickable || noAsk.busy}
            onCheckedChange={(v) => noAsk.onChange(v === true)}
          />
          {MCP_WITHOUT_ASKING_LABEL}
        </label>
      )}
      <span className="shrink-0 text-xs text-muted-foreground" data-testid={`${id}-used`}>
        {used}
      </span>
    </li>
  )
}

function VendorGroup({
  found,
  config,
  levels,
  busy,
  onTick,
  connectors,
}: {
  found: DiscoveredVendor
  config: ResolvedSlice | null
  levels: readonly PassLevel[]
  busy: string | null
  onTick: (vendor: string, kind: ListKind, name: string, on: boolean) => void
  /** Claude: list the claude.ai connectors (absent for the other vendors). */
  connectors?: { busy: boolean; result: ConnectorsListResult | null; onList: () => void } | undefined
}): React.JSX.Element {
  const v = found.vendor
  const withoutAsking = MCP_WITHOUT_ASKING_VENDORS.includes(v)
  const allowed = allowedOf(config, v)
  // A name on the list that the settings no longer define still shows, so it can be unticked.
  const gone = (kind: 'mcp' | 'skills', items: readonly DiscoveredItem[]): DiscoveredItem[] =>
    allowed[kind]
      .filter((n) => !items.some((i) => i.name === n))
      .map((name) => ({ name, scope: 'user' as const, allowable: true }))
  const mcp = [...found.mcp, ...gone('mcp', found.mcp)]
  const skills = found.support.skills ? [...found.skills, ...gone('skills', found.skills)] : []
  const name = vendorName(v)
  const list = (
    kind: 'mcp' | 'skills',
    items: readonly DiscoveredItem[],
    empty: string,
  ): React.JSX.Element =>
    items.length === 0 ? (
      <p className="text-xs text-muted-foreground" data-testid={`extensions-${v}-${kind}-empty`}>
        {empty}
      </p>
    ) : (
      <ul aria-label={`${name} ${kind === 'mcp' ? 'MCP servers' : 'skills'}`} className="flex flex-col">
        {items.map((item) => (
          <ItemRow
            key={`${item.scope}:${item.name}`}
            item={item}
            vendor={v}
            kind={kind}
            ticked={allowed[kind].includes(item.name)}
            canTick={kind === 'mcp' ? found.support.mcp : found.support.skills}
            levels={levels}
            busy={busy === `${v}/${kind}`}
            onTick={(on) => onTick(v, kind, item.name, on)}
            noAsk={
              kind === 'mcp' && withoutAsking
                ? {
                    on: allowed.mcpWithoutAsking.includes(item.name),
                    busy: busy === `${v}/mcpWithoutAsking`,
                    onChange: (on) => onTick(v, 'mcpWithoutAsking', item.name, on),
                  }
                : undefined
            }
          />
        ))}
      </ul>
    )
  return (
    <Group title={name} testId={`extensions-vendor-${v}`}>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">MCP servers</h4>
        {list('mcp', mcp, `No MCP servers in ${name}’s settings.`)}
        {withoutAsking && (
          <p className="text-xs text-muted-foreground" data-testid={`extensions-${v}-no-ask-note`}>
            {MCP_WITHOUT_ASKING_NOTE}
          </p>
        )}
      </div>
      {found.support.skills && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Skills</h4>
          {list('skills', skills, `No skills in ${name}’s settings.`)}
        </div>
      )}
      {found.plugins.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid={`extensions-${v}-plugins`}>
          {pluginsNote(v)}: {found.plugins.join(', ')}
        </p>
      )}
      {(found.agents ?? []).length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid={`extensions-${v}-agents`}>
          {AGENTS_NOTE}: {(found.agents ?? []).join(', ')}
        </p>
      )}
      {v === 'claude' && connectors !== undefined && (
        <div className="flex flex-col gap-1.5" data-testid="extensions-claude-connectors">
          <p className="text-xs text-muted-foreground">{CLAUDE_CONNECTORS_NOTE}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              icon={<PlugZap aria-hidden />}
              loading={connectors.busy}
              data-testid="extensions-claude-connectors-list"
              onClick={connectors.onList}
            >
              {CLAUDE_CONNECTORS_BUTTON}
            </Button>
            {/* Its line is kept from the start, so the answer never moves what is below. */}
            <span
              role="status"
              className="min-h-4 text-xs text-muted-foreground"
              data-testid="extensions-claude-connectors-result"
            >
              {connectors.busy ? 'Listing…' : connectorsResultText(connectors.result)}
            </span>
          </div>
        </div>
      )}
      {!found.complete && (
        <p className="text-xs text-warning" data-testid={`extensions-${v}-incomplete`}>
          Dim Factory could not read all of {name}&rsquo;s settings, so this list may miss something.
        </p>
      )}
    </Group>
  )
}

function ExtensionsBody({ initialFolder }: { initialFolder: string | null }): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(initialFolder)
  const epoch = useConfigEpoch()
  const resolved = useSectionData<ResolvedWithProvenance>(
    `resolve\u0000${folder ?? ''}`,
    () => invoke('config.resolve', folder !== null ? { folder } : {}),
    epoch,
  )
  const discovered = useSectionData<DiscoveredExtensions>(
    `discover\u0000${folder ?? ''}`,
    () => invoke('extensions.discover', folder !== null ? { folder } : {}),
    epoch,
  )
  const target: ConfigTarget = folder !== null ? { scope: 'project', folder } : { scope: 'user' }
  const [busy, setBusy] = useState<string | null>(null)
  // A value just written shows at once and until core's next answer replaces it.
  const [pending, setPending] = useState<Readonly<Record<string, unknown>>>({})
  useEffect(() => setPending({}), [resolved.value])

  const config = resolved.value?.config as ResolvedSlice | undefined
  const provenance = resolved.value?.provenance
  const loading = resolved.value === null
  const levels = passLevels(config ?? null).map((l) => {
    const p = pending[`/passes/${l.pass}/extensions`]
    return p !== undefined ? { ...l, level: p as ExtensionLevel } : l
  })
  const where = folder !== null ? folderBaseName(folder) : null

  const reload = (): void => {
    resolved.reload()
    discovered.reload()
  }

  const write = async (
    key: string,
    to: ConfigTarget,
    ops: JsonPatchOp[],
    message: string,
    shown: unknown,
  ): Promise<void> => {
    setPending((p) => ({ ...p, [key]: shown }))
    setBusy(key)
    const res = await writeConfig({ target: to, ops, message, toastId: UNDO_TOAST, onSettled: reload })
    setBusy(null)
    if (res === null) {
      setPending((p) => {
        const { [key]: _gone, ...rest } = p
        return rest
      })
    }
  }

  const setLevel = (pass: PassName, level: ExtensionLevel): void => {
    const path = pointer('passes', pass, 'extensions')
    // A project file may not carry a read-only pass's Pass through: it goes to the user's settings.
    const userOnly = level === 'passthrough' && isReadOnlyExtensionsPass(pass)
    const to: ConfigTarget = userOnly ? { scope: 'user' } : target
    void write(
      path,
      to,
      [{ op: 'add', path, value: level }],
      `${stepLabel(pass)} extensions: ${EXTENSION_LEVEL_LABEL[level]}${userOnly && folder !== null ? ' (saved to your settings)' : ''}`,
      level,
    )
  }

  const [listing, setListing] = useState(false)
  const [listed, setListed] = useState<ConnectorsListResult | null>(null)
  const listConnectors = (): void => {
    setListing(true)
    void invoke('extensions.claudeConnectors', { force: true })
      .then((r) => setListed(r.ok ? r.value : { ok: false, count: 0, error: r.error.message }))
      .finally(() => {
        setListing(false)
        discovered.reload()
      })
  }

  const tick = (vendor: string, kind: ListKind, name: string, on: boolean): void => {
    const current =
      (pending[`${vendor}/${kind}`] as string[] | undefined) ?? allowedOf(config ?? null, vendor)[kind]
    const next = withTicked(current, name, on)
    const path = pointer('extensions', 'allowed', vendor, kind)
    setPending((p) => ({ ...p, [`${vendor}/${kind}`]: next }))
    setBusy(`${vendor}/${kind}`)
    void writeConfig({
      target,
      ops: [{ op: 'add', path, value: next }],
      message:
        kind === 'mcpWithoutAsking'
          ? on
            ? `${name} runs without asking`
            : `${name} asks before each tool again`
          : on
            ? `Allowed ${name} for ${vendorName(vendor)}`
            : `${name} is no longer allowed`,
      toastId: UNDO_TOAST,
      onSettled: reload,
    }).then((res) => {
      setBusy(null)
      if (res === null) {
        setPending((p) => {
          const { [`${vendor}/${kind}`]: _gone, ...rest } = p
          return rest
        })
      }
    })
  }

  // The config as shown: the allow lists just written included.
  const shownConfig: ResolvedSlice | null =
    config === undefined
      ? null
      : {
          ...config,
          extensions: {
            allowed: Object.fromEntries(
              ['claude', 'codex', 'gemini'].map((v) => [
                v,
                {
                  mcp: (pending[`${v}/mcp`] as string[] | undefined) ?? allowedOf(config, v).mcp,
                  skills: (pending[`${v}/skills`] as string[] | undefined) ?? allowedOf(config, v).skills,
                  mcpWithoutAsking:
                    (pending[`${v}/mcpWithoutAsking`] as string[] | undefined) ??
                    allowedOf(config, v).mcpWithoutAsking,
                },
              ]),
            ),
          },
        }

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="settings-extensions"
      aria-busy={(loading && resolved.error === null) || undefined}
    >
      <p className="text-sm text-muted-foreground">
        Which of your own MCP servers, skills, plugins and hooks each pass may use. Dim Factory reads their
        names from each vendor&rsquo;s settings and keeps them out of its logs; a pass&rsquo;s tool rows show
        the tools it used.
      </p>
      {resolved.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The settings could not be read: {resolved.error}
        </p>
      )}
      <Group
        title="Project"
        description="With a project chosen, changes here are saved to its settings; without one, to your settings, for every project."
      >
        <ProjectFolder folder={folder} onChange={setFolder} testId="extensions-folder" />
        <p role="status" data-testid="extensions-scope" className="min-h-4 text-xs text-muted-foreground">
          {where !== null
            ? `Saved to ${where}'s dimfactory.json.`
            : 'Saved to your settings, for every project.'}
        </p>
      </Group>

      <Group
        title="Passes"
        description="None: built-in tools only. Allowed list: only what you tick below. Pass through: everything in your own CLI settings."
        field="passes"
        testId="extensions-passes"
      >
        <ul className="flex flex-col">
          {(levels.length > 0 ? levels : PASS_PLACEHOLDER).map((l) => (
            <li
              key={l.pass}
              className="flex flex-col gap-1 border-b py-2 last:border-b-0"
              data-testid={`extensions-pass-${l.pass}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-sm">{stepLabel(l.pass)}</span>
                <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {loading ? '' : vendorName(l.vendor)}
                </span>
                <SourceBadge
                  provenance={provenance?.[`/passes/${l.pass}/extensions`]}
                  loading={loading}
                  testId={`extensions-source-${l.pass}`}
                />
                {/* The select's box until core answers (a section switch renders at once, performance.spec.ts), same size. */}
                {loading ? (
                  <span
                    aria-hidden
                    data-testid={`pass-extensions-settings-${l.pass}-pending`}
                    className="h-7 w-36 shrink-0 rounded-md border border-input opacity-50"
                  />
                ) : (
                  <ExtensionsSelect
                    id={`settings-${l.pass}`}
                    pass={l.pass}
                    label={`${stepLabel(l.pass)} extensions`}
                    value={l.level}
                    disabled={busy === `/passes/${l.pass}/extensions`}
                    onChange={(level) => setLevel(l.pass, level)}
                  />
                )}
              </div>
              {/* Two lines kept from the start: the copy arrives with core's answer without moving the rows below. */}
              {loading ? (
                <p aria-hidden className="min-h-8" />
              ) : (
                <ExtensionsCopy
                  id={`settings-${l.pass}`}
                  pass={l.pass}
                  vendor={l.vendor}
                  value={l.level}
                  className="min-h-8"
                />
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{SKILLS_LIMIT_NOTE}</p>
      </Group>

      <ContextGroup
        folder={folder}
        config={resolved.value?.config ?? null}
        epoch={epoch}
        onSettled={reload}
      />

      <section
        aria-label="What your vendors define"
        data-setting-field="/extensions/allowed"
        data-testid="extensions-found"
        aria-busy={discovered.value === null || undefined}
        className="flex min-h-24 flex-col gap-6"
      >
        {discovered.value === null ? (
          <p className="text-xs text-muted-foreground" data-testid="extensions-reading">
            {discovered.error !== null
              ? `The vendors’ settings could not be read: ${discovered.error}`
              : READING_EXTENSIONS}
          </p>
        ) : (
          discovered.value.vendors.map((found) => (
            <VendorGroup
              key={found.vendor}
              found={found}
              config={shownConfig}
              levels={levels}
              busy={busy}
              onTick={tick}
              connectors={
                found.vendor === 'claude'
                  ? { busy: listing, result: listed, onList: listConnectors }
                  : undefined
              }
            />
          ))
        )}
      </section>
    </div>
  )
}

/** The passes' rows before core answers (their room is kept; the controls are disabled). */
const PASS_PLACEHOLDER: PassLevel[] = (['plan', 'implement', 'review', 'critic', 'fix'] as const).map(
  (pass) => ({
    pass,
    vendor: '',
    level: isReadOnlyExtensionsPass(pass) ? 'none' : 'passthrough',
    enabled: true,
  }),
)
