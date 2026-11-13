import { describe, expect, it } from 'vitest'
import {
  LATER_VERSION,
  TRAY_MAX_RUNS,
  trayIcon,
  trayMenu,
  trayModel,
  trayTooltip,
} from '../../../src/main/tray-model.ts'
import type { TrayMenuItem, TrayState } from '../../../src/main/tray-model.ts'

const state = (activeRuns: number, needsYou = 0, runs: TrayState['runs'] = []): TrayState => ({
  activeRuns,
  needsYou,
  runs,
})
const run = (n: number, needsYou = false): TrayState['runs'][number] => ({
  runId: `r${n}`,
  title: `Run ${n}`,
  needsYou,
})
const labels = (items: TrayMenuItem[]): string[] => items.map((i) => (i.type === 'separator' ? '—' : i.label))

describe('trayIcon (Windows / Linux colour PNGs)', () => {
  it.each([
    [0, 0, 'tray-0.png'],
    [1, 0, 'tray-1.png'],
    [9, 0, 'tray-9.png'],
    [10, 0, 'tray-9p.png'],
    [250, 0, 'tray-9p.png'],
    [0, 1, 'tray-0-attn.png'],
    [3, 2, 'tray-3-attn.png'],
    [12, 1, 'tray-9p-attn.png'],
  ])('%i active, %i needing you → %s', (active, needs, icon) => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(trayIcon(state(active, needs), platform)).toEqual({ icon, template: false })
    }
  })

  it('treats negative, fractional and non-finite counts defensively', () => {
    expect(trayIcon(state(-3, -1), 'win32').icon).toBe('tray-0.png')
    expect(trayIcon(state(2.7, 0.5), 'win32').icon).toBe('tray-2.png')
    expect(trayIcon(state(Number.NaN, Number.POSITIVE_INFINITY), 'linux').icon).toBe('tray-0.png')
  })

  it('every name it can produce is one make-tray-icons.mjs generates', () => {
    const names = new Set<string>()
    for (let n = 0; n <= 12; n++) {
      for (const needs of [0, 1]) names.add(trayIcon(state(n, needs), 'win32').icon)
    }
    const expected = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '9p'].flatMap((c) => [
      `tray-${c}.png`,
      `tray-${c}-attn.png`,
    ])
    expect([...names].sort()).toEqual(expected.sort())
  })
})

describe('trayIcon / title on macOS (template glyph + count title)', () => {
  it('uses the template glyph and shows the active count as the title', () => {
    expect(trayModel(state(0), 'darwin')).toMatchObject({
      icon: 'trayTemplate.png',
      template: true,
      title: '',
    })
    expect(trayModel(state(3), 'darwin')).toMatchObject({ icon: 'trayTemplate.png', title: '3' })
    expect(trayModel(state(12, 2), 'darwin')).toMatchObject({ icon: 'trayAttnTemplate.png', title: '12' })
  })

  it('never sets a title elsewhere', () => {
    expect(trayModel(state(3, 1), 'win32').title).toBe('')
    expect(trayModel(state(3, 1), 'linux').title).toBe('')
  })
})

describe('trayTooltip', () => {
  it.each([
    [0, 0, 'No active runs'],
    [1, 0, '1 run active'],
    [2, 0, '2 runs active'],
    [2, 1, '2 runs active · 1 needs you'],
    [3, 2, '3 runs active · 2 need you'],
    [0, 1, 'No active runs · 1 needs you'],
    [12, 0, '12 runs active'],
  ])('%i active, %i needing you → %s', (active, needs, text) => {
    expect(trayTooltip(state(active, needs))).toBe(text)
  })
})

