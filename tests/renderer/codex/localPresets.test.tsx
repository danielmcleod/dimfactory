// Settings → Vendors → Local models (the local preset: `local-<id>` runs on Codex as dim_factory_local,
// models from `GET {baseUrl}/models`, a context warning under 32k, readiness HTTP to loopback presets only;
// `local.presets` (user only); in Settings: add, a /models dropdown, the context warning, Test). Add, edit
// and remove write the user file with Undo; the address must be on this computer; Test never spends tokens and never
// takes "this core did not read the server" for a failure.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAllowedPresetUrl, isLoopbackHost as sharedLoopback, LocalPresetZ } from '@shared/config-schema.ts'
import type { ConfigReadResult } from '@shared/ipc.ts'
import type { LocalPreset, ModelOption, ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import {
  ADD_LABEL,
  NOT_CHECKED_HERE,
  testPreset,
} from '@renderer/pages/settings/vendors/LocalPresetsGroup.tsx'
import {
  contextWarning,
  envNameProblem,
  isLoopbackHost,
  MAX_PRESETS,
  parseContext,
  presetsOf,
  presetsOps,
  presetUrlProblem,
  slugId,
  tokensText,
  validateDraft,
} from '@renderer/pages/settings/vendors/localPresets.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { vcheck } from './fixtures.ts'

let mock: MockDimFactory
let userValue: Record<string, unknown>

const QWEN: LocalPreset = {
  id: 'qwen',
  label: 'Qwen on Ollama',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:14b',
}

const SERVER_MODELS: ModelOption[] = [
  { id: 'qwen2.5-coder:14b', source: 'local-server', contextWindow: 32768, hasPricing: true },
  { id: 'llama3.2:3b', source: 'local-server', contextWindow: 8192, hasPricing: true },
]

function readResult(value: unknown): ConfigReadResult {
  return {
    path: 'C:\\home\\dimfactory.json',
    exists: true,
    text: '{}',
    value,
    issues: [],
    version: 1,
    backups: [],
  }
}

beforeEach(() => {
  userValue = {}
  mock = setUp({
    handlers: {
      'config.read': () => readResult(userValue),
      'config.patch': (req) => {
        const op = req.ops[0]
        if (op?.op === 'replace' && op.path === '/local/presets')
          userValue = { ...userValue, local: { presets: op.value } }
        return { path: 'C:\\home\\dimfactory.json', changed: true, diff: '', backupId: 'b1' }
      },
      'config.restoreBackup': () => ({
        path: 'C:\\home\\dimfactory.json',
        changed: true,
        diff: '',
        backupId: null,
      }),
      'vendors.probe': () => {
        throw mockError('NOT_FOUND', 'Unknown vendor "local-qwen".')
      },
      'vendors.models': () => SERVER_MODELS,
    },
  })
  resetRecoveryForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

async function mount(): Promise<void> {
  render(
    <Providers>
      <SettingsPage section="vendors" />
    </Providers>,
  )
  await settle(SECTION_LOAD_DELAY_MS)
  await settle()
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle(SECTION_LOAD_DELAY_MS)
}

const field = (name: string): HTMLInputElement =>
  screen.getByTestId<HTMLInputElement>(`local-preset-field-${name}`)
const fieldError = (name: string): string =>
  screen.getByTestId(`local-preset-field-${name}-error`).textContent ?? ''
const type = (name: string, value: string): void => {
  fireEvent.change(field(name), { target: { value } })
}
const toasts = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('the address is on this computer', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080/v1',
    'https://localhost/v1',
  ])('accepts %s (and so does the config schema)', (url) => {
    expect(presetUrlProblem(url)).toBeNull()
    expect(isAllowedPresetUrl(url)).toBe(true)
  })

  it('refuses a name under .localhost (Windows resolves it through DNS), as the config schema does for http', () => {
    expect(presetUrlProblem('http://llm.localhost:8000')).toMatch(/^Use a server on this computer/)
    expect(isAllowedPresetUrl('http://llm.localhost:8000')).toBe(false)
    expect(sharedLoopback('llm.localhost')).toBe(false)
  })

  it.each([
    ['http://192.168.1.20:11434/v1', 'Use a server on this computer'],
    ['https://api.openai.com/v1', 'Use a server on this computer'],
    ['http://localhost.example.com/v1', 'Use a server on this computer'],
    ['http://user@localhost/v1', 'Enter an address that starts with http:// or https://'],
    ['ftp://localhost/v1', 'Enter an address that starts with http:// or https://'],
    ['localhost:11434', 'Enter an address that starts with http:// or https://'],
    ['', "Enter the server's address"],
  ])('refuses %s', (url, said) => {
    expect(presetUrlProblem(url)).toMatch(new RegExp(`^${said.replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('reads a loopback host the way the config schema does', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '[::1]',
      'a.localhost',
      'example.com',
      '10.0.0.1',
    ])
      expect(isLoopbackHost(host), host).toBe(sharedLoopback(host))
  })
})

describe('a draft becomes a preset the config accepts', () => {
  const draft = {
    label: ' Qwen on Ollama ',
    id: 'qwen',
    baseUrl: ' http://localhost:11434/v1 ',
    model: 'qwen2.5-coder:14b',
    apiKeyEnv: '',
    contextWindow: '32,768',
  }

  it('trims, drops empty optionals, and parses the context window', () => {
    const v = validateDraft(draft, new Set())
    expect(v).toEqual({ ok: true, preset: { ...QWEN, contextWindow: 32768 } })
    if (v.ok) expect(LocalPresetZ.safeParse(v.preset).success).toBe(true)
  })

  it('names the problem with each field', () => {
    const v = validateDraft(
      {
        label: '',
        id: 'Qwen!',
        baseUrl: 'http://10.0.0.2/v1',
        model: '',
        apiKeyEnv: 'PATH',
        contextWindow: '12k',
      },
      new Set(),
    )
    expect(v.ok).toBe(false)
    if (!v.ok)
      expect(v.errors).toEqual({
        label: 'Give it a name',
        id: 'Use lowercase letters, digits and dashes (at most 24), starting with a letter or digit',
        baseUrl:
          'Use a server on this computer: localhost, 127.0.0.1 or [::1]. Dim Factory sends nothing elsewhere.',
        model: 'Enter the model the server should run',
        apiKeyEnv: 'Dim Factory manages this variable; choose another name',
        contextWindow: 'Enter a whole number of tokens, or leave it empty',
      })
    const taken = validateDraft(draft, new Set(['qwen']))
    expect(taken.ok === false && taken.errors.id).toBe('Another local model already uses "qwen"')
  })

  it('makes ids from names, unique and within 24 characters', () => {
    expect(slugId('Qwen 2.5 Coder', new Set())).toBe('qwen-2-5-coder')
    expect(slugId('Qwen', new Set(['qwen']))).toBe('qwen-2')
    expect(slugId('!!!', new Set())).toBe('local')
    expect(slugId('A very long model name that keeps going', new Set())).toHaveLength(24)
    expect(envNameProblem('LOCAL_LLM_KEY')).toBeNull()
    expect(envNameProblem('1KEY')).toBe('Use letters, digits and _ only, not starting with a digit')
    expect(parseContext('')).toBeUndefined()
    expect(parseContext('8_192')).toBe(8192)
  })

  it('warns below 32k tokens of context, and writes token counts short', () => {
    expect(contextWarning(8192)).toBe(
      'Its context window (8,192 tokens) is under 32k: a plan or a diff may not fit.',
    )
    expect(contextWarning(32768)).toBeNull()
    expect(contextWarning(undefined)).toBeNull()
    expect(tokensText(32768)).toBe('32k')
    expect(tokensText(8000)).toBe('8,000')
  })

  it('reads presets from the user file and writes the whole list (and a removed preset’s settings)', () => {
    expect(presetsOf({ local: { presets: [QWEN, { id: 1 }, 'x'] } })).toEqual([QWEN])
    expect(presetsOf({})).toEqual([])
    expect(presetsOps([QWEN], 'old')).toEqual([
      { op: 'replace', path: '/local/presets', value: [QWEN] },
      { op: 'remove', path: '/vendors/local-old' },
    ])
  })
})

describe('Settings → Vendors → Local models', () => {
  it('adds a preset from the inline form, with the id following the name, and offers Undo', async () => {
    await mount()
    expect(screen.getByTestId('local-presets-empty').textContent).toBe('No local models yet.')
    await click(screen.getByTestId('local-preset-add'))
    expect(screen.getByRole('form', { name: ADD_LABEL })).toBeTruthy()
    type('label', 'Qwen on Ollama')
    expect(field('id').value).toBe('qwen-on-ollama')
    type('id', 'qwen')
    type('label', 'Qwen (Ollama)')
    // Edited by hand: the id stays.
    expect(field('id').value).toBe('qwen')
    type('baseUrl', 'http://192.168.1.20:11434/v1')
    await click(screen.getByTestId('local-preset-save'))
    expect(fieldError('baseUrl')).toBe(
      'Use a server on this computer: localhost, 127.0.0.1 or [::1]. Dim Factory sends nothing elsewhere.',
    )
    expect(fieldError('model')).toBe('Enter the model the server should run')
    expect(mock.callsOf('config.patch')).toEqual([])
    type('baseUrl', 'http://localhost:11434/v1')
    expect(fieldError('baseUrl')).toBe('')
    type('model', 'qwen2.5-coder:14b')
    type('contextWindow', '8192')
    expect(screen.getByTestId('local-preset-form-context-warning').textContent).toContain('under 32k')
    await click(screen.getByTestId('local-preset-save'))
    expect(mock.callsOf('config.patch')).toEqual([
      {
        scope: 'user',
        ops: [
          {
            op: 'replace',
            path: '/local/presets',
            value: [{ ...QWEN, label: 'Qwen (Ollama)', contextWindow: 8192 }],
          },
        ],
      },
    ])
    expect(screen.queryByTestId('local-preset-form')).toBeNull()
    expect(toasts()).toContain('Added Qwen (Ollama)')
    const row = screen.getByTestId('local-preset-qwen')
    expect(row.textContent).toContain('local-qwen')
    expect(screen.getByTestId('local-preset-qwen-context').textContent).toBe('8k tokens')
    expect(screen.getByTestId('local-preset-qwen-context-warning').textContent).toContain('under 32k')
    await click(screen.getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'b1' }])
  })

  it('edits a preset in place (its id cannot change) and removes one with its own settings', async () => {
    userValue = {
      local: { presets: [QWEN, { ...QWEN, id: 'llama', label: 'Llama', model: 'llama3.2:3b' }] },
      vendors: { 'local-llama': { defaultModel: 'llama3.2:3b' } },
    }
    await mount()
    await click(screen.getByTestId('local-preset-qwen-edit'))
    expect(field('id').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('local-preset-qwen-edit').disabled).toBe(true)
    type('model', 'qwen2.5-coder:32b')
    await click(screen.getByTestId('local-preset-save'))
    expect(mock.callsOf('config.patch').at(-1)?.ops).toEqual([
      {
        op: 'replace',
        path: '/local/presets',
        value: [
          { ...QWEN, model: 'qwen2.5-coder:32b' },
          { ...QWEN, id: 'llama', label: 'Llama', model: 'llama3.2:3b' },
        ],
      },
    ])
    expect(toasts()).toContain('Saved Qwen on Ollama')
    await click(screen.getByTestId('local-preset-llama-remove'))
    expect(mock.callsOf('config.patch').at(-1)?.ops).toEqual([
      { op: 'replace', path: '/local/presets', value: [{ ...QWEN, model: 'qwen2.5-coder:32b' }] },
      { op: 'remove', path: '/vendors/local-llama' },
    ])
    expect(toasts()).toContain('Removed Llama')
  })

  it('lists the server’s models when the model list is opened, and saves the one chosen', async () => {
    userValue = { local: { presets: [QWEN] } }
    await mount()
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('local-preset-qwen-model'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'local-qwen', force: true }])
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'qwen2.5-coder:14b · 32k context',
      'llama3.2:3b · 8k context',
    ])
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'llama3.2:3b · 8k context' }), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.patch').at(-1)?.ops).toEqual([
      { op: 'replace', path: '/local/presets', value: [{ ...QWEN, model: 'llama3.2:3b' }] },
    ])
    expect(toasts()).toContain('Qwen on Ollama runs llama3.2:3b')
  })

  it('Test reads the server’s models (no tokens) and says what it found', async () => {
    userValue = { local: { presets: [QWEN] } }
    await mount()
    await click(screen.getByTestId('local-preset-qwen-test'))
    const status = screen.getByTestId('local-preset-qwen-status')
    expect(status.textContent).toBe('Server answered · 2 models')
    expect(status.getAttribute('data-result')).toBe('ok')
    // The server's own context window for the preset's model.
    expect(screen.getByTestId('local-preset-qwen-context').textContent).toBe("32k tokens (the server's)")
  })

  it('caps the list at 20', async () => {
    userValue = {
      local: {
        presets: Array.from({ length: MAX_PRESETS }, (_, i) => ({ ...QWEN, id: `m${i}`, label: `M${i}` })),
      },
    }
    await mount()
    expect(screen.getByTestId<HTMLButtonElement>('local-preset-add').disabled).toBe(true)
    expect(screen.getByRole('group', { name: `${ADD_LABEL} At most 20 local models` })).toBeTruthy()
  })
})

describe('Test', () => {
  it('uses core’s probe of the preset when core has one: its checks and its failing title', async () => {
    const view = {
      vendor: 'local-qwen',
      displayName: 'Qwen on Ollama',
      healthDetail: 'Ready',
      probe: {
        vendor: 'local-qwen',
        at: 0,
        ok: false,
        checks: [
          vcheck('local-server', { id: 'pass.implement.readiness.local-server', title: 'Server answered' }),
          vcheck('local-responses', {
            id: 'pass.implement.readiness.local-responses',
            status: 'fail',
            title: 'The server has no Responses API (/v1/responses)',
          }),
        ],
        capabilities: {} as never,
        models: [{ id: 'qwen2.5-coder:14b', source: 'local-server' }],
      },
    } as unknown as ProbeView
    mock.on('vendors.probe', () => [view])
    const r = await testPreset(QWEN)
    expect(r.status).toBe('failed')
    expect(r.line).toBe('The server has no Responses API (/v1/responses)')
    expect(r.checks).toHaveLength(2)
    expect(mock.callsOf('vendors.models')).toEqual([])
  })

  it('a server that does not list the preset’s model fails; one that lists nothing asks if it runs', async () => {
    mock.on('vendors.models', () => [SERVER_MODELS[1] as ModelOption])
    expect(await testPreset(QWEN)).toMatchObject({
      status: 'failed',
      line: 'The server does not list qwen2.5-coder:14b',
    })
    mock.on('vendors.models', () => [])
    expect(await testPreset(QWEN)).toMatchObject({
      status: 'failed',
      line: "Could not list the server's models. Is it running at http://localhost:11434/v1?",
    })
    mock.on('vendors.models', () => {
      throw mockError('INTERNAL', 'connect ECONNREFUSED 127.0.0.1:11434')
    })
    expect(await testPreset(QWEN)).toMatchObject({
      status: 'failed',
      line: 'Could not reach the server: connect ECONNREFUSED 127.0.0.1:11434',
    })
  })

  it('a core that answers with Codex’s own models has not read the server: that is said, not a failure', async () => {
    mock.on('vendors.models', () => [{ id: 'gpt-5.1-codex', source: 'cli', hasPricing: true }])
    expect(await testPreset(QWEN)).toEqual({
      status: 'unknown',
      line: NOT_CHECKED_HERE,
      checks: [],
      models: [],
    })
    mock.on('vendors.models', () => {
      throw mockError('NOT_FOUND', 'Unknown vendor "local-qwen".')
    })
    expect((await testPreset(QWEN)).status).toBe('unknown')
  })
})
