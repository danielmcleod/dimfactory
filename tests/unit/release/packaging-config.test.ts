// electron-builder.yml against the pinned packaging (NSIS / dmg / deb with an AppArmor profile +
// AppImage), the installer.nsh CLSID and the release (docs/RELEASING.md): the targets and architectures, the
// artifact names scripts/release.mjs expects, no signing and no publishing in the file itself (scripts/release.mjs
// adds the ad hoc macOS signature, or real signing once its secrets are set), the licence and the third-party notices
// in every package, the AppArmor profile wired to the deb's install path, and the maintainer left a placeholder.
// The fuses have their own test (tests/unit/security/fuses.test.ts).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { builderConfig, expectedArtifacts, signingPlan } from '../../../scripts/release.mjs'
import { APP_ID } from '../../../src/main/constants.ts'
import { BRAND, LICENSE_COPYRIGHT } from '../../../src/shared/brand.ts'

const yml = readFileSync('electron-builder.yml', 'utf8')
const lines = yml.split(/\r?\n/)
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string
  productName: string
  version: string
  license?: string
  author?: { name: string }
  desktopName?: string
  build?: unknown
}

/** A top-level key's block (its own line and every indented line after it), comments dropped. */
function block(key: string): string {
  const start = lines.indexOf(`${key}:`)
  expect(start, key).toBeGreaterThanOrEqual(0)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    if (line.trim().startsWith('#')) continue
    out.push(line)
  }
  return out.join('\n')
}

/** `key: value` directly in a block (two-space indent). */
function value(text: string, key: string): string | undefined {
  return new RegExp(`^ {2}${key}: (.+)$`, 'm').exec(text)?.[1]
}

const topValue = (key: string): string | undefined => new RegExp(`^${key}: (.+)$`, 'm').exec(yml)?.[1]

/** electron-builder's artifact arch names (builder-util getArtifactArchName) for the targets used here. */
function archName(arch: string, ext: string): string {
  if (arch !== 'x64') return arch
  if (ext === 'deb') return 'amd64'
  if (ext === 'AppImage') return 'x86_64'
  return arch
}

function expand(pattern: string, version: string, arch: string, ext: string): string {
  return pattern
    .replaceAll('${productName}', pkg.productName)
    .replaceAll('${name}', pkg.name)
    .replaceAll('${version}', version)
    .replaceAll('${arch}', archName(arch, ext))
    .replaceAll('${ext}', ext)
}

