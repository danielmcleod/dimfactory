// Settings → Outside agents: let an agent the user runs (Claude Code, Codex, any MCP client) read Dim Factory's runs and
// ask for new ones over MCP. Off by default; when on, core listens on 127.0.0.1 at a fixed port with a bearer token
// (mcp.external.get / set). A request an agent makes waits on the Dashboard until the user approves it.
//
// The token is masked until the user shows it; snippets show `<token>` in its place while it is masked (Copy copies
// the real one and says so). New token and Install for Codex / Claude Code are two-step: the first click says what
// happens (every file written and command run), the second does it. Add to VS Code / Cursor ask main to open the
// editor's install link, which main builds from the bridge command itself. Status lines keep their room while empty, so
// nothing moves when an answer arrives (UI standard): a plugin install shows one line per command and a closing line
// from the click on (each cut to one line, whole in its tooltip), and its answer fills those same lines.
import { Check, Copy, Eye, EyeOff, KeyRound, Plug, X } from 'lucide-react'
import { useState } from 'react'
import type { AgentPluginResult, ExternalMcpSetRequest, ExternalMcpView, Result } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { toast } from '../../state/toasts.ts'
import { Group, SettingRow } from './kit.tsx'
import { useSectionData } from './sectionData.ts'

export const MCP_ROUTE_PATH = '/mcp/dim-factory'
const MASK = '•'.repeat(24)
const TOKEN_PLACEHOLDER = '<token>'
const SHOW_LABELS: readonly string[] = ['Show', 'Hide']
const NEW_TOKEN_LABELS: readonly string[] = ['New token', 'Confirm new token']
const COPY_LABELS: readonly string[] = ['Copy', 'Copied']

const timeOfDay = (ms: number): string => new Date(ms).toLocaleTimeString()

export function statusText(v: ExternalMcpView): string {
  if (!v.enabled) return 'Off. No agent can connect.'
  if (v.error !== null) return v.error
  if (!v.running) return 'Not listening.'
  const last = v.lastCall !== null ? `Last call at ${timeOfDay(v.lastCall)}.` : 'No agent has called yet.'
  return `Listening on 127.0.0.1:${v.port}. ${last}`
}

/** A shell word: double-quoted when it has a space or a quote (backslashes stay as they are, as Windows paths need). */
const quote = (x: string): string => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)

export interface Snippet {
  id: string
  title: string
  text: string
}

