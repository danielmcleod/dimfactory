// Settings → Outside agents: the switch, the status line (its room kept while loading), the port, the token masked
// until shown (and in the snippets), New token and Install for Codex / Claude Code as two steps (the first says what
// happens), Add to VS Code / Cursor through main, and no em dash anywhere.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudePluginResult, CodexPluginResult, ExternalMcpView } from '@shared/ipc.ts'
import {
  OutsideAgentsSection,
  snippetsFor,
  statusText,
} from '@renderer/pages/settings/OutsideAgentsSection.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const TOKEN = 'T0k3n_abcdefghijklmnopqrstuvwxyz0123456789AB'
const BRIDGE = { command: 'C:\\Program Files\\Dim Factory\\Dim Factory.exe', args: ['--mcp'] }

const VIEW: ExternalMcpView = {
  enabled: false,
  port: 47821,
  running: false,
  url: null,
  token: null,
  error: null,
  lastCall: null,
  bridge: BRIDGE,
}
const ON: ExternalMcpView = {
  ...VIEW,
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:47821/mcp/dim-factory',
  token: TOKEN,
}
const PLAN: CodexPluginResult = {
  dir: 'C:\\home\\codex-marketplace',
  files: ['C:\\home\\codex-marketplace\\.agents\\plugins\\marketplace.json'],
  commands: [
    'codex plugin marketplace add C:\\home\\codex-marketplace',
    'codex plugin add dim-factory@dim-factory',
  ],
  installed: false,
  steps: [],
}
const CLAUDE_PLAN: ClaudePluginResult = {
  dir: 'C:\\home\\claude-marketplace',
  files: ['C:\\home\\claude-marketplace\\.claude-plugin\\marketplace.json'],
  commands: [
    'claude plugin marketplace add C:\\home\\claude-marketplace',
    'claude plugin install dim-factory@dim-factory',
  ],
  installed: false,
  steps: [],
}

let mock: MockDimFactory
let view: ExternalMcpView

beforeEach(() => {
  view = VIEW
  mock = setUp({
    handlers: {
      'mcp.external.get': () => view,
      'mcp.external.set': (req) => {
        view = {
          ...view,
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
          ...(req.port !== undefined ? { port: req.port } : {}),
        }
        if (view.enabled)
          view = { ...view, running: true, token: req.regenerate === true ? `${TOKEN}x` : TOKEN }
        else view = { ...view, running: false }
        view = { ...view, url: view.running ? `http://127.0.0.1:${view.port}/mcp/dim-factory` : null }
        return view
      },
      'mcp.external.codexPlugin': (req) =>
        req.install
          ? {
              ...PLAN,
              installed: true,
              steps: PLAN.commands.map((c) => ({ command: c, ok: true, output: '' })),
            }
          : PLAN,
      'mcp.external.claudePlugin': (req) =>
        req.install
          ? {
              ...CLAUDE_PLAN,
              installed: true,
              steps: CLAUDE_PLAN.commands.map((c) => ({ command: c, ok: true, output: '' })),
            }
          : CLAUDE_PLAN,
      'mcp.addToEditor': () => undefined,
    },
  })
})
afterEach(() => tearDown(mock))

async function mount(): Promise<HTMLElement> {
  render(
    <Providers>
      <OutsideAgentsSection />
    </Providers>,
  )
  const root = screen.getByTestId('settings-outside-agents')
  // Loading: busy, and the status line is there (empty) so nothing moves when it fills.
  expect(root.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByTestId('mcp-status').textContent).toBe('')
  await settle(200)
  expect(root.getAttribute('aria-busy')).toBeNull()
  return root
}

