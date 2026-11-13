// Settings → Prompts (tabs; placeholder chips; Implement word count;
// user/project scope; diff vs default; reset with undo; template lookup and placeholders; the done-check flow
// "override a prompt for one project"). The mock core resolves prompts project → user → built-in from the texts it
// holds, refuses an unknown placeholder with core's line-numbered issue, and answers a save with what the scope held.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditablePromptName, PromptView, RecentFolder } from '@shared/ipc.ts'
import { LOAD_DELAY_MS } from '@renderer/pages/settings/general/ProjectFolder.tsx'
import { resetPromptDraftsForTests } from '@renderer/pages/settings/PromptsSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

const EM_DASH = '\u2014'
const HOME = 'C:\\home'
const PROJECT = 'C:\\work\\app'

const DEFAULTS: Record<EditablePromptName, string> = {
  plan: 'Plan this task:\n{{task}}\n',
  implement: 'Implement:\n{{task}}\n{{#plan}}Plan:\n{{plan}}{{/plan}}\n',
  review: 'Review this diff:\n{{diff}}\n',
  critic: 'Criticise this diff:\n{{diff}}\n',
  security: 'Check the security of this diff:\n{{diff}}\n{{scan}}\n',
  fix: 'Fix these:\n{{findings}}\n',
  clarify: 'Ask at most {{questions}} questions about:\n{{task}}\n',
  'clarify-easy': 'Ask at most {{questions}} plain questions about:\n{{task}}\n',
  research: 'Research {{lenses}} ({{access}}) for:\n{{task}}\n',
  acceptance: 'Check {{acceptance}} against:\n{{diff}}\n',
  explain: 'Explain:\n{{task}}\n',
  'explain-easy': 'Explain plainly:\n{{task}}\n',
  deploy: 'Deploy to {{target}}:\n{{files}}\n',
  direct: '{{task}}\n',
}
const ALLOWED: Record<EditablePromptName, string[]> = {
  plan: ['task'],
  implement: ['task', 'plan'],
  review: ['task', 'plan', 'diff', 'verify'],
  critic: ['task', 'plan', 'diff', 'verify'],
  security: ['task', 'plan', 'diff', 'verify', 'scan'],
  fix: ['task', 'plan', 'diff', 'findings', 'verify'],
  clarify: ['task', 'brief', 'questions', 'memory'],
  'clarify-easy': ['task', 'brief', 'questions', 'memory'],
  research: ['task', 'brief', 'lenses', 'access', 'memory'],
  acceptance: ['task', 'plan', 'acceptance', 'diff', 'verify'],
  explain: ['task', 'brief', 'plan', 'files', 'run'],
  'explain-easy': ['task', 'brief', 'plan', 'files', 'run'],
  deploy: ['task', 'target', 'deliverable', 'files', 'env'],
  direct: ['task', 'plan'],
}
const REQUIRED: Record<EditablePromptName, string[]> = {
  plan: ['task'],
  implement: ['task', 'plan'],
  review: ['diff'],
  critic: ['diff'],
  security: ['diff'],
  fix: ['findings'],
  clarify: ['task', 'questions'],
  'clarify-easy': ['task', 'questions'],
  research: ['task', 'lenses', 'access'],
  acceptance: ['acceptance', 'diff'],
  explain: ['task'],
  'explain-easy': ['task'],
  deploy: ['target', 'files'],
  direct: ['task'],
}

let user: Partial<Record<EditablePromptName, string>>
let project: Partial<Record<EditablePromptName, string>>
let mock: MockDimFactory

const userPath = (p: EditablePromptName) => `${HOME}\\prompts\\${p}.md`
const projectPath = (p: EditablePromptName) => `${PROJECT}\\.dimfactory\\prompts\\${p}.md`

function viewOf(name: EditablePromptName, folder: string | undefined): PromptView {
  const proj = folder !== undefined ? project[name] : undefined
  const mine = user[name]
  const [text, source, path] =
    proj !== undefined
      ? [proj, 'project' as const, projectPath(name)]
      : mine !== undefined
        ? [mine, 'user' as const, userPath(name)]
        : [DEFAULTS[name], 'builtin' as const, null]
  return {
    name,
    text,
    source,
    path,
    defaultText: DEFAULTS[name],
    allowed: ALLOWED[name],
    required: REQUIRED[name],
    wordCount: text.split(/\s+/).filter((w) => w !== '').length,
    editable: true,
    overrides: { user: mine !== undefined, project: folder !== undefined ? proj !== undefined : null },
  }
}