describe('electron-builder.yml: what is built', () => {
  it('names the app as main does (the AUMID and bundle id) and the product as package.json', () => {
    expect(topValue('appId')).toBe(APP_ID)
    expect(topValue('productName')).toBe(pkg.productName)
    expect(pkg.productName).toBe('Dim Factory')
    expect(pkg.build).toBeUndefined()
  })

  it('names the authors as the copyright does, never a person (Windows CompanyName and Publisher)', () => {
    // Without an author the exe kept Electron's own CompanyName, "GitHub, Inc." (seen on a release build).
    expect(pkg.author).toEqual({ name: 'The Dim Factory authors' })
    expect(topValue('copyright')).toBe(`Copyright © 2026 ${pkg.author?.name ?? ''}`)
  })

  it('Windows: the NSIS installer for x64, per-user by default, with the installer.nsh include', () => {
    const win = block('win')
    expect(win).toMatch(/- target: nsis\n\s+arch: \[x64\]/)
    const nsis = block('nsis')
    expect(value(nsis, 'oneClick')).toBe('false')
    expect(value(nsis, 'perMachine')).toBe('false')
    expect(value(nsis, 'include')).toBe('build/installer.nsh')
    expect(existsSync('build/installer.nsh')).toBe(true)
  })

  it('macOS: a dmg for Apple silicon and one for Intel, hardened, notarization left to the release script', () => {
    const mac = block('mac')
    expect(mac).toMatch(/- target: dmg\n\s+arch: \[arm64, x64\]/)
    expect(value(mac, 'hardenedRuntime')).toBe('true')
    expect(value(mac, 'notarize')).toBe('false')
    expect(existsSync(value(mac, 'entitlements') ?? '')).toBe(true)
  })

  it('macOS without a Developer ID: the release build signs both apps ad hoc, unhardened, never notarized', () => {
    // identity "-" is electron-builder's explicit ad hoc signing (its mac.identity docs); null would skip signing,
    // and an arm64 app with no signature is killed at launch. One config covers both architectures.
    const mac = builderConfig({ plan: signingPlan('mac', {}), version: '1.0.0', env: {} })['mac']
    expect(mac).toEqual({ notarize: false, identity: '-', hardenedRuntime: false })
    // The fuses step re-signs ad hoc too, after flipping the fuses and before electron-builder's own signature.
    expect(yml).toMatch(/^ {2}resetAdHocDarwinSignature: true$/m)
  })

  it('Linux: the deb and the AppImage for x64', () => {
    const linux = block('linux')
    expect(linux).toMatch(/- target: deb\n\s+arch: \[x64\]/)
    expect(linux).toMatch(/- target: AppImage\n\s+arch: \[x64\]/)
    expect(value(linux, 'executableName')).toBe('dim-factory')
  })

  it('Linux: Electron desktop name is the .desktop file the packages install (app identity)', () => {
    // Electron 44 falls back to a slug of productName, which is dim-factory.desktop today; stating it keeps a product
    // rename from splitting the Wayland app_id and setBadgeCount's launcher entry from the installed file
    // (electron-builder warned about the missing desktopName on a release build).
    const linux = block('linux')
    expect(pkg.desktopName).toBe(`${value(linux, 'executableName') ?? ''}.desktop`)
    expect(value(linux, 'syncDesktopName')).toBe('true')
    expect(linux).toMatch(/desktop:\n\s+entry:\n\s+StartupWMClass: Dim Factory$/m)
  })

  it('the artifact names are the ones scripts/release.mjs releases', () => {
    const v = '1.0.0-rc.1'
    const named = (key: string, arch: string, ext: string): string =>
      expand(value(block(key), 'artifactName') ?? '(none)', v, arch, ext)
    expect([named('nsis', 'x64', 'exe')]).toEqual(expectedArtifacts('win', v).map((a) => a.name))
    expect([named('dmg', 'arm64', 'dmg'), named('dmg', 'x64', 'dmg')]).toEqual(
      expectedArtifacts('mac', v).map((a) => a.name),
    )
    expect([named('deb', 'x64', 'deb'), named('appImage', 'x64', 'AppImage')]).toEqual(
      expectedArtifacts('linux', v).map((a) => a.name),
    )
  })
})

describe('electron-builder.yml: no signing, no publishing, no person', () => {
  it('publishes nothing (release.yml makes the draft release)', () => {
    expect(topValue('publish')).toBe('null')
  })

  it('holds no signing settings: scripts/release.mjs adds them only when the secrets are set', () => {
    for (const key of [
      'azureSignOptions',
      'signtoolOptions',
      'certificateFile',
      'certificateSubjectName',
      'certificateSha1',
      'cscLink',
      'cscKeyPassword',
      'forceCodeSigning',
      'identity',
      'provisioningProfile',
    ])
      expect(yml, key).not.toMatch(new RegExp(`^\\s*${key}:`, 'm'))
    expect(yml).not.toMatch(/notarize: true/)
  })

  it('keeps the maintainer a placeholder on a reserved domain', () => {
    expect(value(block('linux'), 'maintainer')).toBe(
      'Dim Factory maintainers <maintainers@dimfactory.invalid>',
    )
    // The only addresses in the file are on .invalid.
    for (const m of yml.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) expect(m[1]).toMatch(/\.invalid$/)
  })
})

