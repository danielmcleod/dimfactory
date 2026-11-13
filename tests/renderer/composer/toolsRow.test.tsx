// The composer's Tools row (this run only): suggestion chips when the task names a tool you have set up (nothing is
// turned on until the click), the Tools menu ticked as each tool stands for this run (your Allowed list, plus picks,
// minus what you untick), Use skill, and the summary beside them, at one row height with fixed labels and no em
// dashes. The model functions say what the picks write into the run overrides, and that Save all never takes them.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig, RunOverrides } from '@shared/config-schema.ts'
import type { DiscoveredExtensions } from '@shared/extensions.ts'
import { TOOLS_LABEL, ToolsRow } from '@renderer/pages/dashboard/composer/ToolsRow.tsx'
import { useOverrides } from '@renderer/pages/dashboard/composer/state.ts'
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
  withoutTools,
} from '@renderer/pages/dashboard/composer/tools.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { baseConfig } from './fixtures.tsx'

const EM_DASH = String.fromCodePoint(0x2014)

const item = (name: string, allowable = true) => ({ name, scope: 'user' as const, allowable })
const discovered: DiscoveredExtensions = {
  vendors: [
    {
      vendor: 'claude',
      mcp: [item('linear'), item('github'), item('bad name', false)],
      skills: [item('pdf'), item('brand-voice')],
      plugins: [],
      complete: true,
      support: { mcp: true, skills: true },
    },
    {
      vendor: 'gemini',
      mcp: [item('sentry')],
      skills: [],
      plugins: [],
      complete: true,
      support: { mcp: true, skills: false },
    },
  ],
}

/** claude-only, Implement at Allowed list with github on the settings' list. */
function config(): ResolvedConfig {
  const c = baseConfig()
  c.passes.implement.extensions = 'allowed'
  c.extensions = { allowed: { claude: { mcp: ['github'], skills: [], mcpWithoutAsking: [] } } }
  return c
}

let mock: MockDimFactory
let last: RunOverrides = {}

function Harness({ task, cfg }: { task: string; cfg: ResolvedConfig }): React.JSX.Element {
  const [overrides, update] = useOverrides()
  last = overrides
  return <ToolsRow config={cfg} folder={'C:\\work\\app'} task={task} overrides={overrides} update={update} />
}

beforeEach(() => {
  last = {}
  mock = setUp({ handlers: { 'extensions.discover': () => discovered } })
})
afterEach(() => tearDown(mock))

async function mount(task = '', cfg = config()): Promise<void> {
  render(
    <Providers>
      <Harness task={task} cfg={cfg} />
    </Providers>,
  )
  await settle(50)
}

describe('the Tools row', () => {
  it('asks core for the folder’s tools once, and turns nothing on by itself', async () => {
    await mount('Add the export button')
    expect(mock.callsOf('extensions.discover')).toEqual([{ folder: 'C:\\work\\app' }])
    expect(screen.getByTestId('composer-tools').textContent).toContain(TOOLS_LABEL)
    expect(screen.getByTestId('composer-tools-summary').textContent).toBe(
      'Your own tools for this run: nothing is turned on unless you pick it.',
    )
    expect(screen.getByTestId('composer-tools-row').className).toContain('h-7')
    expect(last).toEqual({})
  })

  it('suggests a tool the task names, and only the click turns it on for this run', async () => {
    await mount('Create a Linear issue for each TODO')
    const chip = screen.getByTestId('composer-tool-hint-claude-linear')
    expect(chip.textContent).toBe('Use linear for this run')
    // Not turned on until clicked.
    expect(last).toEqual({})
    act(() => {
      fireEvent.click(chip)
    })
    await settle()
    expect(last).toEqual({ tools: { on: { claude: { mcp: ['linear'] } } } })
    expect(screen.queryByTestId('composer-tool-hint-claude-linear')).toBeNull()
    expect(screen.getByTestId('composer-tools-summary').textContent).toBe('1 on for this run')
    expect(document.body.textContent).not.toContain(EM_DASH)
  })

  it('the menu ticks each tool as it stands for this run; unticking one from settings takes it off', async () => {
    await mount()
    act(() => {
      fireEvent.keyDown(screen.getByTestId('composer-tools'), { key: 'Enter' })
    })
    await settle(300)
    const github = screen.getByTestId('composer-tool-claude-mcp-github')
    const linear = screen.getByTestId('composer-tool-claude-mcp-linear')
    expect(github.getAttribute('aria-checked')).toBe('true')
    expect(linear.getAttribute('aria-checked')).toBe('false')
    // A name Dim Factory cannot allow is not offered; skills show for Claude, which can limit them.
    expect(screen.queryByTestId('composer-tool-claude-mcp-bad name')).toBeNull()
    expect(screen.getByTestId('composer-tool-claude-skills-pdf')).toBeTruthy()
    // Gemini runs no pass here: its tools are not listed.
    expect(screen.queryByTestId('composer-tool-gemini-mcp-sentry')).toBeNull()
    expect(screen.getByTestId('composer-tools-reach').textContent).toContain(
      'Read-only passes never get a tool from here.',
    )
    act(() => {
      fireEvent.click(github)
    })
    await settle()
    expect(last).toEqual({ tools: { off: { claude: { mcp: ['github'] } } } })
    expect(screen.getByTestId('composer-tool-claude-mcp-github').getAttribute('aria-checked')).toBe('false')
  })

  it('Use skill names a skill of a vendor that runs a pass that changes files', async () => {
    await mount()
    act(() => {
      fireEvent.keyDown(screen.getByTestId('composer-use-skill'), { key: 'Enter' })
    })
    await settle(300)
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Use skill: none', 'pdf', 'brand-voice'])
    act(() => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'brand-voice' }), { key: 'Enter' })
    })
    await settle(300)
    expect(last).toEqual({ tools: { skill: { vendor: 'claude', name: 'brand-voice' } } })
    expect(screen.getByTestId('composer-tools-summary').textContent).toBe('1 on for this run')
  })
})