const recent: RecentFolder[] = [
  { folder: PROJECT, scopeRoot: PROJECT, lastRunAt: 1, isGit: true, exists: true },
]

beforeEach(() => {
  user = {}
  project = {}
  resetPromptDraftsForTests()
  mock = setUp({
    handlers: {
      'prompts.get': (req) => viewOf(req.name as EditablePromptName, req.folder),
      'prompts.save': (req) => {
        if (req.text !== null && req.text.includes('{{tsk}}')) {
          const line = req.text.slice(0, req.text.indexOf('{{tsk}}')).split('\n').length
          throw mockError('VALIDATION', 'The plan prompt has an error', [
            {
              code: 'unknown-placeholder',
              severity: 'error',
              message:
                'Unknown placeholder {{tsk}} in the plan template (did you mean {{task}}?). Allowed: task',
              line,
              col: 1,
              name: 'tsk',
              file: userPath('plan'),
            },
          ])
        }
        const store = req.scope === 'project' ? project : user
        const before = store[req.name] ?? null
        if (req.text === null) delete store[req.name]
        else store[req.name] = req.text
        return {
          ...viewOf(req.name, req.scope === 'project' ? req.folder : undefined),
          previous: { scope: req.scope, text: before },
        }
      },
      'folders.recent': () => recent,
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(hash?: string): Promise<HTMLElement> {
  if (hash !== undefined) window.location.hash = hash
  render(
    <Providers>
      <SettingsPage section="prompts" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
  return screen.getByTestId('settings-prompts')
}

const editor = () => screen.getByTestId<HTMLTextAreaElement>('prompt-editor')
const saves = () => mock.callsOf('prompts.save')
const lastToast = () => useStore.getState().toasts.items.at(-1)

async function edit(text: string): Promise<void> {
  fireEvent.change(editor(), { target: { value: text } })
  await settle()
}

async function click(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId(testId))
  await settle(LOAD_DELAY_MS)
}

async function tab(pass: EditablePromptName): Promise<void> {
  fireEvent.mouseDown(screen.getByTestId(`prompts-tab-${pass}`), { button: 0 })
  await settle(LOAD_DELAY_MS)
}

async function undo(): Promise<void> {
  await act(async () => {
    const action = lastToast()?.action
    if (action !== undefined && 'onClick' in action) await action.onClick()
  })
  await settle()
}

describe('Settings → Prompts', () => {
  it('is live: one tab per pass, nothing read while passing through, then the built-in text', async () => {
    expect(findSection('prompts')?.live).toBe(true)
    render(
      <Providers>
        <SettingsPage section="prompts" />
      </Providers>,
    )
    expect(mock.callsOf('prompts.get')).toHaveLength(0)
    // Until the template is read the panel is one line, the last thing in the section: what replaces it moves nothing.
    expect(screen.queryByTestId('prompt-editor')).toBeNull()
    expect(screen.queryByTestId('prompt-save')).toBeNull()
    const panel = screen.getByTestId('prompt-panel-plan')
    expect(panel.textContent).toBe('Reading the template…')
    expect(panel.getAttribute('aria-busy')).toBe('true')
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('prompts.get')).toEqual([{ name: 'plan' }])
    expect(
      ['plan', 'implement', 'review', 'critic', 'fix'].map(
        (p) => screen.getByTestId(`prompts-tab-${p}`).textContent,
      ),
    ).toEqual(['Plan', 'Implement', 'Review', 'Critic', 'Fix'])
    expect(editor().value).toBe(DEFAULTS.plan)
    expect(editor().disabled).toBe(false)
    // The chips' row is a chip tall even before (or without) chips, so it never grows when they come.
    expect(screen.getByRole('group', { name: 'Placeholders' }).className.split(' ')).toContain('min-h-6')
    expect(screen.getByTestId('prompt-source').textContent).toBe('Built-in')
    expect(screen.getByTestId('prompt-explain').textContent).toContain('the text below is the built-in one')
    expect(screen.getByTestId('prompts-lookup').textContent).toBe(
      "Dim Factory uses the first template it finds: the project's own (in the project's .dimfactory/prompts folder), then yours, then the built-in one.",
    )
    const content = screen.getByTestId('settings-prompts')
    expect(content.textContent).not.toContain(EM_DASH)
    for (const id of ['template', 'scope', 'reset', 'diff'])
      expect(content.querySelector(`[data-setting-field="${id}"]`), id).not.toBeNull()
    expect(screen.getByLabelText('Plan prompt')).toBe(editor())
    expect(screen.getByRole('radiogroup', { name: 'Prompt scope' })).toBeTruthy()
  })

  it('Save for you writes your template; Undo removes it again', async () => {
    await mount()
    expect(screen.getByTestId<HTMLButtonElement>('prompt-save').disabled).toBe(true)
    await edit('Plan carefully:\n{{task}}\n')
    expect(screen.getByTestId('prompt-status').textContent).toBe('Unsaved changes')
    await click('prompt-save')
    expect(saves()).toEqual([{ name: 'plan', scope: 'user', text: 'Plan carefully:\n{{task}}\n' }])
    expect(lastToast()?.message).toBe('Saved your Plan prompt. Projects without their own use it now.')
    expect(screen.getByTestId('prompt-source').textContent).toBe('Yours')
    expect(screen.getByTestId('prompt-status').textContent).toBe('Saved')
    expect(screen.getByTestId('prompt-explain').textContent).toBe(
      `Your template (${userPath('plan')}). Every project without a template of its own uses it.`,
    )
    await undo()
    expect(saves().at(-1)).toEqual({ name: 'plan', scope: 'user', text: null })
    expect(screen.getByTestId('prompt-source').textContent).toBe('Built-in')
  })

  it('Reset to the default removes your template, with Undo putting it back', async () => {
    user.review = 'My review:\n{{diff}}\n'
    await mount('#/settings/prompts/review')
    expect(screen.getByTestId('prompt-source').textContent).toBe('Yours')
    await click('prompt-reset')
    expect(saves()).toEqual([{ name: 'review', scope: 'user', text: null }])
    expect(lastToast()?.message).toBe('Removed your Review prompt. The built-in one is used again.')
    expect(editor().value).toBe(DEFAULTS.review)
    expect(screen.getByTestId<HTMLButtonElement>('prompt-reset').disabled).toBe(true)
    await undo()
    expect(saves().at(-1)).toEqual({ name: 'review', scope: 'user', text: 'My review:\n{{diff}}\n' })
    expect(editor().value).toBe('My review:\n{{diff}}\n')
  })

  it('Reset is unavailable, with the reason, while the scope has no template of its own', async () => {
    await mount()
    expect(screen.getByTestId<HTMLButtonElement>('prompt-reset').disabled).toBe(true)
    expect(screen.getByTestId('prompt-reset').closest('[data-disabled-hint]')?.textContent).toContain(
      'You have no Plan template of your own.',
    )
  })

  it('an unknown placeholder is refused with its line number, and nothing is saved', async () => {
    await mount()
    await edit('Plan this:\n\n{{tsk}}\n')
    await click('prompt-save')
    const issues = screen.getByTestId('prompt-issues')
    expect(issues.textContent).toContain(
      'Line 3, column 1: Unknown placeholder {{tsk}} in the plan template (did you mean {{task}}?). Allowed: task',
    )
    expect(user.plan).toBeUndefined()
    expect(screen.getByTestId('prompt-status').textContent).toBe('Unsaved changes')
    // Clicking the issue puts the cursor on its line.
    fireEvent.click(within(issues).getByRole('button'))
    expect(editor().selectionStart).toBe('Plan this:\n\n'.length)
    // Editing clears the issues.
    await edit('Plan this:\n\n{{task}}\n')
    expect(screen.queryByTestId('prompt-issues')).toBeNull()
  })

  it('a placeholder chip inserts its tag at the cursor', async () => {
    await mount('#/settings/prompts/fix')
    expect(screen.getByTestId('prompt-chip-findings').getAttribute('data-required')).toBe('true')
    expect(screen.getByTestId('prompt-required').textContent).toContain('Required: {{findings}}')
    await edit('Fix: \nthanks')
    act(() => {
      editor().focus()
      editor().setSelectionRange(5, 5)
    })
    fireEvent.click(screen.getByTestId('prompt-chip-diff'))
    await settle()
    expect(editor().value).toBe('Fix: {{diff}}\nthanks')
    expect(editor().selectionStart).toBe('Fix: {{diff}}'.length)
  })

  it('Implement shows its word count and warns over 200 words', async () => {
    await mount('#/settings/prompts/implement')
    const words = screen.getByTestId('prompt-words')
    expect(words.textContent).toBe('4 words (the built-in one stays under 200)')
    expect(words.hasAttribute('data-over')).toBe(false)
    await edit(`${'word '.repeat(201)}{{task}} {{plan}}`)
    expect(screen.getByTestId('prompt-words').textContent).toBe(
      '203 words: over 200. The built-in Implement prompt stays under 200 words so the task and the plan lead.',
    )
    expect(screen.getByTestId('prompt-words').getAttribute('data-over')).toBe('true')
    await tab('plan')
    expect(screen.queryByTestId('prompt-words')).toBeNull()
  })

  it('shows the changes from the built-in default', async () => {
    await mount()
    await click('prompt-diff-toggle')
    expect(screen.getByTestId('prompt-diff').textContent).toBe('Same as the built-in default.')
    expect(screen.getByTestId('prompt-diff-toggle').textContent).toBe('Hide changes from the default')
    await edit('Plan this task well:\n{{task}}\n')
    const diff = screen.getByTestId('prompt-diff')
    expect(diff.getAttribute('aria-label')).toBe('Changes from the built-in default: 1 added, 1 removed')
    expect(diff.querySelector('[data-kind="del"]')?.textContent).toContain('Plan this task:')
    expect(diff.querySelector('[data-kind="add"]')?.textContent).toContain('Plan this task well:')
  })

  it('keeps unsaved edits per tab', async () => {
    await mount()
    await edit('draft plan {{task}}')
    await tab('review')
    expect(editor().value).toBe(DEFAULTS.review)
    await tab('plan')
    expect(editor().value).toBe('draft plan {{task}}')
    await click('prompt-discard')
    expect(editor().value).toBe(DEFAULTS.plan)
  })

  it('core’s settings link (?field=/passes/<pass>/promptTemplate) opens that tab', async () => {
    await mount(`#/settings/prompts?field=${encodeURIComponent('/passes/fix/promptTemplate')}`)
    expect(mock.callsOf('prompts.get')).toEqual([{ name: 'fix' }])
    expect(screen.getByTestId('prompts-tab-fix').getAttribute('data-state')).toBe('active')
  })
})

describe('Settings → Prompts: override a prompt for one project', () => {
  it('One project asks for the project first, then edits its own template', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('prompts-scope-project'))
    await settle(LOAD_DELAY_MS)
    expect(editor().disabled).toBe(true)
    expect(screen.getByTestId('prompt-explain').textContent).toBe(
      'Choose the project whose Plan prompt you want to change.',
    )
    expect(screen.getByTestId('prompts-project-note').textContent).toContain(
      "Its template is saved in the project's .dimfactory/prompts folder, and only runs in that project use it.",
    )
    fireEvent.click(
      within(screen.getByTestId('prompts-folder-chips')).getByRole('button', {
        name: `Use folder ${PROJECT}`,
      }),
    )
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('prompts.get').at(-1)).toEqual({ name: 'plan', folder: PROJECT })
    expect(screen.getByTestId('prompt-explain').textContent).toBe(
      'app has no template of its own yet: it uses the built-in one. Save to give app its own; other projects keep theirs.',
    )
    expect(screen.getByTestId('prompt-save').textContent).toBe('Save for this project')
  })

  it('the deep link opens the project’s tab; Save writes the project’s template, used only there', async () => {
    user.implement = 'Mine:\n{{task}}\n{{plan}}\n'
    await mount(`#/settings/prompts/implement?folder=${encodeURIComponent(PROJECT)}`)
    expect(screen.getByTestId<HTMLInputElement>('prompts-scope-project').checked).toBe(true)
    expect(screen.getByTestId('prompts-folder-path').textContent).toBe(PROJECT)
    expect(mock.callsOf('prompts.get')).toEqual([{ name: 'implement', folder: PROJECT }])
    expect(screen.getByTestId('prompt-source').textContent).toBe('Yours')
    expect(screen.getByTestId('prompt-explain').textContent).toBe(
      `app has no template of its own yet: it uses yours (${userPath('implement')}). Save to give app its own copy; your template stays as it is.`,
    )
    await edit('Team:\n{{task}}\n{{plan}}\n')
    await click('prompt-save')
    expect(saves()).toEqual([
      { name: 'implement', scope: 'project', folder: PROJECT, text: 'Team:\n{{task}}\n{{plan}}\n' },
    ])
    expect(lastToast()?.message).toBe('Saved the Implement prompt for app. Runs there use it now.')
    expect(screen.getByTestId('prompt-source').textContent).toBe('This project')
    expect(screen.getByTestId('prompt-explain').textContent).toBe(
      `app's own template (${projectPath('implement')}). Runs in app use it instead of yours and the built-in one. Commit it to share it with your team.`,
    )
    // Yours is untouched; switching to "You" shows it.
    expect(user.implement).toBe('Mine:\n{{task}}\n{{plan}}\n')
    fireEvent.click(screen.getByTestId('prompts-scope-user'))
    await settle(LOAD_DELAY_MS)
    expect(editor().value).toBe('Mine:\n{{task}}\n{{plan}}\n')
    expect(screen.getByTestId('prompt-save').textContent).toBe('Save for you')
  })

  it('Undo of the project’s first template removes it; Reset there falls back to yours', async () => {
    user.review = 'Mine {{diff}}'
    await mount(`#/settings/prompts/review?folder=${encodeURIComponent(PROJECT)}`)
    await edit('Team {{diff}}')
    await click('prompt-save')
    await undo()
    expect(saves().at(-1)).toEqual({ name: 'review', scope: 'project', folder: PROJECT, text: null })
    expect(project.review).toBeUndefined()
    await edit('Team again {{diff}}')
    await click('prompt-save')
    await click('prompt-reset')
    expect(saves().at(-1)).toEqual({ name: 'review', scope: 'project', folder: PROJECT, text: null })
    expect(lastToast()?.message).toBe("Removed app's Review prompt. Runs there use your template now.")
    await undo()
    expect(saves().at(-1)).toEqual({
      name: 'review',
      scope: 'project',
      folder: PROJECT,
      text: 'Team again {{diff}}',
    })
  })

  it('a project chosen later keeps the tab, and nothing scrolls on its own', async () => {
    const scroll = vi.fn()
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown }
    const before = proto.scrollIntoView
    proto.scrollIntoView = scroll
    try {
      await mount('#/settings/prompts/critic')
      fireEvent.click(screen.getByTestId('prompts-scope-project'))
      await settle(LOAD_DELAY_MS)
      fireEvent.click(
        within(screen.getByTestId('prompts-folder-chips')).getByRole('button', {
          name: `Use folder ${PROJECT}`,
        }),
      )
      await settle(LOAD_DELAY_MS)
      expect(screen.getByTestId('prompts-tab-critic').getAttribute('data-state')).toBe('active')
      expect(mock.callsOf('prompts.get').at(-1)).toEqual({ name: 'critic', folder: PROJECT })
      expect(scroll).not.toHaveBeenCalled()
    } finally {
      proto.scrollIntoView = before
    }
  })
})