/** The ways to connect, for this endpoint (the stdio bridge first: its configuration holds no token). */
export function snippetsFor(v: ExternalMcpView): Snippet[] {
  const url = v.url ?? `http://127.0.0.1:${v.port}${MCP_ROUTE_PATH}`
  const token = v.token ?? TOKEN_PLACEHOLDER
  const b = v.bridge
  const out: Snippet[] = []
  if (b !== null) {
    const line = [b.command, ...b.args].map(quote).join(' ')
    out.push(
      {
        id: 'claude-code',
        title: 'Claude Code (runs Dim Factory --mcp, no token in its settings)',
        text: `claude mcp add --scope user dim-factory -- ${line}`,
      },
      {
        id: 'json',
        title: 'Claude Desktop, Windsurf and other MCP clients (JSON)',
        text: JSON.stringify(
          { mcpServers: { 'dim-factory': { command: b.command, args: b.args } } },
          null,
          2,
        ),
      },
      {
        id: 'vscode',
        title: 'VS Code (.vscode/mcp.json)',
        text: JSON.stringify(
          { servers: { 'dim-factory': { type: 'stdio', command: b.command, args: b.args } } },
          null,
          2,
        ),
      },
    )
  }
  out.push(
    {
      id: 'http-claude-code',
      title: 'Over HTTP: Claude Code',
      text: `claude mcp add --transport http dim-factory ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: 'http-codex',
      title: 'Over HTTP: Codex config.toml (set DIM_FACTORY_MCP_TOKEN to the token)',
      text: `[mcp_servers.dim-factory]\nurl = "${url}"\nbearer_token_env_var = "DIM_FACTORY_MCP_TOKEN"`,
    },
    {
      id: 'http-json',
      title: 'Over HTTP: other clients (JSON)',
      text: JSON.stringify(
        {
          mcpServers: { 'dim-factory': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
        },
        null,
        2,
      ),
    },
  )
  return out
}

function SnippetBlock({
  snippet,
  token,
  shown,
}: {
  snippet: Snippet
  token: string | null
  shown: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const hasToken = token !== null && snippet.text.includes(token)
  const text = !shown && token !== null ? snippet.text.replaceAll(token, TOKEN_PLACEHOLDER) : snippet.text
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(snippet.text)
    } catch {
      toast({ level: 'error', message: 'Dim Factory could not use the clipboard.' })
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    if (hasToken) toast({ level: 'info', message: 'Copied. It includes the token: keep it private.' })
  }
  return (
    <div className="flex flex-col gap-1" data-testid={`mcp-snippet-${snippet.id}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium">{snippet.title}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          labels={COPY_LABELS}
          aria-label={`Copy: ${snippet.title}`}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="rounded-md border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {text}
      </pre>
    </div>
  )
}

/** The agents Dim Factory installs a plugin for, and what the Settings page says about each. */
type PluginAgent = 'codex' | 'claude'

const PLUGIN_AGENTS: Readonly<
  Record<
    PluginAgent,
    { name: string; labels: readonly [string, string]; title: string; sees: string; restart: string }
  >
> = {
  codex: {
    name: 'Codex',
    labels: ['Install for Codex', 'Install'],
    title: 'Codex CLI, desktop app and IDE extension',
    sees: 'The Codex CLI, desktop app and IDE extension all see the plugin.',
    restart: 'Restart the Codex app to see it.',
  },
  claude: {
    name: 'Claude Code',
    labels: ['Install for Claude Code', 'Install'],
    title: 'Claude Code, for your user on this computer',
    sees: 'It is installed for your user, so every new Claude Code session on this computer sees the plugin.',
    restart: 'Start a new Claude Code session to see it.',
  },
}

const askPlugin = (agent: PluginAgent, install: boolean): Promise<Result<AgentPluginResult>> =>
  agent === 'codex'
    ? invoke('mcp.external.codexPlugin', { install })
    : invoke('mcp.external.claudePlugin', { install })

interface AgentPlan {
  agent: PluginAgent
  plan: AgentPluginResult
}

/**
 * A plugin install's status: one line per command (to run, done, failed with the CLI's words, or not run) and a
 * closing line, each one line high whatever it says (the whole text in its tooltip), so the answer never moves the page.
 */
function InstallLines({ agent, plan, done }: AgentPlan & { done: boolean }): React.JSX.Element {
  const a = PLUGIN_AGENTS[agent]
  const line = (key: string, text: string, tone: 'muted' | 'bad', testId?: string): React.JSX.Element => (
    <p
      key={key}
      title={text}
      data-testid={testId}
      className={cn('truncate', tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {text}
    </p>
  )
  const final = !done
    ? `Installing the Dim Factory plugin for ${a.name}…`
    : plan.installed
      ? `The Dim Factory plugin is installed for ${a.name}. ${a.restart}`
      : `By hand: ${plan.commands.join(', then ')}.`
  return (
    <>
      {plan.commands.map((command, i) => {
        if (!done) return line(command, `To run: ${command}`, 'muted')
        const st = plan.steps[i]
        if (st === undefined) return line(command, `Not run: ${command}`, 'muted')
        return st.ok
          ? line(command, `Done: ${command}`, 'muted')
          : line(command, `Failed: ${command}${st.output !== '' ? `: ${st.output}` : ''}`, 'bad')
      })}
      {line('final', final, 'muted', `mcp-${agent}-final`)}
    </>
  )
}

function ConnectApps({ view }: { view: ExternalMcpView | null }): React.JSX.Element {
  /** The plan the user is asked to confirm (its agent's button reads Install). */
  const [plan, setPlan] = useState<AgentPlan | null>(null)
  const [result, setResult] = useState<AgentPlan | null>(null)
  /** The plan an install is running (its lines hold the room the answer fills). */
  const [installing, setInstalling] = useState<AgentPlan | null>(null)
  const [busy, setBusy] = useState<PluginAgent | null>(null)
  const [editorNote, setEditorNote] = useState('')
  // Disabled while loading, and on a host with no bridge command.
  const noBridge = view?.bridge == null
  const start = async (agent: PluginAgent): Promise<void> => {
    if (plan?.agent === agent) {
      const running = plan
      setPlan(null)
      setResult(null)
      setInstalling(running)
      setBusy(agent)
      const r = await askPlugin(agent, true)
      setBusy(null)
      setInstalling(null)
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        // Nothing ran: the same lines say so, and how to do it by hand.
        setResult({ agent, plan: { ...running.plan, installed: false, steps: [] } })
        return
      }
      setResult({ agent, plan: r.value })
      return
    }
    setBusy(agent)
    const r = await askPlugin(agent, false)
    setBusy(null)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    setResult(null)
    setPlan({ agent, plan: r.value })
  }
  const editor = async (e: 'vscode' | 'cursor'): Promise<void> => {
    const r = await invoke('mcp.addToEditor', { editor: e })
    setEditorNote(
      r.ok
        ? `Asked ${e === 'vscode' ? 'VS Code' : 'Cursor'} to add Dim Factory. Confirm it there.`
        : r.error.message,
    )
  }
  const installButton = (agent: PluginAgent): React.JSX.Element => {
    const a = PLUGIN_AGENTS[agent]
    const armed = plan?.agent === agent
    return (
      <Button
        size="sm"
        variant={armed ? 'default' : 'outline'}
        icon={<Plug aria-hidden />}
        labels={a.labels}
        data-testid={`mcp-${agent}-install`}
        loading={busy === agent}
        disabled={noBridge || (busy !== null && busy !== agent)}
        title={a.title}
        onClick={() => void start(agent)}
      >
        {armed ? a.labels[1] : a.labels[0]}
      </Button>
    )
  }
  const lines = installing ?? result
  return (
    <Group
      title="Connect an app"
      description="These run Dim Factory itself as a local MCP server (Dim Factory --mcp), which reads the token from this computer's settings, so no token goes into the app's configuration. Keep Dim Factory open while the agent works."
      testId="mcp-connect"
    >
      <div className="flex flex-wrap items-center gap-2">
        {installButton('codex')}
        {installButton('claude')}
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-plugin-cancel"
          className={cn(plan === null && 'invisible')}
          aria-hidden={plan === null || undefined}
          tabIndex={plan !== null ? undefined : -1}
          disabled={plan === null || busy !== null}
          onClick={() => setPlan(null)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="mcp-add-vscode"
          disabled={noBridge}
          onClick={() => void editor('vscode')}
        >
          Add to VS Code
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="mcp-add-cursor"
          disabled={noBridge}
          onClick={() => void editor('cursor')}
        >
          Add to Cursor
        </Button>
      </div>
      {plan !== null && (
        <div
          data-testid={`mcp-${plan.agent}-confirm`}
          className="flex flex-col gap-1 rounded-md border p-2 text-xs"
        >
          <p className="font-medium">Install writes these files:</p>
          <ul className="flex flex-col gap-0.5 font-mono [overflow-wrap:anywhere]">
            {plan.plan.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="font-medium">and runs:</p>
          <ul className="flex flex-col gap-0.5 font-mono [overflow-wrap:anywhere]">
            {plan.plan.commands.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">{PLUGIN_AGENTS[plan.agent].sees}</p>
        </div>
      )}
      <div role="status" className="flex min-h-4 flex-col gap-0.5 text-xs" data-testid="mcp-connect-status">
        {editorNote !== '' && <p className="text-muted-foreground">{editorNote}</p>}
        {lines !== null && <InstallLines agent={lines.agent} plan={lines.plan} done={installing === null} />}
      </div>
    </Group>
  )
}

export function OutsideAgentsSection(): React.JSX.Element {
  const data = useSectionData<ExternalMcpView>('mcp', () => invoke('mcp.external.get'))
  const view = data.value
  const [shown, setShown] = useState(false)
  const [port, setPort] = useState<string | null>(null)
  const [writing, setWriting] = useState<'enabled' | 'port' | 'token' | null>(null)
  const [tokenArmed, setTokenArmed] = useState(false)

  const set = async (req: ExternalMcpSetRequest, what: 'enabled' | 'port' | 'token'): Promise<void> => {
    setWriting(what)
    const r = await invoke('mcp.external.set', req)
    setWriting(null)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    data.set(r.value)
    if (what === 'port') setPort(null)
  }

  const portText = port ?? (view !== null ? String(view.port) : '')
  const portNum = Number(portText)
  const portOk = /^\d+$/.test(portText) && portNum >= 1024 && portNum <= 65535
  const off = view === null
  const token = view?.token ?? null
  const tokenText = token === null ? 'Made when you turn access on' : shown ? token : MASK

  return (
    <div className="flex flex-col gap-6" data-testid="settings-outside-agents" aria-busy={off || undefined}>
      {data.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The outside agent settings could not be read: {data.error}
        </p>
      )}
      <Group
        title="Access"
        description="Let an agent you run yourself (Claude Code, Codex or any MCP client) read your runs (status, plans, findings, diffs, logs, estimates) and ask for new ones. A request waits on the Dashboard until you approve it; agents cannot answer questions, approve plans, stop runs or change settings. Dim Factory listens on this computer only and wants the token. Anyone with the token who can run programs on this computer can use it, so treat it like a password."
      >
        <div>
          <SettingRow label="Let outside agents connect" field="enabled">
            <Switch
              data-testid="mcp-enabled"
              aria-label="Let outside agents connect"
              checked={view?.enabled ?? false}
              disabled={off || writing !== null}
              onCheckedChange={(on) => void set({ enabled: on }, 'enabled')}
            />
          </SettingRow>
          {/* Not a SettingRow: the status is text that wraps in a narrow window. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b py-2">
            <span className="text-sm">Status</span>
            <p
              role="status"
              data-testid="mcp-status"
              className={cn(
                'min-h-5 max-w-80 min-w-0 text-xs [overflow-wrap:anywhere]',
                view?.enabled === true && view.error !== null ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {view !== null ? statusText(view) : ''}
            </p>
          </div>
          <SettingRow
            label="Port"
            description="On 127.0.0.1. Agents set up with the old port need the new one."
            field="port"
          >
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (portOk && view !== null && portNum !== view.port) void set({ port: portNum }, 'port')
              }}
            >
              <Input
                data-testid="mcp-port"
                aria-label="Port"
                inputMode="numeric"
                value={portText}
                aria-invalid={!portOk || undefined}
                disabled={off}
                onChange={(e) => setPort(e.target.value)}
                className="h-7 w-24 font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                type="submit"
                data-testid="mcp-port-change"
                loading={writing === 'port'}
                disabled={off || !portOk || portNum === view?.port || writing !== null}
              >
                Change
              </Button>
            </form>
          </SettingRow>
          {/* Not a SettingRow: the token and its buttons wrap onto lines of their own in a narrow window. */}
          <div data-setting-field="token" className="flex flex-col gap-1.5 border-b py-2 last:border-b-0">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm">Token</span>
              <span className="text-xs text-muted-foreground">
                {tokenArmed
                  ? 'A new token stops every agent set up with this one until you update it.'
                  : 'Shown here only when you ask.'}
              </span>
            </div>
            <div
              className="flex min-w-0 flex-wrap items-center gap-2"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && tokenArmed) {
                  e.stopPropagation()
                  setTokenArmed(false)
                }
              }}
            >
              <code
                data-testid="mcp-token"
                data-masked={!shown || undefined}
                className="max-w-full min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs [overflow-wrap:anywhere]"
              >
                {tokenText}
              </code>
              <Button
                size="sm"
                variant="ghost"
                data-testid="mcp-token-show"
                icon={shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                labels={SHOW_LABELS}
                aria-label={shown ? 'Hide the token' : 'Show the token'}
                disabled={token === null}
                onClick={() => setShown((x) => !x)}
              >
                {shown ? 'Hide' : 'Show'}
              </Button>
              <Button
                size="sm"
                variant={tokenArmed ? 'destructive' : 'outline'}
                data-testid="mcp-token-new"
                icon={<KeyRound aria-hidden />}
                labels={NEW_TOKEN_LABELS}
                loading={writing === 'token'}
                disabled={off || token === null || (writing !== null && writing !== 'token')}
                onClick={() => {
                  if (!tokenArmed) {
                    setTokenArmed(true)
                    return
                  }
                  setTokenArmed(false)
                  void set({ regenerate: true }, 'token')
                }}
              >
                {tokenArmed ? 'Confirm new token' : 'New token'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="mcp-token-cancel"
                icon={<X aria-hidden />}
                className={cn(!tokenArmed && 'invisible')}
                aria-hidden={!tokenArmed || undefined}
                tabIndex={tokenArmed ? undefined : -1}
                disabled={!tokenArmed}
                onClick={() => setTokenArmed(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Group>
      <ConnectApps view={view} />
      <Group
        title="Set up an agent yourself"
        description="Pick the one your agent uses. The token shows as <token> until you show it; Copy copies the real one."
        testId="mcp-snippets"
      >
        {view !== null && (
          <div className="flex flex-col gap-3">
            {snippetsFor(view).map((sn) => (
              <SnippetBlock key={sn.id} snippet={sn} token={token} shown={shown} />
            ))}
          </div>
        )}
      </Group>
    </div>
  )
}