describe('the Tools model', () => {
  const cfg = config()
  const items = toolItems(cfg, discovered)

  it('lists the allowable tools of the run’s vendors, marking the settings’ ones', () => {
    expect(items.map((i) => [i.vendor, i.kind, i.name, i.inSettings])).toEqual([
      ['claude', 'mcp', 'linear', false],
      ['claude', 'mcp', 'github', true],
      ['claude', 'skills', 'pdf', false],
      ['claude', 'skills', 'brand-voice', false],
    ])
    expect(skillChoices(cfg, discovered).map((s) => s.name)).toEqual(['pdf', 'brand-voice'])
    expect(toolItems(cfg, null)).toEqual([])
  })

  it('a pick and an untick write only the run layer, and undo cleanly', () => {
    const linear = items[0]!
    const github = items[1]!
    let o: RunOverrides = {}
    o = setTool(o, linear, true)
    o = setTool(o, github, false)
    expect(o).toEqual({
      tools: { on: { claude: { mcp: ['linear'] } }, off: { claude: { mcp: ['github'] } } },
    })
    expect([isToolOn(o, linear), isToolOn(o, github)]).toEqual([true, false])
    expect([pickedCount(o), removedCount(o)]).toEqual([1, 1])
    o = setTool(setTool(o, linear, false), github, true)
    expect(o).toEqual({})
    o = setUseSkill({ passes: { review: { enabled: false } } }, { vendor: 'claude', name: 'pdf' })
    expect(withoutTools(o)).toEqual({ passes: { review: { enabled: false } } })
    expect(setUseSkill(o, null)).toEqual({ passes: { review: { enabled: false } } })
  })

  it('suggests by the tool’s own name or a word for its kind, never one already on', () => {
    expect(
      suggestTools(
        'open a PR with the fix',
        [...items, { vendor: 'claude', kind: 'mcp', name: 'github2', label: 'github2', inSettings: false }],
        {},
      ).map((i) => i.name),
    ).toEqual(['github2'])
    expect(suggestTools('file it in linear', items, {}).map((i) => i.name)).toEqual(['linear'])
    expect(suggestTools('nothing here', items, {})).toEqual([])
    expect(suggestTools('linear', items, setTool({}, items[0]!, true))).toEqual([])
  })

  it('says where picks reach for the run’s levels', () => {
    expect(toolsReachText(cfg)).toContain('Implement at Allowed list gets what you tick here.')
    expect(toolsReachText(cfg)).toContain('Fix at Pass through already loads all your tools')
    const none = config()
    none.passes.implement.extensions = 'none'
    none.passes.fix.extensions = 'none'
    expect(toolsReachText(none)).toContain('No pass that changes files uses your tools')
    for (const c of [cfg, none]) expect(toolsReachText(c)).not.toContain(EM_DASH)
  })
})
