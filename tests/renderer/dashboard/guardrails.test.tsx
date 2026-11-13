// Settings → Guardrails: what each rule cannot stop is always on screen, rules write to your own file, and Test this rule
// answers from the same code as the real checks.
import '../helpers/rtl.ts'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GuardrailsState, Guardrails } from '@shared/guardrails.ts'
import { GUARDRAIL_INFO } from '@shared/guardrails.ts'
import { GuardrailsSection, NOT_A_BOUNDARY } from '@renderer/pages/settings/GuardrailsSection.tsx'
import { guardrailsText } from '@renderer/components/run/RunEndPanel.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory
let guardrails: Guardrails
let state: GuardrailsState

const AT = Date.UTC(2026, 10, 5, 12)

beforeEach(() => {
  guardrails = { preset: 'recommended', rules: [] }
  state = { proofs: [], version: '2.1.289', loosened: [] }
  mock = setUp({
    handlers: {
      'config.resolve': () => ({ config: { guardrails } }) as never,
      'guardrails.state': () => state,
      'guardrails.prove': (req) => {
        const proof = {
          kind: req.kind,
          vendor: 'claude',
          result: 'held' as const,
          at: AT,
          version: '2.1.289',
          model: 'haiku',
          detail: 'Claude tried, and the guardrail refused it.',
        }
        state = { ...state, proofs: [proof] }
        return proof
      },
      'config.patch': (req) => {
        for (const op of req.ops) {
          if (op.path === '/guardrails/rules')
            guardrails = { ...guardrails, rules: (op as { value: unknown }).value as Guardrails['rules'] }
        }
        return { backupId: null } as never
      },
    },
  })
})

afterEach(() => {
  cleanup()
  tearDown(mock)
})

async function open(): Promise<void> {
  render(
    <Providers>
      <GuardrailsSection />
    </Providers>,
  )
  await settle(200)
}

describe('Settings › Guardrails', () => {
  it('says plainly what guardrails are not, and what each preset rule cannot stop', async () => {
    await open()
    expect(screen.getByText(NOT_A_BOUNDARY)).toBeTruthy()
    expect(screen.getByText(/Forbidden commands: git push, npm publish/)).toBeTruthy()
    expect(
      screen.getAllByText(`Cannot stop: ${GUARDRAIL_INFO.forbiddenCommand.limit}`).length,
    ).toBeGreaterThan(0)
    expect(screen.getByText(/CLAUDE\.md and AGENTS\.md stay editable/)).toBeTruthy()
  })

  it('adds a protected-files rule to your own file', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Files to protect'), {
      target: { value: 'migrations/**, .github/**' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0] as HTMLElement)
    await settle()
    const call = mock.callsOf('config.patch')[0]
    expect(call).toMatchObject({
      scope: 'user',
      ops: [
        {
          path: '/guardrails/rules',
          value: [{ kind: 'protectedFiles', paths: ['migrations/**', '.github/**'] }],
        },
      ],
    })
  })

  it('tests a command and a path, for free', async () => {
    await open()
    const box = screen.getByLabelText('Path or command to test')
    fireEvent.change(box, { target: { value: 'git push origin main' } })
    expect(screen.getByTestId('guardrail-test-hit').textContent).toMatch(/git push/)
    fireEvent.change(box, { target: { value: '.claude/settings.json' } })
    expect(screen.getByTestId('guardrail-test-hit').textContent).toMatch(/Settings files/)
    fireEvent.change(box, { target: { value: 'src/a.ts' } })
    expect(screen.getByTestId('guardrail-test-none')).toBeTruthy()
  })
})

describe('the new rules, Prove it and loosening', () => {
  it('adds a private files rule and the one-click rules, and will not add one twice', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Files to keep private'), {
      target: { value: '.env*, secrets/**' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1] as HTMLElement)
    await settle(200)
    expect(mock.callsOf('config.patch')[0]).toMatchObject({
      ops: [{ path: '/guardrails/rules', value: [{ kind: 'privateFiles', paths: ['.env*', 'secrets/**'] }] }],
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[3] as HTMLElement)
    await settle(200)
    expect(guardrails.rules.map((r) => r.kind)).toEqual(['privateFiles', 'network'])
    expect((screen.getAllByRole('button', { name: 'Add' })[3] as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(`Cannot stop: ${GUARDRAIL_INFO.network.limit}`)).toBeTruthy()
  })

  it('tests a private path for free and says where it holds', async () => {
    guardrails = { preset: 'off', rules: [{ kind: 'privateFiles', paths: ['.env*'] }] }
    await open()
    fireEvent.change(screen.getByLabelText('Path or command to test'), { target: { value: '.env.local' } })
    expect(screen.getByTestId('guardrail-test-hit').textContent).toMatch(
      /Refused on Claude\. Other AI tools cannot keep this rule\./,
    )
  })

  it('proves a rule on a click and shows the result with its date and version', async () => {
    await open()
    const row = screen.getByTestId('guardrail-prove')
    expect(row.textContent).toContain('Not proven yet.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Prove it' })[0] as HTMLElement)
    await settle()
    // The proof is in; the section reads the record again.
    await settle(300)
    expect(mock.callsOf('guardrails.prove')).toEqual([{ kind: 'protectedFiles' }])
    expect(screen.getByTestId('guardrail-prove').textContent).toMatch(/Held on .*2026, Claude 2\.1\.289\./)
  })

  it('asks for a re-test after a Claude update', async () => {
    state = {
      version: '2.1.300',
      loosened: [],
      proofs: [
        {
          kind: 'privateFiles',
          vendor: 'claude',
          result: 'held',
          at: AT,
          version: '2.1.289',
          model: 'haiku',
          detail: 'x',
        },
      ],
    }
    await open()
    expect(screen.getByTestId('guardrail-prove').textContent).toMatch(
      /Needs a re-test: held on .*2026, Claude 2\.1\.289, and Claude is 2\.1\.300 now\./,
    )
  })

  it('says when your guardrails were last loosened', async () => {
    state = { ...state, loosened: [{ at: AT, what: 'Preset lowered from Strict to Off' }] }
    await open()
    expect(screen.getByTestId('guardrail-loosened').textContent).toMatch(
      /^Loosened on .*2026: Preset lowered from Strict to Off\.$/,
    )
  })
})

describe('the run end line', () => {
  it('says what fired', () => {
    expect(guardrailsText({ rules: 5, fired: 0, undone: 0, stopped: false })).toBe(
      'Guardrails: 5 rules in force, none fired.',
    )
    expect(guardrailsText({ rules: 1, fired: 2, undone: 1, stopped: true })).toBe(
      'Guardrails: 1 rule in force, 2 fired, 1 change put back, the run was stopped.',
    )
  })
})