describe('the licence', () => {
  const extra = block('extraResources')

  it('is MIT, in LICENSE with the copyright line from src/shared/brand.ts, and in package.json', () => {
    const text = readFileSync('LICENSE', 'utf8')
    expect(text.split('\n')[0]).toBe('MIT License')
    expect(text).toContain(`\n${LICENSE_COPYRIGHT}\n`)
    expect(LICENSE_COPYRIGHT).toBe('Copyright (c) 2026 The Dim Factory authors')
    expect(text).toMatch(/Permission is hereby granted, free of charge/)
    expect(text).toMatch(/THE SOFTWARE IS PROVIDED "AS IS"/)
    expect(BRAND.license).toBe('MIT')
    expect(pkg.license).toBe('MIT')
    // The author stays (Windows CompanyName and Publisher).
    expect(pkg.author).toEqual({ name: BRAND.authors })
  })

  it('goes into every package with the third-party notices (<resources>/LICENSE, THIRD_PARTY_NOTICES.md)', () => {
    expect(extra).toMatch(/- from: LICENSE\n\s+to: LICENSE$/m)
    expect(extra).toMatch(/- from: THIRD_PARTY_NOTICES\.md\n\s+to: THIRD_PARTY_NOTICES\.md$/m)
    expect(existsSync('THIRD_PARTY_NOTICES.md')).toBe(true)
  })

  it('has no installer licence page: no nsis license key and no build/license file NSIS would pick up', () => {
    expect(value(block('nsis'), 'license')).toBeUndefined()
    expect(readdirSync('build').filter((f) => /^(license|eula)[._]/i.test(f))).toEqual([])
  })

  it('the notices list every bundled third-party file and say three.js is not bundled', () => {
    const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')
    const manifest = JSON.parse(readFileSync('src/core/templates/vendor/manifest.json', 'utf8')) as {
      entries: { origin: string; name: string; version?: string; license: string }[]
    }
    const thirdParty = manifest.entries.filter((e) => e.origin === 'third-party')
    expect(thirdParty.length).toBeGreaterThan(0)
    for (const e of thirdParty) {
      const row = notices.split('\n').find((l) => l.startsWith(`| ${e.name} `)) ?? ''
      expect(
        row.split('|').map((c) => c.trim()),
        e.name,
      ).toEqual(expect.arrayContaining([e.name, e.version ?? '', e.license]))
    }
    expect(notices).toMatch(/three\.js is not bundled/)
    // UI standards: no em dash in text people read.
    expect(notices).not.toContain(String.fromCodePoint(0x2014))
  })
})

describe('the deb AppArmor profile', () => {
  const deb = block('deb')
  const profileFile = value(deb, 'appArmorProfile') ?? ''
  const installPath = `/opt/${pkg.productName}/${value(block('linux'), 'executableName') ?? ''}`

  it('is wired, exists and attaches to the installed executable', () => {
    expect(profileFile).toBe('build/linux/apparmor-profile')
    const profile = readFileSync(profileFile, 'utf8')
    expect(profile).toMatch(/^abi <abi\/4\.0>,$/m)
    expect(profile).toContain(`profile dim-factory "${installPath}" flags=(unconfined) {`)
    expect(profile).toMatch(/^\s+userns,$/m)
    // electron-builder expands ${...} in the file; it has none to expand.
    expect(profile).not.toContain('${')
  })

  it('is installed and removed by the deb scripts from where electron-builder puts it', () => {
    expect(value(deb, 'afterInstall')).toBe('build/linux/after-install.sh')
    expect(value(deb, 'afterRemove')).toBe('build/linux/after-remove.sh')
    const install = readFileSync('build/linux/after-install.sh', 'utf8')
    const remove = readFileSync('build/linux/after-remove.sh', 'utf8')
    for (const script of [install, remove]) {
      expect(script).toContain(`INSTALL_DIR='/opt/${pkg.productName}'`)
      expect(script).toContain("EXECUTABLE='dim-factory'")
      expect(script).toContain('PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"')
    }
    // FpmTarget copies the profile to <resources>/apparmor-profile.
    expect(install).toContain('PROFILE_SOURCE="$INSTALL_DIR/resources/apparmor-profile"')
    expect(remove).toContain('apparmor_parser --remove "$PROFILE_TARGET"')
  })
})
