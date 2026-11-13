// The composer's folder line: chips from core's folders.recent,
// the scope-root note from config.resolve, and the non-git banner whose [Initialize git] runs git.init and then
// resolves and checks the folder again at once.
import '../helpers/rtl.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { scopeRootNote } from '@renderer/pages/dashboard/composer/model.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { check, fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

let mock: MockDimFactory

const notGit = () =>
  report({
    info: [
      check('folder.git', {
        title: 'Not a git repository',
        detail: 'Dim Factory still snapshots and diffs every run in its own shadow repository.',
      }),
    ],
  })

beforeEach(() => {
  resetRecoveryForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

describe('recent folders', () => {
  it("offers core's recent folders as chips, a missing folder struck through", async () => {
    mock.on('folders.recent', () => [
      { folder: 'C:\\work\\api', scopeRoot: 'C:\\work\\api', lastRunAt: 3, isGit: true, exists: true },
      { folder: 'C:\\old\\gone', scopeRoot: null, lastRunAt: 2, isGit: false, exists: false },
    ])
    await mountComposer(null)
    const chips = screen.getAllByRole('button', { name: /^Use folder / })
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Use folder C:\\work\\api',
      'Use folder C:\\old\\gone',
    ])
    expect(chips[1]?.className).toContain('line-through')
    fireEvent.click(chips[0] as HTMLElement)
    await settle(300)
    expect(screen.getByTestId<HTMLInputElement>('composer-folder-input').value).toBe('C:\\work\\api')
    expect(mock.callsOf('preflight.run').at(-1)).toEqual({ folder: 'C:\\work\\api' })
  })
})

describe('scope root', () => {
  it('notes when snapshots cover the repository root rather than the chosen folder', async () => {
    mock.on('config.resolve', fakeResolve({ scopeRoot: 'C:\\work' }))
    await mountComposer()
    expect(screen.getByTestId('scope-root-note').textContent).toBe('Snapshots cover repo root C:\\work')
  })

  it('says nothing when the folder is its own scope root (case and slashes aside on Windows)', async () => {
    mock.on('config.resolve', fakeResolve({ scopeRoot: 'c:/work/repo/' }))
    await mountComposer()
    expect(screen.queryByTestId('scope-root-note')).toBeNull()
    expect(scopeRootNote('/home/me/Repo', '/home/me/repo', 'linux')).toBe(
      'Snapshots cover repo root /home/me/repo',
    )
    expect(scopeRootNote('C:\\a', null, 'win32')).toBeNull()
  })
})

describe('non-git folder', () => {
  it('shows the banner from core’s folder.git answer; Initialize git runs git.init, then resolves and checks again', async () => {
    let initialized = false
    mock.on('preflight.run', () => (initialized ? report() : notGit()))
    mock.on('git.init', () => {
      initialized = true
    })
    await mountComposer()
    expect(screen.queryByTestId('non-git-banner')).toBeNull()
    await settle(300)
    const banner = screen.getByTestId('non-git-banner')
    expect(banner.textContent).toContain('Not a git repository. Dim Factory tracks changes itself')
    const resolves = mock.callsOf('config.resolve').length
    const checks = mock.callsOf('preflight.run').length
    await act(async () => {
      fireEvent.click(screen.getByTestId('init-git'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('git.init')).toEqual([{ folder: FOLDER }])
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe(
      `Initialized a git repository in ${FOLDER}. Dim Factory made no commit; delete the .git folder to undo it.`,
    )
    await settle()
    expect(mock.callsOf('config.resolve').length).toBe(resolves + 1)
    await settle(300)
    expect(mock.callsOf('preflight.run').length).toBe(checks + 1)
    expect(screen.queryByTestId('non-git-banner')).toBeNull()
  })

  it("shows core's error when git init fails and keeps the banner", async () => {
    mock.on('preflight.run', notGit)
    mock.on('git.init', () => {
      throw mockError('GIT', 'git init failed: permission denied')
    })
    await mountComposer()
    await settle(300)
    await act(async () => {
      fireEvent.click(screen.getByTestId('init-git'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(useStore.getState().toasts.items.at(-1)).toMatchObject({
      level: 'error',
      message: 'git init failed: permission denied',
    })
    expect(screen.getByTestId('non-git-banner')).toBeTruthy()
  })
})
