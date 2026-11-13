// Helpers shared by the Diff tab and Settings E2E specs (the Diff tab, Settings, the Ctrl/Cmd+K
// palette; diff.spec.ts, settings.spec.ts): real PNG bytes for the Diff tab's image rows, the Diff tab's per-file sections, the
// prompt a fake pass was sent, the fake processes the probe spawned, and the user's dimfactory.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import type { Locator, Page } from '@playwright/test'
import { stdinByScript } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'

// ---- PNG ------------------------------------------------------------------------------------------------------------

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([head, body, crc])
}

/** A real `size` × `size` PNG of one colour (the browser decodes it; core recognises it by its bytes). */
export function solidPng(rgb: readonly [number, number, number], size = 4): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, () => Buffer.from(rgb))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- the Diff tab ---------------------------------------------------------------------------------------------------

/** One file's section in the Diff tab. */
export function diffFile(page: Page, path: string): Locator {
  return page.locator(`article[data-testid="diff-file"][data-path="${path}"]`)
}

/** The paths the Diff tab lists for the segment shown, in order. */
export async function diffPaths(page: Page): Promise<string[]> {
  return page
    .locator('article[data-testid="diff-file"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-path') ?? ''))
}

/** Open the run's Diff tab (its route, as a link to it would). */
export async function openDiffTab(page: Page, runId: string): Promise<void> {
  await page.evaluate((id) => {
    location.hash = `#/runs/${id}/diff`
  }, runId)
  await expect(page.getByTestId('diff-tab')).toBeVisible()
}

/** Pick a segment (Implement / Fix / Combined) in the toolbar and wait for its list. */
export async function chooseSegment(page: Page, label: 'Implement' | 'Fix' | 'Combined'): Promise<void> {
  await page.getByTestId('diff-segments').getByRole('radio', { name: label, exact: true }).click()
  await expect(page.getByTestId('diff-tab')).toHaveAttribute('data-segment', label.toLowerCase())
  await expect(page.getByTestId('diff-toolbar')).toBeVisible()
}

/** The image an image row shows, decoded (naturalWidth > 0). */
export async function imageDecoded(img: Locator): Promise<boolean> {
  return img.evaluate((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0)
}

// ---- what the fake was sent -----------------------------------------------------------------------------------------

/** The text of the first `user` message on a script's stdin (the prompt Dim Factory sent the pass). */
export function promptSent(e2e: E2EHarness, script: string): string {
  for (const line of stdinByScript(e2e.fakeLog()).get(script) ?? []) {
    const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] | string } }
    if (v.type !== 'user') continue
    const c = v.message?.content
    return typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('')
  }
  return ''
}

/** How many fake processes the vendor probe started (`--version`, `auth status`, the initialize handshake). */
export function probeSpawns(e2e: E2EHarness): number {
  return e2e
    .fakeLog()
    .filter(
      (e) =>
        e.kind === 'start' &&
        Array.isArray(e['argv']) &&
        ((e['argv'] as string[]).includes('--version') ||
          ((e['argv'] as string[]).includes('auth') && (e['argv'] as string[]).includes('status'))),
    ).length
}

// ---- the user's dimfactory.json ----------------------------------------------------------------------------------------

export function userConfigPath(e2e: E2EHarness): string {
  return join(e2e.home, 'dimfactory.json')
}

export function readUserConfig(e2e: E2EHarness): Record<string, unknown> {
  return JSON.parse(readFileSync(userConfigPath(e2e), 'utf8')) as Record<string, unknown>
}

// ---- the palette ------------------------------------------------------------------------------------------------------

/** Open the Ctrl/Cmd+K palette (focus in its search box). */
export async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByTestId('palette')
  await expect(palette).toBeVisible()
  await expect(page.getByTestId('palette-input')).toBeFocused()
  return palette
}

// ---- Settings -------------------------------------------------------------------------------------------------------

/**
 * The open Settings section has what it reads from core (sections read once they have been open a moment): no
 * busy region and no "Loading…" left in it, so an audit sees the section as the user reads it.
 */
export async function settingsLoaded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId('settings-content')
          .evaluate(
            (el) =>
              el.querySelector('[aria-busy="true"]') === null &&
              !(el as HTMLElement).innerText.includes('Loading'),
          ),
      { timeout: 20_000, message: 'the Settings section never finished loading' },
    )
    .toBe(true)
}

// ---- the Diff tab moves nothing on its own --------------------------------------------------------------------------

interface DiffShift {
  value: number
  input: boolean
  inDiff: boolean
  sources: string[]
}
type DiffShiftWindow = Window & { __m11DiffShifts?: DiffShift[] }

/** Start recording layout shifts in the page, noting which moved something in the Diff tab. */
export async function watchDiffShifts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as DiffShiftWindow
    w.__m11DiffShifts = []
    interface LayoutShiftEntry extends PerformanceEntry {
      value: number
      hadRecentInput: boolean
      sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[]
    }
    const elementOf = (n: Node | null | undefined): Element | null =>
      n instanceof Element ? n : (n?.parentElement ?? null)
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LayoutShiftEntry[]) {
        const sources = e.sources ?? []
        w.__m11DiffShifts?.push({
          value: e.value,
          input: e.hadRecentInput,
          inDiff: sources.some((s) => elementOf(s.node)?.closest('[data-testid="diff-tab"]') != null),
          sources: sources.map((s) => {
            const el = elementOf(s.node)
            const id = el?.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
            const path = el?.closest('[data-path]')?.getAttribute('data-path') ?? ''
            return `${el?.tagName.toLowerCase() ?? 'a node'} in [${id}]${path !== '' ? ` (${path})` : ''} y ${Math.round(s.previousRect.y)} → ${Math.round(s.currentRect.y)}, h ${Math.round(s.previousRect.height)} → ${Math.round(s.currentRect.height)}`
          }),
        })
      }
    }).observe({ type: 'layout-shift' })
  })
}

/** Since watchDiffShifts: the layout shifts without recent input, their sum, and those that moved the Diff tab. */
export async function unpromptedDiffShifts(page: Page): Promise<{ cls: number; inDiff: string[] }> {
  const all = await page.evaluate(() => (window as DiffShiftWindow).__m11DiffShifts ?? [])
  const shifts = all.filter((s) => !s.input)
  return {
    cls: shifts.reduce((n, s) => n + s.value, 0),
    inDiff: shifts.filter((s) => s.inDiff).map((s) => `${s.value.toFixed(4)}: ${s.sources.join('; ')}`),
  }
}