describe('Settings → Prompts: the optional steps', () => {
  it('lists every step template in a row of its own; each reads, saves and resets like a pass', async () => {
    await mount()
    const row = screen.getByTestId('prompts-step-tabs')
    expect(
      within(row)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([
      'Clarify',
      'Clarify (plain words)',
      'Research',
      'Acceptance review',
      'Explain',
      'Explain (plain words)',
      'Deploy',
      'Implement (Quick runs)',
    ])
    await tab('clarify-easy')
    expect(mock.callsOf('prompts.get').at(-1)).toEqual({ name: 'clarify-easy' })
    expect(editor().value).toBe(DEFAULTS['clarify-easy'])
    expect(screen.getByLabelText('Clarify (plain words) prompt')).toBe(editor())
    // Its own placeholders as chips.
    expect(screen.getByRole('group', { name: 'Placeholders' }).textContent).toContain('{{questions}}')
    await edit('Ask me at most {{questions}} things, simply:\n{{task}}\n')
    await click('prompt-save')
    expect(saves().at(-1)).toEqual({
      name: 'clarify-easy',
      scope: 'user',
      text: 'Ask me at most {{questions}} things, simply:\n{{task}}\n',
    })
    expect(lastToast()?.message).toBe(
      'Saved your Clarify (plain words) prompt. Projects without their own use it now.',
    )
    expect(screen.getByTestId('prompt-source').textContent).toBe('Yours')
    await click('prompt-reset')
    expect(saves().at(-1)).toEqual({ name: 'clarify-easy', scope: 'user', text: null })
    expect(screen.getByTestId('settings-prompts').textContent).not.toContain(EM_DASH)
  })

  it('a deep link opens a step template’s tab', async () => {
    await mount('#/settings/prompts/deploy')
    expect(mock.callsOf('prompts.get')).toEqual([{ name: 'deploy' }])
    expect(screen.getByTestId('prompts-tab-deploy').getAttribute('aria-selected')).toBe('true')
    expect(editor().value).toBe(DEFAULTS.deploy)
  })
})
