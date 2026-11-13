// Snag recovery buttons carry finished text: every `{{vendor}}` placeholder is filled with the vendor's display
// name (found in a live check, where the login hint read "{{vendor}} needs you to log in").
import { describe, expect, it } from 'vitest'
import { FAILURE_CATEGORIES } from '../../../src/shared/failure.ts'
import { defaultRecoveryActions } from '../../../src/core/supervisor/effects.ts'

describe('defaultRecoveryActions text', () => {
  const actions = defaultRecoveryActions(() => 'claude', 'win32')

  it('fills the vendor name into the login reason', () => {
    const a = actions(
      'plan',
      { category: 'auth_expired', message: 'OAuth session expired', raw: '', classifiedBy: 'regex' },
      { hasSession: false, hints: [] },
    )
    const login = a.find((x) => x.id === 'plan:login')
    expect(login?.kind).toBe('shell_copy')
    expect(login?.kind === 'shell_copy' && login.reason).toBe(
      'Sign in to Claude in a terminal, then re-check.',
    )
  })

  it('never leaves a placeholder in any label or reason, for every category', () => {
    for (const category of FAILURE_CATEGORIES) {
      const a = actions(
        'implement',
        { category, message: 'x', raw: '', classifiedBy: 'app' },
        { hasSession: true, hints: ['claude-env-key'] },
      )
      for (const action of a) {
        expect(JSON.stringify(action), `${category} ${action.id}`).not.toMatch(/\{\{\w+\}\}/)
      }
    }
  })
})
