// app/App.tsx: routing to the page entry points, the bridge started once under StrictMode, and the app banners
// (lost contact, quit requested, runs paused because Dim Factory closed).
import './helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@renderer/app/App.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from './helpers/mockDimFactory.ts'
import type { MockDimFactory } from './helpers/mockDimFactory.ts'

let mock: MockDimFactory

async function mount(strict = true): Promise<void> {
  render(strict ? <StrictMode>{<App />}</StrictMode> : <App />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  window.location.hash = ''
  mock = installMockDimFactory({ handlers: { 'app.quit': () => ({ quitting: true, activeRuns: 2 }) } })
})

afterEach(() => {
  resetBridgeForTests()
  cancelRefetches()
  resetShortcuts()
  mock.uninstall()
  clearToasts()
  vi.useRealTimers()
  window.location.hash = ''
})

describe('App', () => {
  it('starts the bridge once under StrictMode and reports ready with the route', async () => {
    window.location.hash = '#/settings/vendors'
    await mount()
    expect(mock.calls.filter((c) => c.cmd === 'subscribe')).toHaveLength(1)
    expect(mock.callsOf('app.ready')).toEqual([{ route: '#/settings/vendors' }])
    expect(screen.getByTestId('settings-content').dataset['section']).toBe('vendors')
  })

  it('routes to each page entry point and to a not-found page', async () => {
    await mount()
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy()
    await act(async () => {
      window.location.hash = '#/runs/r1/diff'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // The Run view for a run core does not know (runs.get is not mocked here).
    expect(screen.getByTestId('run-not-found')).toBeTruthy()
    await act(async () => {
      window.location.hash = '#/nowhere'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('This page does not exist')).toBeTruthy()
  })

  it('switches screens with Ctrl+1/2/3', async () => {
    await mount()
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, cancelable: true }),
      )
    })
    expect(window.location.hash).toBe('#/runs')
  })

  it('shows the lost-contact banner when there is no bridge, without crashing', async () => {
    mock.uninstall()
    await mount()
    expect(screen.getByTestId('lost-contact').textContent).toContain(
      "Lost contact with Dim Factory's main process.",
    )
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy()
    // Over the page's top (the shell's banner layer), never in its flow: it moves nothing (UI standard).
    expect(screen.getByTestId('banner-layer').contains(screen.getByTestId('lost-contact'))).toBe(true)
    expect(screen.getByRole('main').contains(screen.getByTestId('lost-contact'))).toBe(false)
  })

  it('asks before quitting with active runs', async () => {
    await mount()
    act(() => mock.push({ kind: 'app', state: 'quit-requested', activeRuns: 2, runIds: ['a', 'b'] }))
    const banner = screen.getByTestId('quit-requested')
    expect(banner.textContent).toContain('2 runs are active. Quit anyway?')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Quit' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('app.quit')).toEqual([{ confirm: true }])
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(screen.queryByTestId('quit-requested')).toBeNull()
  })

  it('offers to open a run paused because Dim Factory closed', async () => {
    await mount()
    act(() => mock.push({ kind: 'app', state: 'recovered', activeRuns: 0, runIds: ['r7', 'r8'] }))
    expect(screen.getByTestId('recovered-notice').textContent).toContain(
      '2 runs were paused because Dim Factory closed.',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel all' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(window.location.hash).toBe('#/runs/r7')
    expect(screen.queryByTestId('recovered-notice')).toBeNull()
  })
})
