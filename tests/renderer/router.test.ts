// lib/router.ts: hash parsing, hrefs, navigation and the useRoute hook.
import './helpers/rtl.ts'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { currentHash, href, navigate, parseHash, useRoute } from '@renderer/lib/router.ts'

afterEach(() => {
  window.location.hash = ''
})

describe('parseHash', () => {
  it('parses every route', () => {
    expect(parseHash('')).toEqual({ name: 'dashboard', query: {} })
    expect(parseHash('#/')).toEqual({ name: 'dashboard', query: {} })
    expect(parseHash('#/runs')).toEqual({ name: 'runs', query: {} })
    expect(parseHash('#/runs?status=failed&q=fix')).toEqual({
      name: 'runs',
      query: { status: 'failed', q: 'fix' },
    })
    expect(parseHash('#/runs/r-1')).toEqual({ name: 'run', runId: 'r-1', tab: 'flow', query: {} })
    expect(parseHash('#/runs/r-1/diff')).toEqual({ name: 'run', runId: 'r-1', tab: 'diff', query: {} })
    expect(parseHash('#/runs/r-1/log')).toMatchObject({ tab: 'log' })
    expect(parseHash('#/runs/r-1/config')).toMatchObject({ tab: 'config' })
    expect(parseHash('#/settings')).toEqual({ name: 'settings', subpath: [], query: {} })
    expect(parseHash('#/settings/vendors/codex?field=path')).toEqual({
      name: 'settings',
      section: 'vendors',
      subpath: ['codex'],
      query: { field: 'path' },
    })
  })

  it('reports unknown paths and tabs as not found', () => {
    expect(parseHash('#/nope')).toMatchObject({ name: 'notFound', path: '/nope' })
    expect(parseHash('#/runs/r1/files')).toMatchObject({ name: 'notFound' })
    expect(parseHash('#/runs/r1/diff/extra')).toMatchObject({ name: 'notFound' })
  })

  it('decodes segments', () => {
    expect(parseHash('#/runs/a%20b')).toMatchObject({ runId: 'a b' })
    expect(parseHash('#/runs/%E0%A4%A')).toMatchObject({ runId: '%E0%A4%A' })
  })
})

describe('href', () => {
  it('round-trips through parseHash', () => {
    const targets = [
      { name: 'dashboard' as const },
      { name: 'runs' as const, query: { status: 'failed' } },
      { name: 'run' as const, runId: 'r 1', tab: 'diff' as const },
      { name: 'settings' as const, section: 'vendors', subpath: ['codex'], query: { field: 'path' } },
    ]
    expect(targets.map(href)).toEqual([
      '#/',
      '#/runs?status=failed',
      '#/runs/r%201/diff',
      '#/settings/vendors/codex?field=path',
    ])
    expect(parseHash(href(targets[2]!))).toMatchObject({ name: 'run', runId: 'r 1', tab: 'diff' })
    expect(href({ name: 'run', runId: 'r1', tab: 'flow' })).toBe('#/runs/r1')
    expect(href({ name: 'settings' })).toBe('#/settings')
  })
})

describe('navigate and useRoute', () => {
  it('updates subscribers on navigation, including replace', async () => {
    const { result } = renderHook(() => useRoute())
    expect(result.current.name).toBe('dashboard')
    await act(async () => {
      navigate({ name: 'run', runId: 'r9', tab: 'log' })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current).toMatchObject({ name: 'run', runId: 'r9', tab: 'log' })
    expect(currentHash()).toBe('#/runs/r9/log')
    act(() => navigate('#/settings/general', { replace: true }))
    expect(result.current).toMatchObject({ name: 'settings', section: 'general' })
    const before = result.current
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(result.current).toBe(before)
  })
})

describe('a match', () => {
  it('has its own page, by id', () => {
    expect(parseHash('#/matches/20261110T120000Z-ab12')).toEqual({
      name: 'match',
      matchId: '20261110T120000Z-ab12',
      query: {},
    })
    expect(href({ name: 'match', matchId: '20261110T120000Z-ab12' })).toBe('#/matches/20261110T120000Z-ab12')
    expect(parseHash('#/matches')).toMatchObject({ name: 'notFound' })
    expect(parseHash('#/matches/a/b')).toMatchObject({ name: 'notFound' })
  })
})

describe('a rematch', () => {
  it('is chosen on its own page, by the run it replays', () => {
    expect(parseHash('#/rematch/r-1')).toEqual({ name: 'rematch', runId: 'r-1', query: {} })
    expect(href({ name: 'rematch', runId: 'r-1' })).toBe('#/rematch/r-1')
    expect(parseHash('#/rematch')).toMatchObject({ name: 'notFound' })
  })
})
