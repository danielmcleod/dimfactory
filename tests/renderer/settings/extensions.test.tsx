// Settings > Extensions: each pass's level (core's resolved value, with where it comes from) and what it means for the
// pass's vendor; the MCP servers and skills each vendor's own settings define (core's extensions.discover, names
// only), each with a tick for the Allowed list and the passes that may use it. Each change is one config.patch with
// Undo; a read-only pass's Pass through needs its warning's yes and goes to the user's settings even with a project
// chosen. Nothing moves when core's answers arrive: the pass rows hold their room, the vendor lists come last.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscoveredExtensions } from '@shared/extensions.ts'
import {
  CLAUDE_CONNECTORS_BUTTON,
  CLAUDE_CONNECTORS_NOTE,
  MCP_WITHOUT_ASKING_LABEL,
  MCP_WITHOUT_ASKING_NOTE,
  SKILLS_LIMIT_NOTE,
  extensionsCopy,
} from '@shared/extensions.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import {
  AGENTS_NOTE,
  NOT_ALLOWABLE,
  READING_EXTENSIONS,
  pluginsNote,
} from '@renderer/pages/settings/ExtensionsSection.tsx'
import { usedBy, usedByText, withTicked } from '@renderer/pages/settings/extensions/model.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { fakeResolve } from '../composer/fixtures.tsx'

const EM_DASH = '\u2014'

const FOUND: DiscoveredExtensions = {
  vendors: [
    {
      vendor: 'claude',
      mcp: [
        { name: 'github', scope: 'user', allowable: true },
        { name: 'team-db', scope: 'project', allowable: true },
        { name: 'odd.name', scope: 'local', allowable: false },
      ],
      skills: [
        { name: 'pdf', scope: 'user', allowable: true },
        { name: 'tools:lint', scope: 'plugin', allowable: true },
      ],
      plugins: ['tools@mkt'],
      agents: ['code-reviewer'],
      complete: true,
      support: { mcp: true, skills: true },
    },
    {
      vendor: 'codex',
      mcp: [],
      skills: [],
      plugins: [],
      complete: false,
      support: { mcp: true, skills: false },
    },
  ],
}

const write = (): ConfigWriteResult => ({
  path: 'C:\\home\\dimfactory.json',
  changed: true,
  diff: '',
  backupId: 'b1',
})

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve({
        config: (c) => {
          c.passes.critic.extensions = 'allowed'
          c.extensions = { allowed: { claude: { mcp: ['github'], skills: [], mcpWithoutAsking: [] } } }
        },
      }),
      'extensions.discover': () => FOUND,
      'config.patch': () => write(),
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  window.location.hash = '#/settings/extensions'
  render(
    <Providers>
      <SettingsPage section="extensions" />
    </Providers>,
  )
  await settle(400)
}

async function pick(testId: string, option: string): Promise<void> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
  })
  await settle(300)
  act(() => {
    fireEvent.keyDown(screen.getByRole('option', { name: option }), { key: 'Enter' })
  })
  await settle(300)
}

