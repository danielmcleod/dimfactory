// The CLI host's side of recovery actions (src/cli/hints.ts): `dimf preflight` and a blocked
// `dimf run` print what the app's buttons do — a shell_copy's command to run, an open_docs action's link.
import { describe, expect, it } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import { recoveryHint, recoveryLine } from '../../../src/cli/hints.ts'

const docs: RecoveryAction = {
  id: 'claude.docs',
  label: 'Open the setup guide',
  kind: 'open_docs',
  url: 'https://code.claude.com/docs/en/setup',
}
const login: RecoveryAction = {
  id: 'claude.login',
  label: 'Copy the login command',
  kind: 'shell_copy',
  command: 'claude auth login',
  shell: 'powershell',
  reason: 'Claude Code is not logged in',
  recheck: 'vendor.claude.auth',
}

describe('CLI recovery hints', () => {
  it('prints the shell command and the documentation link, with or without a hint context', () => {
    expect(recoveryHint(docs, { cli: 'dimf' })).toBe('https://code.claude.com/docs/en/setup')
    expect(recoveryLine(docs, undefined)).toBe(
      '-> Open the setup guide: https://code.claude.com/docs/en/setup',
    )
    expect(recoveryLine(login, { cli: 'dimf' })).toBe('-> Copy the login command: claude auth login')
    expect(recoveryLine(login, undefined)).toBe('-> Copy the login command: claude auth login')
  })

  it('run-level actions have no terminal form', () => {
    expect(recoveryLine({ id: 'run:close', label: 'Close run', kind: 'close_run' }, { cli: 'dimf' })).toBe(
      '-> Close run',
    )
  })
})