describe('Settings → Outside agents', () => {
  it('is off by default and says so; turning it on listens and shows the token masked', async () => {
    const root = await mount()
    expect(screen.getByTestId('mcp-status').textContent).toBe('Off. No agent can connect.')
    expect(screen.getByTestId('mcp-enabled').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByTestId('mcp-enabled'))
    await settle()
    expect(mock.callsOf('mcp.external.set')).toEqual([{ enabled: true }])
    expect(screen.getByTestId('mcp-status').textContent).toBe(
      'Listening on 127.0.0.1:47821. No agent has called yet.',
    )
    const token = screen.getByTestId('mcp-token')
    expect(token.textContent).toBe('•'.repeat(24))
    expect(root.textContent).not.toContain(TOKEN)
    // The snippets show <token> in its place while it is masked.
    expect(
      within(screen.getByTestId('mcp-snippet-http-claude-code')).getByText(/Bearer <token>/),
    ).toBeTruthy()
    fireEvent.click(screen.getByTestId('mcp-token-show'))
    expect(token.textContent).toBe(TOKEN)
    expect(screen.getByTestId('mcp-snippet-http-claude-code').textContent).toContain(`Bearer ${TOKEN}`)
    expect(screen.getByTestId('mcp-token-show').textContent).toContain('Hide')
    expect(root.textContent).not.toContain('\u2014')
  })

  it('changes the port only to a valid, different one', async () => {
    view = ON
    await mount()
    const input = screen.getByTestId<HTMLInputElement>('mcp-port')
    const change = screen.getByTestId<HTMLButtonElement>('mcp-port-change')
    expect(input.value).toBe('47821')
    expect(change.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '80' } })
    expect(change.disabled).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: '48000' } })
    expect(change.disabled).toBe(false)
    fireEvent.click(change)
    await settle()
    expect(mock.callsOf('mcp.external.set')).toEqual([{ port: 48000 }])
    expect(screen.getByTestId('mcp-status').textContent).toContain('127.0.0.1:48000')
  })

  it('asks before a new token, and Cancel keeps the old one', async () => {
    view = ON
    await mount()
    const btn = screen.getByTestId('mcp-token-new')
    const cancel = screen.getByTestId('mcp-token-cancel')
    expect(cancel.className).toContain('invisible')
    fireEvent.click(btn)
    expect(btn.textContent).toContain('Confirm new token')
    expect(cancel.className).not.toContain('invisible')
    fireEvent.click(cancel)
    expect(btn.textContent).toContain('New token')
    expect(mock.callsOf('mcp.external.set')).toEqual([])
    fireEvent.click(btn)
    fireEvent.click(btn)
    await settle()
    expect(mock.callsOf('mcp.external.set')).toEqual([{ regenerate: true }])
  })

  it('lists what the Codex install writes and runs before it runs it', async () => {
    view = ON
    await mount()
    fireEvent.click(screen.getByTestId('mcp-codex-install'))
    await settle()
    expect(mock.callsOf('mcp.external.codexPlugin')).toEqual([{ install: false }])
    const confirm = screen.getByTestId('mcp-codex-confirm')
    expect(confirm.textContent).toContain('marketplace.json')
    expect(confirm.textContent).toContain('codex plugin add dim-factory@dim-factory')
    fireEvent.click(screen.getByTestId('mcp-codex-install'))
    await settle()
    expect(mock.callsOf('mcp.external.codexPlugin')).toEqual([{ install: false }, { install: true }])
    expect(screen.queryByTestId('mcp-codex-confirm')).toBeNull()
    const status = screen.getByTestId('mcp-connect-status')
    expect(status.textContent).toContain('Done: codex plugin add dim-factory@dim-factory')
    expect(status.textContent).toContain('installed for Codex')
  })

  it('lists what the Claude Code install writes and runs before it runs it, and Cancel drops it', async () => {
    view = ON
    await mount()
    const btn = screen.getByTestId('mcp-claude-install')
    expect(btn.textContent).toContain('Install for Claude Code')
    fireEvent.click(btn)
    await settle()
    expect(mock.callsOf('mcp.external.claudePlugin')).toEqual([{ install: false }])
    expect(mock.callsOf('mcp.external.codexPlugin')).toEqual([])
    const confirm = screen.getByTestId('mcp-claude-confirm')
    expect(confirm.textContent).toContain('.claude-plugin')
    expect(confirm.textContent).toContain('claude plugin install dim-factory@dim-factory')
    // Only the armed agent's button reads Install; the Codex one keeps its label.
    expect(btn.textContent).not.toContain('for Claude Code')
    expect(screen.getByTestId('mcp-codex-install').textContent).toContain('Install for Codex')
    fireEvent.click(screen.getByTestId('mcp-plugin-cancel'))
    expect(screen.queryByTestId('mcp-claude-confirm')).toBeNull()
    expect(btn.textContent).toContain('Install for Claude Code')
    fireEvent.click(btn)
    await settle()
    fireEvent.click(btn)
    await settle()
    expect(mock.callsOf('mcp.external.claudePlugin')).toEqual([
      { install: false },
      { install: false },
      { install: true },
    ])
    expect(screen.queryByTestId('mcp-claude-confirm')).toBeNull()
    const status = screen.getByTestId('mcp-connect-status')
    expect(status.textContent).toContain('Done: claude plugin install dim-factory@dim-factory')
    expect(screen.getByTestId('mcp-claude-final').textContent).toBe(
      'The Dim Factory plugin is installed for Claude Code. Start a new Claude Code session to see it.',
    )
    expect(screen.getByTestId('settings-outside-agents').textContent).not.toContain('\u2014')
  })

  it('holds the install status lines from the click on, so the answer fills them and nothing moves', async () => {
    view = ON
    let answer: (r: CodexPluginResult) => void = () => undefined
    mock.on('mcp.external.codexPlugin', (req) =>
      req.install
        ? new Promise<CodexPluginResult>((r) => {
            answer = r
          })
        : PLAN,
    )
    await mount()
    fireEvent.click(screen.getByTestId('mcp-codex-install'))
    await settle()
    fireEvent.click(screen.getByTestId('mcp-codex-install'))
    await settle()
    const lines = (): string[] =>
      Array.from(screen.getByTestId('mcp-connect-status').querySelectorAll('p')).map(
        (p) => p.textContent ?? '',
      )
    expect(lines()).toEqual([
      'To run: codex plugin marketplace add C:\\home\\codex-marketplace',
      'To run: codex plugin add dim-factory@dim-factory',
      'Installing the Dim Factory plugin for Codex…',
    ])
    const long = `codex: ${'x'.repeat(500)}`
    await act(async () => {
      answer({
        ...PLAN,
        steps: [{ command: PLAN.commands[0] as string, ok: false, output: long }],
      })
      await Promise.resolve()
    })
    await settle()
    expect(lines()).toEqual([
      `Failed: codex plugin marketplace add C:\\home\\codex-marketplace: ${long}`,
      'Not run: codex plugin add dim-factory@dim-factory',
      `By hand: ${PLAN.commands.join(', then ')}.`,
    ])
    // Each line stays one line high (cut, whole in its tooltip).
    for (const p of screen.getByTestId('mcp-connect-status').querySelectorAll('p')) {
      expect(p.className).toContain('truncate')
      expect(p.getAttribute('title')).toBe(p.textContent)
    }
    expect(screen.getByTestId('settings-outside-agents').textContent).not.toContain('\u2014')
  })

  it('asks main to add Dim Factory to VS Code and Cursor (the request names only the editor)', async () => {
    view = ON
    await mount()
    fireEvent.click(screen.getByTestId('mcp-add-vscode'))
    fireEvent.click(screen.getByTestId('mcp-add-cursor'))
    await settle()
    expect(mock.callsOf('mcp.addToEditor')).toEqual([{ editor: 'vscode' }, { editor: 'cursor' }])
    expect(screen.getByTestId('mcp-connect-status').textContent).toContain('Asked Cursor to add Dim Factory')
  })

  it('without a bridge (a test host) offers the HTTP snippets only and no one-click setup', async () => {
    view = { ...ON, bridge: null }
    await mount()
    expect(screen.getByTestId<HTMLButtonElement>('mcp-codex-install').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('mcp-claude-install').disabled).toBe(true)
    expect(screen.queryByTestId('mcp-snippet-claude-code')).toBeNull()
    expect(screen.getByTestId('mcp-snippet-http-codex').textContent).toContain('DIM_FACTORY_MCP_TOKEN')
  })

  it('shows a port in use as the status', async () => {
    view = { ...VIEW, enabled: true, error: 'Port 47821 is in use by another program. Pick another port.' }
    await mount()
    expect(screen.getByTestId('mcp-status').textContent).toBe(
      'Port 47821 is in use by another program. Pick another port.',
    )
    await act(async () => Promise.resolve())
  })
})

describe('snippets and status text', () => {
  it('the bridge snippets come first and carry no token', () => {
    const s = snippetsFor(ON)
    expect(s.map((x) => x.id)).toEqual([
      'claude-code',
      'json',
      'vscode',
      'http-claude-code',
      'http-codex',
      'http-json',
    ])
    for (const x of s.slice(0, 3)) expect(x.text).not.toContain(TOKEN)
    expect(s[0]?.text).toBe(`claude mcp add --scope user dim-factory -- "${BRIDGE.command}" --mcp`)
    expect(JSON.parse(s[2]?.text ?? '{}')).toEqual({
      servers: { 'dim-factory': { type: 'stdio', command: BRIDGE.command, args: ['--mcp'] } },
    })
    expect(statusText({ ...ON, lastCall: new Date(2026, 9, 6, 14, 30, 5).getTime() })).toMatch(
      /^Listening on 127\.0\.0\.1:47821\. Last call at /,
    )
  })
})
