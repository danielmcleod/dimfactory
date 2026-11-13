// Security pass, Electron fuses (electron-builder.yml
// electronFuses): no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS, no --inspect, cookies encrypted, the app only from its
// asar with the asar's integrity checked, the shared V8 snapshot, and no file:// extra privileges (since
// the renderer is served on app://, renderer-files.test.ts; earlier builds had grantFileProtocolExtraPrivileges
// on for loadFile). Every packaged app this OS built (scripts/release.mjs packagedApps: dist/win-unpacked, both macOS
// architectures, dist/linux-unpacked) carries the same wire. A missing app skips its check, except with
// REQUIRE_PACKAGED=1 (release.yml, after its build on each OS), where it fails.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostPlatform, packagedApps } from '../../../scripts/release.mjs'

/** The `electronFuses:` block of electron-builder.yml, as key → boolean. */
function configuredFuses(): Record<string, boolean> {
  const yml = readFileSync(resolve('electron-builder.yml'), 'utf8')
  const lines = yml.split(/\r?\n/)
  const start = lines.findIndex((l) => /^electronFuses:\s*$/.test(l))
  if (start === -1) throw new Error('electron-builder.yml has no electronFuses block')
  const out: Record<string, boolean> = {}
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const m = /^\s+([A-Za-z0-9]+):\s*(true|false)\s*$/.exec(line)
    if (m !== null) out[m[1] ?? ''] = m[2] === 'true'
  }
  return out
}

/** electron-builder's names → @electron/fuses' FuseV1Options index. */
const FUSE_INDEX: Readonly<Record<string, number>> = {
  runAsNode: 0,
  enableCookieEncryption: 1,
  enableNodeOptionsEnvironmentVariable: 2,
  enableNodeCliInspectArguments: 3,
  enableEmbeddedAsarIntegrityValidation: 4,
  onlyLoadAppFromAsar: 5,
  loadBrowserProcessSpecificV8Snapshot: 6,
  grantFileProtocolExtraPrivileges: 7,
}

const WANT: Readonly<Record<string, boolean>> = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  // Off since the renderer moved to app://; it was on while the renderer loaded over
  // file://.
  grantFileProtocolExtraPrivileges: false,
  resetAdHocDarwinSignature: true,
}

describe('electron-builder fuses', () => {
  it('flip every fuse that would let code in from outside the signed app', () => {
    expect(configuredFuses()).toEqual(WANT)
  })

  it('pack the app as an asar (what the integrity fuse checks)', () => {
    expect(readFileSync(resolve('electron-builder.yml'), 'utf8')).toMatch(/^asar:\s*true\s*$/m)
  })
})

const HOST = hostPlatform()
const APPS = HOST === null ? [] : packagedApps(HOST)
const REQUIRED = process.env['REQUIRE_PACKAGED'] === '1'

describe('the packaged apps', () => {
  it.runIf(REQUIRED)('are all there (REQUIRE_PACKAGED=1)', () => {
    expect(APPS.length).toBeGreaterThan(0)
    expect(APPS.filter((a) => !existsSync(resolve(a.path))).map((a) => a.path)).toEqual([])
  })

  for (const app of APPS) {
    it.skipIf(!REQUIRED && !existsSync(resolve(app.path)))(
      `${app.path} (${app.arch}) carries the configured fuse wire`,
      async () => {
        const fuses = (await import('@electron/fuses')) as unknown as {
          getCurrentFuseWire(p: string): Promise<Record<string, unknown>>
        }
        // A macOS .app: @electron/fuses reads its Electron Framework, where the wire is.
        const wire = await fuses.getCurrentFuseWire(resolve(app.path))
        const ENABLE = 49
        const DISABLE = 48
        for (const [name, index] of Object.entries(FUSE_INDEX)) {
          expect(wire[String(index)], name).toBe(WANT[name] === true ? ENABLE : DISABLE)
        }
      },
    )
  }
})