describe('Settings > Extensions', () => {
  it('renders at once with the rooms kept, then core fills them in', () => {
    window.location.hash = '#/settings/extensions'
    render(
      <Providers>
        <SettingsPage section="extensions" />
      </Providers>,
    )
    // Before any answer: the pass rows (with the select's box) and the reading line, nothing fetched yet.
    for (const p of ['plan', 'implement', 'review', 'critic', 'fix'])
      expect(screen.getByTestId(`pass-extensions-settings-${p}-pending`).className).toContain('w-36')
    expect(screen.getByTestId('extensions-reading').textContent).toBe(READING_EXTENSIONS)
    expect(mock.callsOf('extensions.discover')).toEqual([])
  })

  it("lists each pass's level with its copy, and each vendor's servers and skills with who may use them", async () => {
    await mount()
    expect(screen.getByTestId('pass-extensions-settings-review').textContent).toBe('None')
    expect(screen.getByTestId('pass-extensions-settings-critic').textContent).toBe('Allowed list')
    expect(screen.getByTestId('pass-extensions-settings-implement').textContent).toBe('Pass through')
    expect(screen.getByTestId('pass-extensions-copy-settings-critic').textContent).toBe(
      extensionsCopy('claude', 'allowed'),
    )
    expect(screen.getByTestId('settings-extensions').textContent).toContain(SKILLS_LIMIT_NOTE)
    // Claude's servers: github is ticked (Critic at Allowed list), every server is used by Implement and Fix.
    const github = screen.getByTestId('extensions-claude-mcp-github')
    expect(within(github).getByTestId('extensions-claude-mcp-github-allow').getAttribute('data-state')).toBe(
      'checked',
    )
    expect(screen.getByTestId('extensions-claude-mcp-github-used').textContent).toBe(
      'Used by Implement, Critic and Fix',
    )
    expect(screen.getByTestId('extensions-claude-mcp-team-db-used').textContent).toBe(
      'Used by Implement and Fix',
    )
    // A name Dim Factory cannot pass on is shown, not tickable.
    const odd = screen.getByTestId('extensions-claude-mcp-odd.name-allow')
    expect(odd.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('extensions-claude-mcp-odd.name').innerHTML).toContain(
      NOT_ALLOWABLE.slice(0, 20),
    )
    // Skills (Claude only), plugins for information, Codex's incomplete read said.
    expect(screen.getByTestId('extensions-claude-skills-tools:lint')).toBeTruthy()
    expect(screen.getByTestId('extensions-claude-plugins').textContent).toContain('tools@mkt')
    // What plugins get below Pass through, per vendor (no "they load at Pass through" where they partly load).
    expect(screen.getByTestId('extensions-claude-plugins').textContent).toContain(pluginsNote('claude'))
    expect(pluginsNote('gemini')).toContain('every level')
    // Custom subagents for information, and how the claude.ai connectors can be listed.
    expect(screen.getByTestId('extensions-claude-agents').textContent).toBe(`${AGENTS_NOTE}: code-reviewer`)
    expect(screen.getByTestId('extensions-claude-connectors').textContent).toContain(CLAUDE_CONNECTORS_NOTE)
    expect(screen.getByTestId('extensions-claude-connectors-list').textContent).toBe(CLAUDE_CONNECTORS_BUTTON)
    expect(screen.queryByTestId('extensions-codex-agents')).toBeNull()
    expect(screen.queryByTestId('extensions-codex-skills-empty')).toBeNull()
    expect(screen.getByTestId('extensions-codex-mcp-empty')).toBeTruthy()
    expect(screen.getByTestId('extensions-codex-incomplete')).toBeTruthy()
    expect(screen.getByTestId('settings-extensions').textContent).not.toContain(EM_DASH)
  })

  it('a tick writes the allow list (one config.patch, user settings without a project)', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('extensions-claude-mcp-team-db-allow'))
    await settle(300)
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'add', path: '/extensions/allowed/claude/mcp', value: ['github', 'team-db'] }],
    })
    fireEvent.click(within(screen.getByTestId('extensions-claude-skills-pdf')).getByRole('checkbox'))
    await settle(300)
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'add', path: '/extensions/allowed/claude/skills', value: ['pdf'] }],
    })
  })

  it('Run without asking: Claude MCP rows only, usable once the server is allowed, with its side-effects note', async () => {
    await mount()
    // On every Claude MCP row (nothing appears or moves when a server is ticked), off by default.
    const github = screen.getByTestId('extensions-claude-mcp-github-no-ask')
    expect(github.getAttribute('data-state')).toBe('unchecked')
    expect(github.hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('extensions-claude-mcp-team-db-no-ask').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('extensions-claude-mcp-github').textContent).toContain(MCP_WITHOUT_ASKING_LABEL)
    expect(screen.getByTestId('extensions-claude-no-ask-note').textContent).toBe(MCP_WITHOUT_ASKING_NOTE)
    expect(MCP_WITHOUT_ASKING_NOTE).toContain('side effects')
    expect(MCP_WITHOUT_ASKING_NOTE).toContain('read-only pass')
    expect(MCP_WITHOUT_ASKING_NOTE).not.toContain(EM_DASH)
    // Codex has no such opt-in.
    expect(screen.queryByTestId('extensions-codex-no-ask-note')).toBeNull()
    fireEvent.click(github)
    await settle(300)
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'add', path: '/extensions/allowed/claude/mcpWithoutAsking', value: ['github'] }],
    })
  })

  it('List connectors asks core once, says what it found, and the listed connectors show as Account servers', async () => {
    let listed = false
    mock.on('extensions.claudeConnectors', () => {
      listed = true
      return { ok: true, count: 1 }
    })
    mock.on('extensions.discover', () =>
      listed
        ? {
            vendors: FOUND.vendors.map((v) =>
              v.vendor === 'claude'
                ? {
                    ...v,
                    mcp: [
                      ...v.mcp,
                      {
                        name: 'claude_ai_Example',
                        scope: 'account' as const,
                        allowable: true,
                        label: 'claude.ai Example',
                        status: 'needs-auth',
                      },
                    ],
                  }
                : v,
            ),
          }
        : FOUND,
    )
    await mount()
    expect(screen.getByTestId('extensions-claude-connectors-result').textContent).toBe('')
    const button = screen.getByTestId('extensions-claude-connectors-list')
    const width = button.className
    fireEvent.click(button)
    await settle(400)
    await settle(400)
    expect(mock.callsOf('extensions.claudeConnectors')).toEqual([{ force: true }])
    expect(screen.getByTestId('extensions-claude-connectors-result').textContent).toBe('Listed 1 connector.')
    expect(screen.getByTestId('extensions-claude-connectors-list').className).toBe(width)
    const row = screen.getByTestId('extensions-claude-mcp-claude_ai_Example')
    expect(row.textContent).toContain('claude.ai Example')
    expect(row.textContent).toContain('Account')
    expect(screen.getByTestId('extensions-claude-mcp-claude_ai_Example-status').textContent).toBe(
      'Needs sign-in on claude.ai',
    )
    fireEvent.click(screen.getByTestId('extensions-claude-mcp-claude_ai_Example-allow'))
    await settle(300)
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'add', path: '/extensions/allowed/claude/mcp', value: ['github', 'claude_ai_Example'] }],
    })
  })

  it('a blocked connector listing says why', async () => {
    mock.on('extensions.claudeConnectors', () => ({
      ok: false,
      count: 0,
      blocked: 'Would start other servers.',
    }))
    await mount()
    fireEvent.click(screen.getByTestId('extensions-claude-connectors-list'))
    await settle(400)
    expect(screen.getByTestId('extensions-claude-connectors-result').textContent).toBe(
      'Would start other servers.',
    )
  })

  it("a level is one config.patch; a read-only pass's Pass through asks first and goes to the user's settings", async () => {
    await mount()
    await pick('pass-extensions-settings-plan', 'Allowed list')
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'add', path: '/passes/plan/extensions', value: 'allowed' }],
    })
    const before = mock.callsOf('config.patch').length
    await pick('pass-extensions-settings-review', 'Pass through')
    expect(mock.callsOf('config.patch').length).toBe(before)
    fireEvent.click(screen.getByTestId('pass-extensions-confirm-yes-settings-review'))
    await settle(300)
    expect(mock.callsOf('config.patch').at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'add', path: '/passes/review/extensions', value: 'passthrough' }],
    })
  })
})

