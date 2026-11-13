// Settings → Isolation & Verify, the Verify half (defaults, and commands with their trust
// state; commands and trust; the `verify` keys, "Save" with an undo toast, trust.json).
// Core's resolved values; every control writes one config.patch (to the chosen project, or your settings without one)
// with Undo; the commands are a project's (configured + detected) with their trust state (Trusted / Not trusted /
// Changed since you trusted it, with what changed); Trust and Untrust write trust.json with the hash core showed (and
// Undo); a custom command is split as core splits it and shell syntax is refused with core's words, writing nothing.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides, VerifyCommandConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { VerifyCommand } from '@shared/verify.ts'
import {
  NO_PROJECT,
  READING_COMMANDS,
  VERIFY_ENABLED_LABEL,
} from '@renderer/pages/settings/IsolationSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { shellSyntaxMessage } from '@renderer/pages/settings/verify/argv.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER } from '../composer/fixtures.tsx'
import { detected } from './fixtures.ts'

let mock: MockDimFactory
let commands: VerifyCommandConfig[]
let found: VerifyCommand[]

const CONFIGURED: VerifyCommandConfig[] = [
  { name: 'typecheck', run: ['pnpm', 'run', 'typecheck'] },
  { name: 'lint', run: 'pnpm run lint', enabled: false },
]

function resolveVerify() {
  const base = fakeResolve()
  return (req: { folder?: string; overrides?: RunOverrides }) => {
    const r = base(req)
    r.config.verify = {
      enabled: false,
      commands: [...commands],
      runAfter: ['implement', 'fix'],
      failFast: false,
      baseline: false,
    }
    r.provenance['/verify/enabled'] = { source: 'default' }
    return r
  }
}

beforeEach(() => {
  commands = CONFIGURED.map((c) => ({ ...c }))
  found = [
    detected({
      name: 'typecheck',
      source: 'config',
      configured: true,
      trust: 'trusted',
      trusted: true,
      hash: '1'.repeat(64),
    }),
    detected({
      name: 'lint',
      source: 'config',
      configured: true,
      argv: ['pnpm', 'run', 'lint'],
      hash: '2'.repeat(64),
    }),
    detected({ name: 'test', hash: '3'.repeat(64) }),
    detected({
      name: 'build',
      kind: 'build',
      enabledByDefault: false,
      trust: 'changed',
      body: 'tsc -b && vite build',
      grantedBody: 'tsc -b',
      hash: '4'.repeat(64),
    }),
  ]
  mock = setUp({
    handlers: {
      'config.resolve': resolveVerify(),
      'verify.detect': () => found,
      'folders.recent': () => [],
      'config.patch': () => ({
        path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
        changed: true,
        diff: '',
        backupId: 'b1',
      }),
      'config.restoreBackup': () => ({ path: '', changed: true, diff: '', backupId: null }),
      'trust.set': (req) => ({ folder: req.folder, folderKey: 'k', scopeRoot: req.folder, grants: {} }),
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(folder: string | null = FOLDER): Promise<HTMLElement> {
  window.location.hash =
    folder !== null ? `#/settings/isolation?folder=${encodeURIComponent(folder)}` : '#/settings/isolation'
  render(
    <Providers>
      <SettingsPage section="isolation" />
    </Providers>,
  )
  await settle(SECTION_LOAD_DELAY_MS)
  await settle()
  return screen.getByTestId('settings-content')
}

const lastPatch = (): { scope: string; folder?: string; ops: JsonPatchOp[] } | undefined =>
  mock.callsOf('config.patch').at(-1)
const listOf = (): VerifyCommandConfig[] => {
  const op = lastPatch()?.ops[0]
  expect(op?.op).toBe('replace')
  expect(op?.path).toBe('/verify/commands')
  return (op as { value: VerifyCommandConfig[] }).value
}
const lastToast = () => useStore.getState().toasts.items.at(-1)
const rowOf = (name: string): HTMLElement => screen.getByTestId(`verify-row-${name}`)

async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el)
  await settle()
}

describe('the verify defaults', () => {
  it('writes verify on, when to verify and fail fast to the project, each with Undo', async () => {
    await mount()
    expect(screen.getByTestId('verify-scope').textContent).toBe("Saved to repo's dimfactory.json.")
    const on = screen.getByRole('switch', { name: VERIFY_ENABLED_LABEL })
    expect(on.getAttribute('aria-checked')).toBe('false')
    await click(on)
    expect(lastPatch()).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/verify/enabled', value: true }],
    })
    // Shown at once, until core's next answer.
    expect(on.getAttribute('aria-checked')).toBe('true')
    expect(lastToast()?.message).toBe('Verify is on')
    await act(async () => {
      const action = lastToast()?.action
      if (action !== undefined && 'onClick' in action) await action.onClick()
    })
    expect(mock.callsOf('config.restoreBackup')).toEqual([
      { scope: 'project', folder: FOLDER, backupId: 'b1' },
    ])

    await click(screen.getByTestId('verify-after-fix'))
    expect(lastPatch()?.ops).toEqual([{ op: 'replace', path: '/verify/runAfter', value: ['implement'] }])
    expect(lastToast()?.message).toBe('Verify runs after Implement')

    await click(screen.getByTestId('verify-setting-failfast'))
    expect(lastPatch()?.ops).toEqual([{ op: 'replace', path: '/verify/failFast', value: true }])
  })

  it('without a project, writes your settings and lists no commands', async () => {
    const content = await mount(null)
    expect(screen.getByTestId('verify-scope').textContent).toBe('Saved to your settings, for every project.')
    expect(screen.getByTestId('verify-commands-empty').textContent).toBe(NO_PROJECT)
    expect(mock.callsOf('verify.detect')).toEqual([])
    expect(within(content).getByTestId<HTMLButtonElement>('verify-add-open').disabled).toBe(true)
    await click(screen.getByTestId('verify-setting-enabled'))
    expect(lastPatch()).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/verify/enabled', value: true }],
    })
  })

  it('shows a write core refused as its message, and puts the value back', async () => {
    mock.on('config.patch', () => {
      throw mockError('VALIDATION', 'verify.runAfter: Invalid option')
    })
    await mount()
    const fix = screen.getByTestId('verify-after-fix')
    await click(fix)
    expect(lastToast()?.message).toBe('verify.runAfter: Invalid option')
    expect(fix.getAttribute('aria-checked')).toBe('true')
  })
})

