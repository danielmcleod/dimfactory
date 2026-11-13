// scripts/brand-sync.mjs: the files that cannot import src/shared/brand.ts (package.json, LICENSE, the electron-builder
// config, the NSIS include, the deb's scripts and AppArmor profile) carry its names, and a drifted line is put back.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, syncText } from '../../../scripts/brand-sync.mjs'
import { BRAND, HOME_ENV, LICENSE_COPYRIGHT, envName } from '../../../src/shared/brand.ts'

const repo = join(import.meta.dirname, '..', '..', '..')

describe('the brand module', () => {
  it('derives its environment names and ref prefixes from one another', () => {
    expect(HOME_ENV).toBe(`${BRAND.envPrefix}HOME`)
    expect(envName('E2E')).toBe(`${BRAND.envPrefix}E2E`)
    expect(BRAND.runRefPrefix.startsWith(BRAND.refNamespace)).toBe(true)
    expect(BRAND.toastActivatorClsid).toMatch(
      /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/,
    )
  })
})

describe('brand-sync', () => {
  it('finds this repository in sync', () => {
    const out: string[] = []
    expect(
      main(['--check'], { root: repo, log: (l) => out.push(l), err: (l) => out.push(l) }),
      out.join('\n'),
    ).toBe(0)
  })

  it('puts a drifted line back, keeps the rest, and refuses a file without the line', () => {
    const yml =
      'appId: com.example.old\nproductName: Old\ncopyright: x\nlinux:\n  executableName: old\n  maintainer: x\n  desktop:\n    entry:\n      StartupWMClass: Old\n'
    const r = syncText('electron-builder.yml', yml)
    expect(r.changed).toBe(true)
    expect(r.text).toContain(`appId: ${BRAND.appId}\n`)
    expect(r.text).toContain(`  executableName: ${BRAND.slug}\n`)
    expect(r.text).toContain('linux:\n')
    expect(syncText('electron-builder.yml', r.text).changed).toBe(false)
    expect(() => syncText('build/installer.nsh', '; no define\n')).toThrow(/expected one line/)
    // LICENSE's copyright line follows the copyright holder.
    const lic = syncText('LICENSE', 'MIT License\n\nCopyright (c) 2020 Someone Else\n\nPermission...\n')
    expect(lic.text).toBe(`MIT License\n\n${LICENSE_COPYRIGHT}\n\nPermission...\n`)
  })

  it('writes the package fields, a missing one after main', () => {
    const r = syncText(
      'package.json',
      JSON.stringify({ name: 'old', version: '1.0.0', main: 'x.js', scripts: {} }),
    )
    const pkg = JSON.parse(r.text) as Record<string, unknown>
    expect(Object.keys(pkg)).toEqual([
      'name',
      'version',
      'main',
      'productName',
      'author',
      'license',
      'desktopName',
      'bin',
      'scripts',
    ])
    expect(pkg['name']).toBe(BRAND.slug)
    expect(pkg['bin']).toEqual({ dimf: 'src/cli/dimf.ts', 'dim-factory': 'src/cli/dimf.ts' })
  })

  it('usage errors exit 2', () => {
    expect(main(['--nope'], { root: repo, log: () => undefined, err: () => undefined })).toBe(2)
  })
})
