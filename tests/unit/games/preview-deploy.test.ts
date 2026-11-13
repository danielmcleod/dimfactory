// Playing a game in the preview and sharing it. The preview's pages get no permission but `fullscreen`, and only in
// the visible preview window (the hidden smoke check and Save as PDF windows stay deny-all); F11 toggles full screen
// and Escape leaves it. The static server knows a game's sound and model files. The Deploy helper's licence check
// counts the third-party licences a template's bundled libraries brought (lib/LICENSES).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runChecklist, vendoredLicences } from '@core/deploy/checklist.ts'
import { contentTypeOf } from '@core/preview/static-server.ts'
import { fullscreenKeyAction, previewPermissionAllowed } from '../../../src/main/preview-model.ts'

describe('preview permissions', () => {
  it('allow fullscreen in the visible window alone', () => {
    expect(previewPermissionAllowed('window', 'fullscreen')).toBe(true)
    expect(previewPermissionAllowed('smoke', 'fullscreen')).toBe(false)
    expect(previewPermissionAllowed('pdf', 'fullscreen')).toBe(false)
  })

  it.each([
    'media',
    'geolocation',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'pointerLock',
    'keyboardLock',
    'openExternal',
    'midi',
    'hid',
    'serial',
    'usb',
    'display-capture',
    'idle-detection',
    'storage-access',
    'window-management',
    'unknown',
    '',
    'Fullscreen',
  ])('deny %j everywhere', (permission) => {
    for (const kind of ['window', 'smoke', 'pdf'] as const)
      expect(previewPermissionAllowed(kind, permission), kind).toBe(false)
  })
})

describe('full screen keys', () => {
  const key = (k: string, mods: Record<string, boolean> = {}, type = 'keyDown') => ({ type, key: k, ...mods })

  it('F11 toggles, Escape leaves, and nothing else is taken from the page', () => {
    expect(fullscreenKeyAction(key('F11'), false)).toBe('toggle')
    expect(fullscreenKeyAction(key('F11'), true)).toBe('toggle')
    expect(fullscreenKeyAction(key('Escape'), true)).toBe('leave')
    expect(fullscreenKeyAction(key('Escape'), false)).toBeNull()
    expect(fullscreenKeyAction(key('F11', {}, 'keyUp'), false)).toBeNull()
    expect(fullscreenKeyAction(key('F11', { control: true }), false)).toBeNull()
    expect(fullscreenKeyAction(key('F11', { alt: true }), false)).toBeNull()
    expect(fullscreenKeyAction(key('F11', { shift: true }), false)).toBeNull()
    for (const k of ['ArrowLeft', ' ', 'p', 'Enter', 'F5', 'F12'])
      expect(fullscreenKeyAction(key(k), true), k).toBeNull()
  })
})

describe('the static server', () => {
  it.each([
    ['music.m4a', 'audio/mp4'],
    ['jump.opus', 'audio/ogg'],
    ['dice.glb', 'model/gltf-binary'],
    ['dice.gltf', 'model/gltf+json'],
    ['hit.ogg', 'audio/ogg'],
    ['song.mp3', 'audio/mpeg'],
  ])('serves %s as %s', (name, type) => {
    expect(contentTypeOf(name)).toBe(type)
  })
})

describe('the licence check', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const folder = (files: Record<string, string>): string => {
    const d = mkdtempSync(join(tmpdir(), 'dimf-lic-'))
    dirs.push(d)
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(d, p)), { recursive: true })
      writeFileSync(join(d, p), text)
    }
    return d
  }

  it('finds the licences in lib/LICENSES only', () => {
    expect(
      vendoredLicences([
        'lib/LICENSES/phaser.txt',
        'lib/LICENSES/three.txt',
        'LICENSE',
        'lib/x/LICENSE',
        'lib/LICENSES',
      ]),
    ).toEqual(['lib/LICENSES/phaser.txt', 'lib/LICENSES/three.txt'])
  })

  it('counts them beside the project licence, and still asks for one at the root', async () => {
    const both = await runChecklist(
      folder({
        LICENSE: 'MIT',
        'lib/LICENSES/tiny.txt': 'MIT',
        'lib/LICENSES/other.txt': 'MIT',
        'index.html': '<p>',
      }),
      'static-site',
    )
    expect(both.items.find((i) => i.id === 'license')).toMatchObject({
      state: 'ok',
      detail: 'LICENSE is at the root. lib/LICENSES holds 2 third-party licences.',
      evidence: ['lib/LICENSES/other.txt', 'lib/LICENSES/tiny.txt'],
    })
    const bundledOnly = await runChecklist(
      folder({ 'lib/LICENSES/tiny.txt': 'MIT', 'index.html': '<p>' }),
      'static-site',
    )
    expect(bundledOnly.items.find((i) => i.id === 'license')).toMatchObject({
      state: 'warn',
      detail:
        'No licence file at the root. Add one if others may use or copy the code. lib/LICENSES holds one third-party licence.',
    })
    const none = await runChecklist(folder({ LICENSE: 'MIT' }), 'static-site')
    expect(none.items.find((i) => i.id === 'license')).toEqual({
      id: 'license',
      label: 'Licence file',
      state: 'ok',
      auto: true,
      detail: 'LICENSE is at the root.',
    })
  })
})