describe('the commands', () => {
  it('lists configured and detected commands with their trust state, and what changed in a changed script', async () => {
    await mount()
    expect(mock.callsOf('verify.detect')).toEqual([{ folder: FOLDER }])
    const names = [
      ...screen.getByTestId('verify-commands-table').querySelectorAll('tbody tr[data-trust]'),
    ].map((r) => r.getAttribute('data-testid'))
    expect(names).toEqual(['verify-row-typecheck', 'verify-row-lint', 'verify-row-test', 'verify-row-build'])
    expect(screen.getByTestId('verify-row-typecheck-trust').textContent).toBe('Trusted')
    expect(screen.getByTestId('verify-row-lint-trust').textContent).toBe('Not trusted')
    expect(screen.getByTestId('verify-row-build-trust').textContent).toBe('Changed since you trusted it')
    const diff = screen.getByTestId('verify-row-build-diff')
    expect([...diff.querySelectorAll('[data-op]')].map((l) => l.getAttribute('data-op'))).toEqual([
      'del',
      'add',
    ])
    expect(diff.textContent).toContain('tsc -b && vite build')
    // On: configured and not turned off.
    const on = (n: string) => screen.getByTestId(`verify-row-${n}-enabled`).getAttribute('aria-checked')
    expect([on('typecheck'), on('lint'), on('test'), on('build')]).toEqual([
      'true',
      'false',
      'false',
      'false',
    ])
    expect(rowOf('lint').textContent).toContain('pnpm run lint')
    expect(rowOf('test').textContent).toContain('package.json script')
  })

  it('turns a detected command on (added to the list), a configured one off and back, and removes one', async () => {
    // Core takes each list (the next config.resolve answers it) and announces the change.
    mock.on('config.patch', (req) => {
      const op = req.ops[0]
      if (op?.op === 'replace' && op.path === '/verify/commands') commands = op.value as VerifyCommandConfig[]
      return { path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json', changed: true, diff: '', backupId: 'b1' }
    })
    const TEST = { name: 'test', run: ['pnpm', 'run', 'test'] }
    await mount()
    await click(screen.getByTestId('verify-row-test-enabled'))
    expect(listOf()).toEqual([...CONFIGURED, TEST])
    expect(lastPatch()?.scope).toBe('project')
    expect(lastToast()?.message).toBe('test runs in verify')
    // Shown at once: the row is on and now removable, before core's next answer.
    expect(screen.getByTestId('verify-row-test-enabled').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('verify-row-test-remove')).toBeTruthy()
    await settle(SECTION_LOAD_DELAY_MS)

    await click(screen.getByTestId('verify-row-typecheck-enabled'))
    expect(listOf()).toEqual([{ ...CONFIGURED[0], enabled: false }, CONFIGURED[1], TEST])
    expect(screen.getByTestId('verify-row-typecheck-enabled').getAttribute('aria-checked')).toBe('false')
    await settle(SECTION_LOAD_DELAY_MS)

    await click(screen.getByTestId('verify-row-lint-enabled'))
    expect(listOf()).toEqual([
      { ...CONFIGURED[0], enabled: false },
      { name: 'lint', run: 'pnpm run lint' },
      TEST,
    ])
    await settle(SECTION_LOAD_DELAY_MS)

    await click(screen.getByTestId('verify-row-lint-remove'))
    expect(listOf()).toEqual([{ ...CONFIGURED[0], enabled: false }, TEST])
    expect(screen.queryByTestId('verify-row-lint-remove')).toBeNull()
  })

  it('puts the list back when core refuses it', async () => {
    mock.on('config.patch', () => {
      throw mockError('VALIDATION', 'verify.commands.2.name: Too long')
    })
    await mount()
    await click(screen.getByTestId('verify-row-test-enabled'))
    expect(lastToast()?.message).toBe('verify.commands.2.name: Too long')
    expect(screen.getByTestId('verify-row-test-enabled').getAttribute('aria-checked')).toBe('false')
  })

  it('adds the detected commands discovery suggests at once', async () => {
    await mount()
    await click(screen.getByTestId('verify-use-suggested'))
    expect(listOf()).toEqual([...CONFIGURED, { name: 'test', run: ['pnpm', 'run', 'test'] }])
    expect(lastToast()?.message).toBe('Added 1 detected command')
  })

  it('trusts a command with the hash core showed, untrusts one, and offers Undo', async () => {
    await mount()
    const trust = screen.getByTestId('verify-row-test-trust-button')
    expect(trust.textContent).toBe('Trust')
    await click(trust)
    const grant = (argv: string[], hash: string) => ({
      kind: 'command',
      command: { kind: 'verify', argv, cwdRel: '.', hash },
    })
    expect(mock.callsOf('trust.set')).toEqual([
      { folder: FOLDER, grant: grant(['pnpm', 'run', 'test'], '3'.repeat(64)), trusted: true },
    ])
    expect(lastToast()?.message).toBe('Trusted test for this project')
    await act(async () => {
      const action = lastToast()?.action
      if (action !== undefined && 'onClick' in action) await action.onClick()
    })
    expect(mock.callsOf('trust.set').at(-1)).toEqual({
      folder: FOLDER,
      grant: grant(['pnpm', 'run', 'test'], '3'.repeat(64)),
      trusted: false,
    })

    const untrust = screen.getByTestId('verify-row-typecheck-trust-button')
    expect(untrust.textContent).toBe('Untrust')
    await click(untrust)
    expect(mock.callsOf('trust.set').at(-1)).toEqual({
      folder: FOLDER,
      grant: grant(
        ['pnpm', 'run', 'test'].map((a) => (a === 'test' ? 'typecheck' : a)),
        '1'.repeat(64),
      ),
      trusted: false,
    })
    expect(lastToast()?.message).toBe('typecheck is no longer trusted')
    // Detection is read again after each trust change.
    expect(mock.callsOf('verify.detect').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps one width for Trust and Untrust', async () => {
    await mount()
    for (const n of ['test', 'typecheck']) {
      const b = screen.getByTestId(`verify-row-${n}-trust-button`)
      const reserved = [...b.querySelectorAll('[data-label]')].map((e) => e.getAttribute('data-label'))
      expect(reserved.sort()).toEqual(['Trust', 'Untrust'])
    }
  })

  it('shows core’s refusal of a grant (the script changed since it was shown)', async () => {
    mock.on('trust.set', () => {
      throw mockError('CONFLICT', 'The script of test changed since Dim Factory showed it. Check it again.')
    })
    await mount()
    await click(screen.getByTestId('verify-row-test-trust-button'))
    expect(lastToast()?.level).toBe('error')
    expect(lastToast()?.message).toBe(
      'The script of test changed since Dim Factory showed it. Check it again.',
    )
  })
})

describe('adding a command of your own', () => {
  async function open(): Promise<void> {
    await mount()
    await click(screen.getByTestId('verify-add-open'))
  }
  const type = (id: string, value: string): void => {
    fireEvent.change(screen.getByTestId(id), { target: { value } })
  }

  it('refuses shell syntax with core’s words and writes nothing', async () => {
    await open()
    type('verify-add-name', 'smoke')
    type('verify-add-line', 'pnpm test && rm -rf /')
    expect(screen.getByTestId('verify-add-line-error').textContent).toBe(shellSyntaxMessage('&'))
    await click(screen.getByTestId('verify-add-save'))
    expect(mock.callsOf('config.patch')).toEqual([])
    for (const [line, what] of [
      ['pnpm test | tee out.txt', '|'],
      ['echo %PATH%', '%PATH%'],
      ['node -e $(whoami)', '$'],
      ['pnpm test; rm -rf /', ';'],
      ['(pnpm test)', '('],
      ['node "`whoami`"', '`'],
    ] as const) {
      type('verify-add-line', line)
      expect(screen.getByTestId('verify-add-line-error').textContent, line).toBe(shellSyntaxMessage(what))
    }
  })

  it('adds a valid command as argv, quote-aware, in a folder of the project', async () => {
    await open()
    type('verify-add-name', 'smoke')
    type('verify-add-line', 'node "scripts/my smoke.mjs" --fast')
    type('verify-add-folder', 'packages\\cli')
    expect(screen.getByTestId('verify-add-line-error').textContent).toBe('')
    await click(screen.getByTestId('verify-add-save'))
    expect(listOf()).toEqual([
      ...CONFIGURED,
      { name: 'smoke', run: ['node', 'scripts/my smoke.mjs', '--fast'], cwd: 'packages/cli' },
    ])
    expect(lastToast()?.message).toBe('Added smoke')
    expect(screen.queryByTestId('verify-add')).toBeNull()
  })

  it('needs a new name and a folder inside the project', async () => {
    await open()
    type('verify-add-name', 'lint')
    type('verify-add-line', 'pnpm lint')
    type('verify-add-folder', '..\\other')
    expect(screen.getByTestId('verify-add-name-error').textContent).toBe(
      'There is already a command named lint.',
    )
    expect(screen.getByTestId('verify-add-folder-error').textContent).toBe(
      'Use a folder inside the project, relative to it.',
    )
    await click(screen.getByTestId('verify-add-save'))
    expect(mock.callsOf('config.patch')).toEqual([])
  })
})

// Review fixes.
describe('async answers never shift the list; cwd is written as core reads it', () => {
  it('keeps the one "Looking for commands…" line until verify.detect answers, then shows the rows once', async () => {
    let release: (v: VerifyCommand[]) => void = () => undefined
    mock.on('verify.detect', () => new Promise<VerifyCommand[]>((r) => (release = r)))
    await mount()
    // config.resolve has answered (the defaults show); the commands wait for discovery.
    expect(screen.getByTestId('verify-setting-enabled')).toBeTruthy()
    const table = screen.getByTestId('verify-commands-table')
    expect(table.querySelectorAll('tbody tr[data-trust]')).toHaveLength(0)
    expect(table.textContent).toContain(READING_COMMANDS)
    await act(async () => {
      release(found)
      await Promise.resolve()
    })
    await settle()
    const rows = [...table.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'))
    // The changed command's diff row is there with its row from the first frame the rows show.
    expect(rows).toEqual([
      'verify-row-typecheck',
      'verify-row-lint',
      'verify-row-test',
      'verify-row-build',
      'verify-row-build-changed',
    ])
    expect(screen.getByTestId('verify-row-typecheck-trust').textContent).toBe('Trusted')
  })

  it('a project below the repository root: a detected command is added with cwd relative to the project', async () => {
    // Discovery in repo/packages/app: cwdRel is relative to the repository (trust.json's); cwd to the project.
    found = [
      detected({ name: 'test', cwdRel: 'packages/app', cwd: '.', hash: '3'.repeat(64) }),
      detected({ name: 'e2e', cwdRel: 'packages/app/e2e', cwd: 'e2e', hash: '5'.repeat(64) }),
    ]
    commands = []
    await mount()
    expect(rowOf('test').textContent).toContain('Project folder')
    await click(screen.getByTestId('verify-row-test-enabled'))
    expect(listOf()).toEqual([{ name: 'test', run: ['pnpm', 'run', 'test'] }])
    await settle(SECTION_LOAD_DELAY_MS)
    await click(screen.getByTestId('verify-use-suggested'))
    expect(listOf()).toEqual([
      { name: 'test', run: ['pnpm', 'run', 'test'] },
      { name: 'e2e', run: ['pnpm', 'run', 'e2e'], cwd: 'e2e' },
    ])
  })
})