describe('trayMenu', () => {
  it('has Open · No active runs · New run · Pause (disabled) · Quit when idle', () => {
    const menu = trayMenu(state(0), 'win32')
    expect(labels(menu)).toEqual([
      'Open Dim Factory',
      '—',
      'No active runs',
      '—',
      'New run',
      'Pause notifications for 1 hour',
      '—',
      'Quit',
    ])
    const byLabel = (l: string): TrayMenuItem | undefined =>
      menu.find((i) => i.type === 'item' && i.label === l)
    expect(byLabel('Open Dim Factory')).toMatchObject({ enabled: true, action: { kind: 'open' } })
    expect(byLabel('No active runs')).toMatchObject({ enabled: false })
    expect(byLabel('New run')).toMatchObject({ enabled: true, action: { kind: 'new-run' } })
    expect(byLabel('Pause notifications for 1 hour')).toEqual({
      type: 'item',
      label: 'Pause notifications for 1 hour',
      enabled: false,
      toolTip: LATER_VERSION,
    })
    expect(byLabel('Quit')).toMatchObject({ enabled: true, action: { kind: 'quit' } })
  })

  it('lists active runs with a dot when one needs you, and opens that run on click', () => {
    const menu = trayMenu(state(2, 1, [run(1), run(2, true)]), 'win32')
    expect(labels(menu).slice(2, 5)).toEqual(['Active runs', '● Run 2', 'Run 1'])
    expect(menu[3]).toMatchObject({ enabled: true, action: { kind: 'open-run', runId: 'r2' } })
    expect(menu[4]).toMatchObject({ enabled: true, action: { kind: 'open-run', runId: 'r1' } })
  })

  it(`shows at most ${TRAY_MAX_RUNS} runs (those needing you first) and collapses the rest`, () => {
    const runs = [run(1), run(2), run(3), run(4), run(5), run(6), run(7, true)]
    const menu = trayMenu(state(7, 1, runs), 'linux')
    const runItems = menu.filter((i) => i.type === 'item' && i.action?.kind === 'open-run')
    expect(runItems).toHaveLength(TRAY_MAX_RUNS)
    expect(labels(runItems)).toEqual(['● Run 7', 'Run 1', 'Run 2', 'Run 3', 'Run 4'])
    expect(menu.find((i) => i.type === 'item' && i.label === '2 more runs')).toMatchObject({
      action: { kind: 'open' },
    })
    const one = trayMenu(state(6, 0, runs.slice(0, 6)), 'linux')
    expect(labels(one)).toContain('1 more run')
  })

  it('flattens, truncates and escapes run titles for the native menu', () => {
    const long = 'x'.repeat(100)
    const items = trayMenu(
      state(3, 0, [
        { runId: 'a', title: 'fix\n  the & build', needsYou: false },
        { runId: 'b', title: long, needsYou: false },
        { runId: 'c', title: '   ', needsYou: false },
      ]),
      'win32',
    )
    const runLabels = labels(items.filter((i) => i.type === 'item' && i.action?.kind === 'open-run'))
    expect(runLabels[0]).toBe('fix the && build')
    expect(Array.from(runLabels[1] ?? '')).toHaveLength(48)
    expect(runLabels[1]?.endsWith('…')).toBe(true)
    expect(runLabels[2]).toBe('Untitled run')
    const mac = trayMenu(state(1, 0, [{ runId: 'a', title: 'a & b', needsYou: false }]), 'darwin')
    expect(labels(mac)).toContain('a & b')
  })

  it('does not split a surrogate pair when truncating', () => {
    const title = '😀'.repeat(60)
    const [item] = trayMenu(state(1, 0, [{ runId: 'a', title, needsYou: false }]), 'win32').filter(
      (i) => i.type === 'item' && i.action?.kind === 'open-run',
    )
    const label = item?.type === 'item' ? item.label : ''
    expect(Array.from(label)).toEqual([...Array.from('😀'.repeat(47)), '…'])
  })

  it('is deterministic, so the wrapper can compare menus to skip rebuilds', () => {
    const s = state(2, 1, [run(1, true), run(2)])
    expect(JSON.stringify(trayMenu(s, 'win32'))).toBe(
      JSON.stringify(trayMenu({ ...s, runs: [...s.runs] }, 'win32')),
    )
  })
})
