// Taskbar / Dock attention (src/main/attention-surfaces.ts; attention surfaces, the count): overlay and
// badge selection, the flash on a new ask while unfocused and its end on focus, native calls only on change, and the
// committed overlay PNGs (scripts/make-tray-icons.mjs).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '../../../src/shared/estimates.ts'
import type { Platform } from '../../../src/shared/ipc.ts'
import {
  AttentionSurfaces,
  badgeCount,
  newAskIds,
  overlayDescription,
  overlayIcon,
} from '../../../src/main/attention-surfaces.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const RUN = '20261006T120000Z-ab12'

const askItem = (requestId: string): AttentionItem => ({
  id: `ask:${requestId}`,
  runId: RUN,
  displayNo: 1,
  title: 't',
  folder: 'C:\\src\\my-app',
  since: 1,
  kind: 'ask',
  ask: {
    runId: RUN,
    step: 'implement',
    attempt: 1,
    requestId,
    vendor: 'claude',
    kind: 'shell',
    detail: 'npm test',
    expiresAt: 600_000,
    allowSession: true,
    queue: { index: 1, total: 1 },
  },
})
const cardItem: AttentionItem = {
  id: 'card:c1',
  runId: RUN,
  displayNo: 1,
  title: 't',
  folder: 'f',
  since: 1,
  kind: 'card',
  cardId: 'c1',
  cardKind: 'gate:afterPlan',
  cardTitle: 'Plan ready',
  blocking: true,
}

function setup(platform: Platform) {
  const calls: string[] = []
  let focused = false
  const s = new AttentionSurfaces({
    platform,
    focused: () => focused,
    ops: {
      setOverlay: (icon, d) => calls.push(`overlay ${icon ?? 'null'} "${d}"`),
      flash: (on) => calls.push(`flash ${String(on)}`),
      setBadge: (n) => calls.push(`badge ${n}`),
    },
  })
  return { s, calls, focus: (v: boolean) => (focused = v) }
}

describe('selection', () => {
  it.each([
    [0, null, ''],
    [1, 'overlay-1.png', '1 needs you'],
    [3, 'overlay-3.png', '3 need you'],
    [9, 'overlay-9.png', '9 need you'],
    [10, 'overlay-9p.png', '10 need you'],
    [-1, null, ''],
    [Number.NaN, null, ''],
  ])('%d need you → %s', (n, icon, description) => {
    expect(overlayIcon(n)).toBe(icon)
    expect(overlayDescription(n)).toBe(description)
  })

  it('badge counts on macOS and Linux only', () => {
    expect(badgeCount(2, 'darwin')).toBe(2)
    expect(badgeCount(0, 'linux')).toBe(0)
    expect(badgeCount(2, 'win32')).toBeNull()
  })

  it('finds asks not seen before', () => {
    expect(newAskIds([askItem('a'), cardItem, askItem('b')], new Set(['ask:a']))).toEqual(['ask:b'])
  })
})

describe('AttentionSurfaces on Windows', () => {
  it('sets the overlay only when it changes and clears it at zero', () => {
    const t = setup('win32')
    t.s.update(1, [cardItem])
    t.s.update(1, [cardItem])
    t.s.update(2, [cardItem, cardItem])
    t.s.update(0, [])
    expect(t.calls).toEqual([
      'overlay overlay-1.png "1 needs you"',
      'overlay overlay-2.png "2 need you"',
      'overlay null ""',
    ])
    expect(t.s.current).toMatchObject({ needsYou: 0, overlay: null, badge: null, flashing: false })
  })

  it('flashes the taskbar on a new ask while unfocused and stops on focus', () => {
    const t = setup('win32')
    t.s.update(1, [askItem('a')])
    expect(t.calls).toContain('flash true')
    expect(t.s.current.flashing).toBe(true)
    t.calls.length = 0
    // the same ask again (an expiry moved): no new flash
    t.s.update(1, [askItem('a')])
    expect(t.calls).toEqual([])
    t.focus(true)
    t.s.focused()
    expect(t.calls).toEqual(['flash false'])
    expect(t.s.current.flashing).toBe(false)
    t.s.focused()
    expect(t.calls).toEqual(['flash false'])
  })

  it('does not flash while focused, nor for a card', () => {
    const t = setup('win32')
    t.focus(true)
    t.s.update(1, [askItem('a')])
    t.focus(false)
    t.s.update(2, [askItem('a'), cardItem])
    expect(t.calls.filter((c) => c.startsWith('flash'))).toEqual([])
  })

  it('stops flashing when nothing needs the user any more', () => {
    const t = setup('win32')
    t.s.update(1, [askItem('a')])
    t.s.update(0, [])
    expect(t.calls.slice(-1)).toEqual(['flash false'])
  })

  it('re-applies the overlay once the window exists', () => {
    const t = setup('win32')
    t.s.update(2, [cardItem, cardItem])
    t.calls.length = 0
    t.s.reapply()
    expect(t.calls).toEqual(['overlay overlay-2.png "2 need you"'])
  })

  it('survives a throwing native call', () => {
    const s = new AttentionSurfaces({
      platform: 'win32',
      focused: () => false,
      ops: {
        setOverlay: () => {
          throw new Error('no window')
        },
        flash: () => undefined,
        setBadge: () => undefined,
      },
    })
    expect(() => s.update(1, [cardItem])).not.toThrow()
  })
})

describe('AttentionSurfaces on macOS / Linux', () => {
  it.each<Platform>(['darwin', 'linux'])('%s: badge = needs-you count, no overlay, no flash', (platform) => {
    const t = setup(platform)
    t.s.update(2, [askItem('a'), askItem('b')])
    t.s.update(2, [askItem('a'), askItem('b')])
    t.s.update(0, [])
    expect(t.calls).toEqual(['badge 2', 'badge 0'])
    t.calls.length = 0
    t.s.reapply()
    expect(t.calls).toEqual(['badge 0'])
  })
})

describe('build/tray overlay PNGs', () => {
  it.each(['1', '2', '3', '4', '5', '6', '7', '8', '9', '9p'])('overlay-%s exists at 16 and 32 px', (n) => {
    for (const [file, size] of [
      [`overlay-${n}.png`, 16],
      [`overlay-${n}@2x.png`, 32],
    ] as const) {
      const path = join(ROOT, 'build', 'tray', file)
      expect(existsSync(path), path).toBe(true)
      const b = readFileSync(path)
      expect(b.subarray(1, 4).toString('ascii')).toBe('PNG')
      expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([size, size])
    }
  })
})