describe('Extensions model', () => {
  const levels = [
    { pass: 'implement' as const, vendor: 'codex', level: 'passthrough' as const, enabled: true },
    { pass: 'review' as const, vendor: 'local-ollama', level: 'allowed' as const, enabled: true },
    { pass: 'critic' as const, vendor: 'codex', level: 'allowed' as const, enabled: false },
    { pass: 'plan' as const, vendor: 'codex', level: 'none' as const, enabled: true },
  ]

  it('usedBy: passes on the vendor at Pass through, and at Allowed list when ticked; off passes left out', () => {
    expect(usedBy(levels, 'codex', true)).toEqual(['implement', 'review'])
    expect(usedBy(levels, 'codex', false)).toEqual(['implement'])
    expect(usedBy(levels, 'claude', true)).toEqual([])
    expect(usedByText([])).toBe('Not used by any pass')
    expect(usedByText(['review'])).toBe('Used by Review')
    expect(usedByText(['plan', 'review', 'fix'])).toBe('Used by Plan, Review and Fix')
  })

  it('withTicked adds once and removes', () => {
    expect(withTicked(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(withTicked(['a', 'b'], 'a', true)).toEqual(['b', 'a'])
    expect(withTicked(['a', 'b'], 'a', false)).toEqual(['b'])
  })
})
