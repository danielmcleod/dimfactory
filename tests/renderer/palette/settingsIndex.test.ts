// The Settings index (the Ctrl/Cmd+K palette's Settings index; src/renderer/src/pages/settings/
// index.ts): one list of every row by label with its field id, shared by the palette and the rows. Every entry names a
// real section, ids are unique per section page, nothing has an em dash, links are the deep-link shape, and a pointer
// below a row finds the row above it (core's settings_link pointers). Every field id a Settings page marks literally
// (`field="…"`, `data-setting-field="…"`, `settingFieldProps('…')`) is in the index, so the list and the rows agree.
import { describe, expect, it } from 'vitest'
import {
  fieldIdCandidates,
  findSettingsField,
  SETTINGS_FIELDS,
  settingFieldProps,
  settingsFieldHref,
} from '@renderer/pages/settings/index.ts'
import { SETTINGS_SECTIONS } from '@renderer/pages/settings/sections.ts'
import { parseHash } from '@renderer/lib/router.ts'

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('not in the index')
  return v
}

type Fs = {
  readdirSync(path: URL, opts: { recursive: true }): string[]
  readFileSync(path: URL, encoding: 'utf8'): string
}
// Not inlined into `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset lookup.
const here = import.meta.url

/** The literal field ids marked under src/renderer/src/pages/settings, with the file that marks each. */
function markedIds(): { id: string; file: string }[] {
  const fs = (
    globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }
  ).process.getBuiltinModule('node:fs')
  const dir = new URL('../../../src/renderer/src/pages/settings/', here)
  const out: { id: string; file: string }[] = []
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    if (!/\.tsx?$/.test(file) || /(^|[\\/])index\.ts$/.test(file)) continue
    const text = fs.readFileSync(new URL(file.replace(/\\/g, '/'), dir), 'utf8')
    const marks = /\bfield="([^"]+)"|data-setting-field="([^"]+)"|settingFieldProps\('([^']+)'\)/g
    for (const m of text.matchAll(marks)) out.push({ id: m[1] ?? m[2] ?? m[3] ?? '', file })
  }
  return out
}

describe('Settings index', () => {
  it('names a real section for every row, with ids unique per section page', () => {
    const sections = new Set(SETTINGS_SECTIONS.map((s) => s.id))
    const seen = new Set<string>()
    for (const f of SETTINGS_FIELDS) {
      expect(sections.has(f.section), `${f.id} names section "${f.section}"`).toBe(true)
      const key = `${f.section}/${f.sub ?? ''}?${f.id}`
      expect(seen.has(key), `${key} is listed twice`).toBe(false)
      seen.add(key)
      expect(f.label.trim()).not.toBe('')
    }
  })

  it('lists rows of every section of the Settings table', () => {
    const covered = new Set(SETTINGS_FIELDS.map((f) => f.section))
    for (const s of SETTINGS_SECTIONS) expect(covered.has(s.id), s.id).toBe(true)
  })

  it('has no em dash in anything the palette shows or searches', () => {
    for (const f of SETTINGS_FIELDS) {
      const text = [f.label, f.control ?? '', f.group ?? '', ...(f.keywords ?? [])].join(' ')
      expect(text.includes('\u2014'), f.id).toBe(false)
    }
  })

  it('builds the deep link #/settings/<section>[/<sub>]?field=<id>', () => {
    const sound = must(SETTINGS_FIELDS.find((f) => f.id === '/notifications/sound'))
    expect(settingsFieldHref(sound)).toBe('#/settings/notifications?field=%2Fnotifications%2Fsound')
    expect(parseHash(settingsFieldHref(sound))).toEqual({
      name: 'settings',
      section: 'notifications',
      subpath: [],
      query: { field: '/notifications/sound' },
    })
    const plan = must(SETTINGS_FIELDS.find((f) => f.section === 'prompts' && f.sub === 'plan'))
    expect(parseHash(settingsFieldHref(plan))).toEqual({
      name: 'settings',
      section: 'prompts',
      subpath: ['plan'],
      query: { field: 'template' },
    })
  })

  it("finds the row a pointer names, or the nearest row above a deeper pointer (core's links)", () => {
    expect(fieldIdCandidates('/passes/implement/model')).toEqual([
      '/passes/implement/model',
      '/passes/implement',
      '/passes',
    ])
    expect(fieldIdCandidates('pause')).toEqual(['pause'])
    expect(findSettingsField('profiles', '/passes/implement/model')?.label).toBe('Passes')
    expect(findSettingsField('diagnostics', 'clearSnapshots')?.label).toBe('Clear snapshots')
    expect(findSettingsField('config', 'restore')?.label).toBe('Restore the last good copy')
    // Core's pointers that name no row (Clear snapshots, Restore last good) are their section's own to focus.
    expect(findSettingsField('diagnostics', '/storage/shadow')).toBeUndefined()
    expect(findSettingsField('config', '/backups/last-good')).toBeUndefined()
    expect(findSettingsField('prompts', 'template', 'review')?.label).toBe('Review prompt')
    expect(findSettingsField('general', '/nothing/here')).toBeUndefined()
    // A pointer only counts in its own section.
    expect(findSettingsField('general', '/notifications/sound')).toBeUndefined()
  })

  it('lists every field id a Settings page marks', () => {
    const ids = new Set(SETTINGS_FIELDS.map((f) => f.id))
    const marked = markedIds()
    expect(marked.length).toBeGreaterThan(0)
    for (const { id, file } of marked) expect(ids.has(id), `${file} marks "${id}"`).toBe(true)
  })

  it('marks an element with its field id', () => {
    expect(settingFieldProps('pause')).toEqual({ 'data-setting-field': 'pause' })
  })
})
