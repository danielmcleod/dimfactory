// scripts/release.mjs, the logic behind .github/workflows/release.yml (unsigned first, with Azure Artifact Signing and
// Developer ID + notarization dormant until their secrets are set; docs/RELEASING.md): which version a ref builds,
// when an OS signs (all of its secrets or none; a partial set is an error, never a silent unsigned build), what an
// unsigned OS means for the run (a notice on a tag; an error on a final tag only with REQUIRE_SIGNED_RELEASE; a notice
// on a dry run), the environment and settings electron-builder gets (an ad hoc signature on macOS without a Developer
// ID), the installer names and unpacked apps, the release notes from their template, and the release job's check of
// every file. All secret values here are fake.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allSecretNames,
  builderConfig,
  builderEnv,
  collectRelease,
  describeArtifacts,
  DRY_RUN_ENVIRONMENT,
  expectedArtifacts,
  fillTemplate,
  hostPlatform,
  main,
  packagedApps,
  parseSums,
  NOTES_TEMPLATE,
  parseVersion,
  readNotesTemplate,
  RELEASE_ENVIRONMENT,
  releaseNotes,
  ReleaseError,
  repositoryHomepage,
  REQUIRE_SIGNED_VAR,
  requireSigned,
  resolveRelease,
  SIGNING_SECRETS,
  signingPlan,
  signingVerdict,
  sumsText,
} from '../../../scripts/release.mjs'
import type { Env, ReleasePlatform, SigningPlan } from '../../../scripts/release.mjs'

// No test here may package anything: if a refusal the command line tests expect were missing, the build would reach
// electron-builder, which fails at once instead.
vi.mock('electron-builder', () => ({
  default: {
    build: () => Promise.reject(new Error('electron-builder must not run in a unit test')),
  },
}))

const fakeEnv = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, `fake-${n.toLowerCase()}`]))

const WIN_ALL = fakeEnv(SIGNING_SECRETS.win)
const MAC_CERT = fakeEnv(SIGNING_SECRETS.macCertificate)
const MAC_API = fakeEnv(SIGNING_SECRETS.macApiKey)
const MAC_APPLE_ID = fakeEnv(SIGNING_SECRETS.macAppleId)

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('versions', () => {
  it('parses X.Y.Z and X.Y.Z-pre, and nothing else', () => {
    expect(parseVersion('1.0.0')).toEqual({ base: '1.0.0', prerelease: null })
    expect(parseVersion('1.0.0-rc.1')).toEqual({ base: '1.0.0', prerelease: 'rc.1' })
    expect(parseVersion('1.0.0-alpha.1')).toEqual({ base: '1.0.0', prerelease: 'alpha.1' })
    for (const bad of ['v1.0.0', '1.0', '1.0.0+build.5', '01.0.0', '1.0.0-', '1.0.0-rc..1', '', 'latest'])
      expect(parseVersion(bad), bad).toBeNull()
  })

  it('a tag builds its own version when it carries package.json X.Y.Z, and is released', () => {
    expect(resolveRelease({ ref: 'refs/tags/v1.0.0', packageVersion: '1.0.0' })).toEqual({
      version: '1.0.0',
      base: '1.0.0',
      tag: 'v1.0.0',
      prerelease: false,
      release: true,
    })
    expect(resolveRelease({ ref: 'refs/tags/v1.0.0-rc.2', packageVersion: '1.0.0' })).toEqual({
      version: '1.0.0-rc.2',
      base: '1.0.0',
      tag: 'v1.0.0-rc.2',
      prerelease: true,
      release: true,
    })
  })

  it('a tag for another version, or not vX.Y.Z, fails before anything is built', () => {
    expect(() => resolveRelease({ ref: 'refs/tags/v1.0.1', packageVersion: '1.0.0' })).toThrow(
      /tag v1\.0\.1 does not match package\.json version 1\.0\.0/,
    )
    expect(() => resolveRelease({ ref: 'refs/tags/1.0.0', packageVersion: '1.0.0' })).toThrow(ReleaseError)
    expect(() => resolveRelease({ ref: 'refs/tags/v1.0', packageVersion: '1.0.0' })).toThrow(/not vX\.Y\.Z/)
    expect(() => resolveRelease({ ref: 'refs/tags/v1.0.0', packageVersion: 'two' })).toThrow(/package\.json/)
  })

  it('a branch (or no ref) is a dry run of package.json version: nothing released', () => {
    for (const ref of ['refs/heads/main', 'refs/heads/release-branch', '', undefined])
      expect(resolveRelease({ ref, packageVersion: '1.0.0' })).toEqual({
        version: '1.0.0',
        base: '1.0.0',
        tag: null,
        prerelease: false,
        release: false,
      })
  })

  it('package.json is the version the v1.0.0 tag needs', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(resolveRelease({ ref: 'refs/tags/v1.0.0', packageVersion: pkg.version }).version).toBe('1.0.0')
  })
})

describe('signing: all of an OS secrets, or none', () => {
  it('names every secret once, by OS', () => {
    const names = allSecretNames()
    expect(new Set(names).size).toBe(names.length)
    expect(SIGNING_SECRETS.win).toHaveLength(7)
    expect(names).toHaveLength(7 + 2 + 3 + 3)
  })

  it('nothing set builds unsigned on every OS', () => {
    for (const p of ['win', 'mac', 'linux'])
      expect(signingPlan(p, {})).toMatchObject({ platform: p, signed: false, notarization: null })
  })

  it('blank values count as not set', () => {
    const blank = Object.fromEntries(allSecretNames().map((n) => [n, '  ']))
    expect(signingPlan('win', blank).signed).toBe(false)
    expect(signingPlan('mac', blank).signed).toBe(false)
  })

  it('Windows signs with all seven Azure secrets', () => {
    expect(signingPlan('win', WIN_ALL)).toMatchObject({ signed: true, notarization: null })
  })

  it('a partial Windows set fails and names exactly what is missing', () => {
    const env: Record<string, string> = { ...WIN_ALL }
    delete env['AZURE_CLIENT_SECRET']
    delete env['AZURE_SIGNING_PUBLISHER']
    let message = ''
    try {
      signingPlan('win', env)
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseError)
      message = (err as Error).message
    }
    expect(message).toMatch(/AZURE_CLIENT_SECRET, AZURE_SIGNING_PUBLISHER are missing/)
    // Only names: never a value.
    for (const v of Object.values(WIN_ALL)) expect(message).not.toContain(v)
  })

  it('macOS signs with the certificate and an API key, or an Apple ID', () => {
    expect(signingPlan('mac', { ...MAC_CERT, ...MAC_API })).toMatchObject({
      signed: true,
      notarization: 'api-key',
    })
    expect(signingPlan('mac', { ...MAC_CERT, ...MAC_APPLE_ID })).toMatchObject({
      signed: true,
      notarization: 'apple-id',
    })
  })

  it('both notarization sets complete: the API key is used, and the notes say so', () => {
    const plan = signingPlan('mac', { ...MAC_CERT, ...MAC_API, ...MAC_APPLE_ID })
    expect(plan.notarization).toBe('api-key')
    expect(plan.notes.join(' ')).toMatch(/API key is used/)
  })

  it('macOS never signs without notarizing, nor notarizes unsigned, nor takes a half set', () => {
    expect(() => signingPlan('mac', MAC_CERT)).toThrow(/notarization needs APPLE_API_KEY_P8/)
    expect(() => signingPlan('mac', MAC_API)).toThrow(/MAC_CSC_LINK and MAC_CSC_KEY_PASSWORD/)
    expect(() => signingPlan('mac', { ...MAC_CERT, APPLE_ID: 'fake' })).toThrow(
      /APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID missing/,
    )
    // A complete API key does not excuse a half Apple ID set.
    expect(() => signingPlan('mac', { ...MAC_CERT, ...MAC_API, APPLE_TEAM_ID: 'fake' })).toThrow(ReleaseError)
    expect(() => signingPlan('mac', { MAC_CSC_LINK: 'fake' })).toThrow(/MAC_CSC_KEY_PASSWORD/)
  })

  it('Linux never signs, whatever is set', () => {
    const env = Object.fromEntries(allSecretNames().map((n) => [n, 'fake']))
    expect(signingPlan('linux', env)).toMatchObject({ signed: false, notarization: null })
  })

  it('an unknown OS is refused', () => {
    expect(() => signingPlan('freebsd', {})).toThrow(/unknown platform/)
  })
})

describe('unsigned first: signing is dormant until its secrets are set', () => {
  const MAC_ALL = { ...MAC_CERT, ...MAC_API }
  const REQUIRE = true

  it('a tag without an OS secrets builds unsigned with a notice that names the secrets, and only names', () => {
    for (const [tag, version] of [
      ['v1.0.0', '1.0.0'],
      ['v1.0.0-rc.1', '1.0.0-rc.1'],
    ] as const) {
      const win = signingVerdict({ plan: signingPlan('win', {}), tag, version })
      expect(win?.level, tag).toBe('notice')
      expect(win?.message.startsWith(`Windows signing skipped for ${tag}: `)).toBe(true)
      expect(win?.message).toMatch(/so this build is unsigned\./)
      for (const name of SIGNING_SECRETS.win) expect(win?.message, name).toContain(name)
      expect(win?.message).toContain(`"${RELEASE_ENVIRONMENT}" environment`)

      const mac = signingVerdict({ plan: signingPlan('mac', {}), tag, version })
      expect(mac?.level, tag).toBe('notice')
      expect(mac?.message).toMatch(/macOS signing skipped/)
      expect(mac?.message).toMatch(/ad hoc signed, not notarized/)
      for (const name of allSecretNames().filter((n) => !SIGNING_SECRETS.win.includes(n)))
        expect(mac?.message, name).toContain(name)
      for (const v of [...Object.values(WIN_ALL), ...Object.values(MAC_ALL)]) {
        expect(win?.message).not.toContain(v)
        expect(mac?.message).not.toContain(v)
      }
    }
  })

  it('REQUIRE_SIGNED_RELEASE=true: a final tag with an OS unsigned is an error naming the secrets', () => {
    expect(REQUIRE_SIGNED_VAR).toBe('REQUIRE_SIGNED_RELEASE')
    expect(requireSigned({})).toBe(false)
    expect(requireSigned({ REQUIRE_SIGNED_RELEASE: '' })).toBe(false)
    expect(requireSigned({ REQUIRE_SIGNED_RELEASE: 'false' })).toBe(false)
    expect(requireSigned({ REQUIRE_SIGNED_RELEASE: 'true' })).toBe(true)
    expect(requireSigned({ REQUIRE_SIGNED_RELEASE: ' TRUE ' })).toBe(true)

    const win = signingVerdict({
      plan: signingPlan('win', {}),
      tag: 'v1.0.0',
      version: '1.0.0',
      requireSigned: REQUIRE,
    })
    expect(win?.level).toBe('error')
    expect(win?.message).toMatch(/^v1\.0\.0 is a final release, and Windows would not be signed/)
    for (const name of SIGNING_SECRETS.win) expect(win?.message, name).toContain(name)
    expect(win?.message).toContain(REQUIRE_SIGNED_VAR)
    const mac = signingVerdict({
      plan: signingPlan('mac', {}),
      tag: 'v1.0.0',
      version: '1.0.0',
      requireSigned: REQUIRE,
    })
    expect(mac?.level).toBe('error')
    expect(mac?.message).toMatch(/macOS would not be signed/)
    // A pre-release tag may still build unsigned.
    expect(
      signingVerdict({
        plan: signingPlan('mac', {}),
        tag: 'v1.0.0-rc.1',
        version: '1.0.0-rc.1',
        requireSigned: REQUIRE,
      })?.level,
    ).toBe('notice')
  })

  it('a tag that signs, and Linux on any run, pass without a word', () => {
    for (const requireSigned of [false, true]) {
      expect(
        signingVerdict({ plan: signingPlan('win', WIN_ALL), tag: 'v1.0.0', version: '1.0.0', requireSigned }),
      ).toBeNull()
      expect(
        signingVerdict({ plan: signingPlan('mac', MAC_ALL), tag: 'v1.0.0', version: '1.0.0', requireSigned }),
      ).toBeNull()
      for (const tag of ['v1.0.0', 'v1.0.0-rc.1', ''])
        expect(
          signingVerdict({ plan: signingPlan('linux', {}), tag, version: '1.0.0', requireSigned }),
          tag,
        ).toBeNull()
    }
    expect(
      signingVerdict({ plan: signingPlan('win', WIN_ALL), tag: 'v1.0.0-rc.1', version: '1.0.0-rc.1' }),
    ).toBeNull()
  })

  it('a dry run builds unsigned (a notice); one that signed got secrets a branch should never reach (a warning)', () => {
    for (const tag of ['', null, undefined]) {
      const v = signingVerdict({ plan: signingPlan('win', {}), tag, version: '1.0.0' })
      expect(v, String(tag)).toEqual({
        level: 'notice',
        message: 'Windows is not signed in this dry run: only a v* tag run gets the signing secrets.',
      })
    }
    const leaked = signingVerdict({ plan: signingPlan('mac', MAC_ALL), tag: '', version: '1.0.0' })
    expect(leaked?.level).toBe('warning')
    expect(leaked?.message).toMatch(/reached a dry run/)
    expect(leaked?.message).toContain(`"${RELEASE_ENVIRONMENT}" environment only`)
  })

  it('the environments: the secrets live in one only a tag reaches; dry runs build in another', () => {
    expect(RELEASE_ENVIRONMENT).toBe('release')
    expect(DRY_RUN_ENVIRONMENT).toBe('release-dry-run')
  })

  it('UI standards: no em dash in any message', () => {
    const texts = [
      signingVerdict({ plan: signingPlan('win', {}), tag: 'v1.0.0', version: '1.0.0' }),
      signingVerdict({ plan: signingPlan('mac', {}), tag: 'v1.0.0', version: '1.0.0' }),
      signingVerdict({
        plan: signingPlan('win', {}),
        tag: 'v1.0.0',
        version: '1.0.0',
        requireSigned: REQUIRE,
      }),
      signingVerdict({
        plan: signingPlan('mac', {}),
        tag: 'v1.0.0',
        version: '1.0.0',
        requireSigned: REQUIRE,
      }),
      signingVerdict({ plan: signingPlan('mac', {}), tag: 'v1.0.0-rc.1', version: '1.0.0-rc.1' }),
      signingVerdict({ plan: signingPlan('mac', MAC_ALL), tag: '', version: '1.0.0' }),
      signingVerdict({ plan: signingPlan('win', {}), tag: '', version: '1.0.0' }),
    ].map((v) => v?.message ?? '')
    for (const t of texts) expect(t).not.toContain(String.fromCodePoint(0x2014))
  })
})

const plan = (platform: ReleasePlatform, env: Env): SigningPlan => signingPlan(platform, env)

describe('the environment electron-builder runs with', () => {
  const STRAY: Record<string, string> = {
    CSC_LINK: 'stray',
    CSC_KEY_PASSWORD: 'stray',
    WIN_CSC_LINK: 'stray',
    APPLE_ID: 'stray',
    APPLE_API_KEY: 'stray',
    APPLE_KEYCHAIN_PROFILE: 'stray',
  }

  it('unsigned: no certificate discovery and every signing variable cleared', () => {
    for (const p of ['win', 'mac', 'linux'] as const) {
      const { set, unset } = builderEnv(plan(p, {}), STRAY)
      expect(set).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
      for (const n of Object.keys(STRAY)) expect(unset, `${p} ${n}`).toContain(n)
    }
    // An unsigned Windows build also drops the Azure credential.
    expect(builderEnv(plan('win', {}), {}).unset).toEqual(
      expect.arrayContaining(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']),
    )
  })

  it('Windows signed: the Azure credential stays, nothing else signs', () => {
    const { set, unset } = builderEnv(plan('win', WIN_ALL), { ...WIN_ALL, ...STRAY })
    expect(set).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    expect(unset).toEqual(expect.arrayContaining(['CSC_LINK', 'WIN_CSC_LINK', 'APPLE_ID']))
    expect(unset).not.toContain('AZURE_TENANT_ID')
    expect(unset).not.toContain('AZURE_CLIENT_SECRET')
  })

  it('macOS with an API key: the certificate under electron-builder names, the key as a file path', () => {
    const env = { ...MAC_CERT, ...MAC_API, ...MAC_APPLE_ID }
    const { set, unset } = builderEnv(plan('mac', env), env, '/tmp/AuthKey_X.p8')
    expect(set).toEqual({
      CSC_LINK: MAC_CERT['MAC_CSC_LINK'],
      CSC_KEY_PASSWORD: MAC_CERT['MAC_CSC_KEY_PASSWORD'],
      APPLE_API_KEY: '/tmp/AuthKey_X.p8',
      APPLE_API_KEY_ID: MAC_API['APPLE_API_KEY_ID'],
      APPLE_API_ISSUER: MAC_API['APPLE_API_ISSUER'],
    })
    // electron-builder prefers an Apple ID when one is set, so the unused set is cleared.
    expect(unset).toEqual(
      expect.arrayContaining([
        'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_TEAM_ID',
        'CSC_IDENTITY_AUTO_DISCOVERY',
      ]),
    )
  })

  it('macOS with an Apple ID', () => {
    const env = { ...MAC_CERT, ...MAC_APPLE_ID }
    const { set, unset } = builderEnv(plan('mac', env), env)
    expect(set).toEqual({
      CSC_LINK: MAC_CERT['MAC_CSC_LINK'],
      CSC_KEY_PASSWORD: MAC_CERT['MAC_CSC_KEY_PASSWORD'],
      APPLE_ID: MAC_APPLE_ID['APPLE_ID'],
      APPLE_APP_SPECIFIC_PASSWORD: MAC_APPLE_ID['APPLE_APP_SPECIFIC_PASSWORD'],
      APPLE_TEAM_ID: MAC_APPLE_ID['APPLE_TEAM_ID'],
    })
    expect(unset).toEqual(expect.arrayContaining(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']))
  })

  it('an API key plan without the written key file is refused', () => {
    const env = { ...MAC_CERT, ...MAC_API }
    expect(() => builderEnv(plan('mac', env), env)).toThrow(ReleaseError)
  })
})

describe('the settings layered over electron-builder.yml', () => {
  it('unsigned: the version, a numeric build version, no signing options', () => {
    expect(builderConfig({ plan: plan('win', {}), version: '1.0.0', env: {} })).toEqual({
      extraMetadata: { version: '1.0.0' },
      buildVersion: '1.0.0',
      forceCodeSigning: false,
    })
    expect(builderConfig({ plan: plan('mac', {}), version: '1.0.0-rc.1', env: {} })).toEqual({
      extraMetadata: { version: '1.0.0-rc.1' },
      buildVersion: '1.0.0',
      forceCodeSigning: false,
      // Ad hoc: electron-builder's explicit ad hoc identity, without the hardened runtime, never notarized.
      mac: { notarize: false, identity: '-', hardenedRuntime: false },
    })
  })

  it('Windows signed: azureSignOptions from the secrets, and the build fails if it does not sign', () => {
    const env = { ...WIN_ALL, AZURE_SIGNING_ENDPOINT: ' https://eus.codesigning.azure.net/ ' }
    expect(builderConfig({ plan: plan('win', env), version: '1.0.0', env })).toEqual({
      extraMetadata: { version: '1.0.0' },
      buildVersion: '1.0.0',
      forceCodeSigning: true,
      win: {
        azureSignOptions: {
          endpoint: 'https://eus.codesigning.azure.net/',
          codeSigningAccountName: WIN_ALL['AZURE_SIGNING_ACCOUNT'],
          certificateProfileName: WIN_ALL['AZURE_SIGNING_CERT_PROFILE'],
          publisherName: WIN_ALL['AZURE_SIGNING_PUBLISHER'],
        },
      },
    })
  })

  it('macOS signed: notarization on, signing forced', () => {
    const env = { ...MAC_CERT, ...MAC_API }
    expect(builderConfig({ plan: plan('mac', env), version: '1.0.0', env })).toMatchObject({
      forceCodeSigning: true,
      mac: { notarize: true },
    })
  })

  it('Linux: the deb needs a homepage, which the repository gives', () => {
    expect(() => builderConfig({ plan: plan('linux', {}), version: '1.0.0', env: {} })).toThrow(/homepage/)
    const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'someone/dim-factory' }
    expect(repositoryHomepage(env)).toBe('https://github.com/someone/dim-factory')
    expect(repositoryHomepage({})).toBeNull()
    expect(
      builderConfig({ plan: plan('linux', {}), version: '1.0.0', env, homepage: repositoryHomepage(env) }),
    ).toEqual({
      extraMetadata: { version: '1.0.0', homepage: 'https://github.com/someone/dim-factory' },
      buildVersion: '1.0.0',
      forceCodeSigning: false,
    })
  })

  it('refuses a version that is not semver', () => {
    expect(() => builderConfig({ plan: plan('win', {}), version: 'v1.0.0', env: {} })).toThrow(ReleaseError)
  })
})

describe('installers and checksums', () => {
  it('names each OS installers', () => {
    expect(expectedArtifacts('win', '1.0.0').map((a) => a.name)).toEqual(['dim-factory-setup-1.0.0.exe'])
    expect(expectedArtifacts('mac', '1.0.0').map((a) => a.name)).toEqual([
      'dim-factory-1.0.0-arm64.dmg',
      'dim-factory-1.0.0-x64.dmg',
    ])
    expect(expectedArtifacts('linux', '1.0.0-rc.1').map((a) => a.name)).toEqual([
      'dim-factory_1.0.0-rc.1_amd64.deb',
      'dim-factory-1.0.0-rc.1-x86_64.AppImage',
    ])
    expect(() => expectedArtifacts('beos', '1.0.0')).toThrow(/unknown platform/)
  })

  it('names each OS unpacked apps, one per architecture (what the signature and fuse checks read)', () => {
    expect(packagedApps('win')).toEqual([{ arch: 'x64', path: 'dist/win-unpacked/Dim Factory.exe' }])
    expect(packagedApps('mac')).toEqual([
      { arch: 'arm64', path: 'dist/mac-arm64/Dim Factory.app' },
      { arch: 'x64', path: 'dist/mac/Dim Factory.app' },
    ])
    expect(packagedApps('linux')).toEqual([{ arch: 'x64', path: 'dist/linux-unpacked/dim-factory' }])
    expect(() => packagedApps('beos')).toThrow(/unknown platform/)
    // One app per installer architecture.
    for (const p of ['win', 'mac'] as const)
      expect(
        packagedApps(p).map((a) => a.arch),
        p,
      ).toEqual(expectedArtifacts(p, '1.0.0').map((a) => (a.name.includes('-arm64.') ? 'arm64' : 'x64')))
    expect(hostPlatform('win32')).toBe('win')
    expect(hostPlatform('darwin')).toBe('mac')
    expect(hostPlatform('linux')).toBe('linux')
    expect(hostPlatform('aix')).toBeNull()
  })

  it('writes sha256sum text, sorted by name, that parses back', () => {
    const files = [
      { name: 'b.dmg', sha256: sha('b') },
      { name: 'a.exe', sha256: sha('a') },
    ]
    const text = sumsText(files)
    expect(text).toBe(`${sha('a')}  a.exe\n${sha('b')}  b.dmg\n`)
    expect(parseSums(text)).toEqual([...files].reverse())
    expect(parseSums(`${sha('c')} *c.deb\r\n\n`)).toEqual([{ name: 'c.deb', sha256: sha('c') }])
    expect(() => parseSums('nonsense')).toThrow(ReleaseError)
  })
})

describe('the release job check (collect)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dim-factory-release-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Writes fake installers for one OS plus its manifest and sums, as `build` leaves them. */
  async function fakeBuild(platform: ReleasePlatform, version: string, env: Env = {}): Promise<void> {
    for (const a of expectedArtifacts(platform, version)) writeFileSync(join(dir, a.name), `fake ${a.name}`)
    const m = await describeArtifacts({
      dir,
      platform,
      version,
      plan: signingPlan(platform, env),
      commit: 'abc1234',
    })
    writeFileSync(join(dir, `release-${platform}.json`), JSON.stringify(m))
    writeFileSync(join(dir, `SHA256SUMS-${platform}.txt`), sumsText(m.files))
  }

  /** Every OS; Windows and macOS signed unless `unsigned` names them. */
  async function fakeAll(version = '1.0.0', unsigned: ReleasePlatform[] = []): Promise<void> {
    await fakeBuild('win', version, unsigned.includes('win') ? {} : WIN_ALL)
    await fakeBuild('mac', version, unsigned.includes('mac') ? {} : { ...MAC_CERT, ...MAC_API })
    await fakeBuild('linux', version)
  }

  it('describes what was built: version, signing, size and SHA-256 per file', async () => {
    await fakeBuild('win', '1.0.0', WIN_ALL)
    const m = JSON.parse(readFileSync(join(dir, 'release-win.json'), 'utf8')) as Record<string, unknown>
    expect(m).toEqual({
      schemaVersion: 1,
      platform: 'win',
      version: '1.0.0',
      signed: true,
      signing: 'azure-artifact-signing',
      notarization: null,
      commit: 'abc1234',
      files: [
        {
          name: 'dim-factory-setup-1.0.0.exe',
          bytes: 'fake dim-factory-setup-1.0.0.exe'.length,
          sha256: sha('fake dim-factory-setup-1.0.0.exe'),
        },
      ],
    })
  })

  it('a missing installer fails the description', async () => {
    await expect(
      describeArtifacts({ dir, platform: 'mac', version: '1.0.0', plan: signingPlan('mac', {}) }),
    ).rejects.toThrow(/dim-factory-1\.0\.0-arm64\.dmg was not built/)
  })

  it('combines every OS into one SHA256SUMS, lists the files to attach, and writes the notes', async () => {
    await fakeAll()
    const r = await collectRelease({
      dir,
      version: '1.0.0',
      commit: 'abc1234',
      runUrl: 'https://example.invalid/run/1',
    })
    const names = [
      'dim-factory-1.0.0-arm64.dmg',
      'dim-factory-1.0.0-x64.dmg',
      'dim-factory-1.0.0-x86_64.AppImage',
      'dim-factory-setup-1.0.0.exe',
      'dim-factory_1.0.0_amd64.deb',
    ]
    expect(parseSums(r.sums).map((e) => e.name)).toEqual(names)
    for (const e of parseSums(r.sums)) expect(e.sha256).toBe(sha(`fake ${e.name}`))
    expect(r.files).toEqual([...names, 'SHA256SUMS'])
    expect(r.notes).toContain('| `dim-factory-setup-1.0.0.exe` | Windows 10 and 11, x64 |')
    expect(r.notes).toContain('Azure Artifact Signing')
    // The dmg itself is not signed; the app inside it is.
    expect(r.notes).toContain(
      '| `dim-factory-1.0.0-arm64.dmg` | macOS, Apple silicon | 0.0 MB | The app inside: Developer ID, notarized and stapled |',
    )
    expect(r.notes).not.toMatch(/not signed in this build/)
    expect(r.notes).toContain('Built from `abc1234` by https://example.invalid/run/1.')
  })

  it('an unsigned final version is attached by default; with REQUIRE_SIGNED_RELEASE only signed ones are', async () => {
    await fakeAll('1.0.0', ['win', 'mac'])
    const r = await collectRelease({ dir, version: '1.0.0' })
    expect(r.notes).toMatch(/Windows and macOS are not signed in this build/)
    expect(r.manifests.find((m) => m.platform === 'mac')?.signing).toBe('ad-hoc')
    expect(r.notes).toContain(
      '| `dim-factory-1.0.0-arm64.dmg` | macOS, Apple silicon | 0.0 MB | Ad hoc signed, not notarized |',
    )

    await fakeAll('1.0.0', ['mac'])
    await expect(collectRelease({ dir, version: '1.0.0', requireSigned: true })).rejects.toThrow(
      /1\.0\.0 is a final release, but the macOS build is not signed/,
    )
    await fakeAll('1.0.0', ['win'])
    await expect(collectRelease({ dir, version: '1.0.0', requireSigned: true })).rejects.toThrow(
      /the Windows build is not signed/,
    )
    // Linux alone is never signed and needs nothing.
    await expect(
      collectRelease({ dir, version: '1.0.0', platforms: ['linux'], requireSigned: true }),
    ).resolves.toBeDefined()

    await fakeAll('1.0.0-rc.1', ['win', 'mac'])
    const rc = await collectRelease({ dir, version: '1.0.0-rc.1', requireSigned: true })
    expect(rc.notes).toMatch(/Windows and macOS are not signed in this build/)
  })

  it('fails on a changed byte, a missing OS, another version, or sums that disagree', async () => {
    await fakeAll()
    writeFileSync(join(dir, 'dim-factory-1.0.0-x64.dmg'), 'fake dim-factory-1.0.0-x64.dmG')
    await expect(collectRelease({ dir, version: '1.0.0' })).rejects.toThrow(
      /dim-factory-1\.0\.0-x64\.dmg does not match the SHA-256/,
    )
    writeFileSync(join(dir, 'dim-factory-1.0.0-x64.dmg'), 'fake dim-factory-1.0.0-x64.dmg')
    await expect(collectRelease({ dir, version: '1.0.0' })).resolves.toBeDefined()

    writeFileSync(join(dir, 'dim-factory-1.0.0-x64.dmg'), 'short')
    await expect(collectRelease({ dir, version: '1.0.0' })).rejects.toThrow(/is 5 bytes/)
    writeFileSync(join(dir, 'dim-factory-1.0.0-x64.dmg'), 'fake dim-factory-1.0.0-x64.dmg')

    await expect(collectRelease({ dir, version: '1.0.1' })).rejects.toThrow(
      /version 1\.0\.0, this release is 1\.0\.1/,
    )

    writeFileSync(join(dir, 'SHA256SUMS-linux.txt'), '')
    await expect(collectRelease({ dir, version: '1.0.0' })).rejects.toThrow(
      /SHA256SUMS-linux\.txt does not agree/,
    )

    rmSync(join(dir, 'release-mac.json'))
    await expect(collectRelease({ dir, version: '1.0.0' })).rejects.toThrow(/release-mac\.json is missing/)
  })

  it('the notes call a pre-release one and name every unsigned OS', () => {
    const m = (platform: ReleasePlatform, signed: boolean) => ({
      schemaVersion: 1 as const,
      platform,
      version: '1.0.0-rc.1',
      signed,
      signing: null,
      notarization: null,
      commit: null,
      files: expectedArtifacts(platform, '1.0.0-rc.1').map((a) => ({
        name: a.name,
        bytes: 1_234_567,
        sha256: sha(a.name),
      })),
    })
    const notes = releaseNotes({
      version: '1.0.0-rc.1',
      manifests: [m('win', false), m('mac', false), m('linux', false)],
    })
    expect(notes.startsWith('Dim Factory 1.0.0-rc.1 (pre-release).')).toBe(true)
    expect(notes).toMatch(/Windows and macOS are not signed in this build/)
    expect(notes).toContain('| 1.2 MB |')
    expect(notes).toContain('Checksum only')
    // UI standards: no em dash in text people read.
    expect(notes).not.toContain(String.fromCodePoint(0x2014))
  })
})

describe('the release notes template', () => {
  const template = readNotesTemplate()
  const manifest = (platform: ReleasePlatform, signed: boolean) => ({
    schemaVersion: 1 as const,
    platform,
    version: '1.0.0',
    signed,
    signing: null,
    notarization: null,
    commit: null,
    files: expectedArtifacts(platform, '1.0.0').map((a) => ({ name: a.name, bytes: 1, sha256: sha(a.name) })),
  })
  const notesFor = (signed: boolean): string =>
    releaseNotes({
      version: '1.0.0',
      manifests: [manifest('win', signed), manifest('mac', signed), manifest('linux', false)],
      template,
    })

  it('is the file release.yml checks out, with no em dash and no unfilled placeholder left in the notes', () => {
    expect(NOTES_TEMPLATE).toBe('.github/release-notes.md')
    expect(template).toBe(readFileSync(NOTES_TEMPLATE, 'utf8'))
    // UI standards: no em dash, in the template or in what it becomes.
    expect(template).not.toContain(String.fromCodePoint(0x2014))
    for (const signed of [false, true]) {
      const notes = notesFor(signed)
      expect(notes).not.toContain(String.fromCodePoint(0x2014))
      expect(notes).not.toMatch(/\{\{|\}\}/)
      expect(notes).not.toMatch(/\n{3,}/)
    }
  })

  it('unsigned: the first-launch steps for Windows and macOS, and the checksum commands for every OS', () => {
    const notes = notesFor(false)
    expect(notes).toMatch(/"Windows protected your PC", click \*\*More info\*\*, then \*\*Run anyway\*\*/)
    expect(notes).toContain('Get-FileHash .\\dim-factory-setup-1.0.0.exe -Algorithm SHA256')
    expect(notes).toMatch(/drag Dim Factory to Applications/)
    expect(notes).toMatch(/Privacy & Security[\s\S]{0,120}\*\*Open\s+Anyway\*\*[\s\S]{0,40}password/)
    expect(notes).toContain('shasum -a 256')
    expect(notes).toMatch(/Homebrew's main cask list does not accept/)
    expect(notes).toContain('sudo apt install ./dim-factory_1.0.0_amd64.deb')
    expect(notes).toContain('chmod +x dim-factory-1.0.0-x86_64.AppImage')
    expect(notes).toContain('sha256sum -c SHA256SUMS')
  })

  it('signed: the unsigned-only steps are left out', () => {
    const notes = notesFor(true)
    expect(notes).toMatch(/Windows and macOS are signed in this build\./)
    expect(notes).not.toMatch(/Run anyway|Open\s+Anyway|Homebrew/)
    expect(notes).toContain('Get-FileHash')
  })

  it('fills values and conditional blocks, and refuses a name it does not know', () => {
    const text = 'a {{x}}\n{{#if on}}\nkept\n{{/if}}\n{{#if off}}\ngone\n{{/if}}\nend\n'
    expect(fillTemplate(text, { x: '1' }, { on: true, off: false })).toBe('a 1\nkept\nend\n')
    expect(() => fillTemplate('{{nope}}', {}, {})).toThrow(/unknown placeholder "nope"/)
    expect(() => fillTemplate('{{#if nope}}\nx\n{{/if}}\n', {}, {})).toThrow(/unknown condition "nope"/)
    expect(() => fillTemplate('{{ x }}', { x: '1' }, {})).toThrow(/left over/)
  })
})

describe('the command line', () => {
  let out = ''
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'dim-factory-release-cli-'))
    saved = { GITHUB_OUTPUT: process.env['GITHUB_OUTPUT'], GITHUB_ACTIONS: process.env['GITHUB_ACTIONS'] }
    process.env['GITHUB_OUTPUT'] = join(out, 'output.txt')
    delete process.env['GITHUB_ACTIONS']
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.restoreAllMocks()
    rmSync(out, { recursive: true, force: true })
  })

  it('version writes the step outputs the workflow reads', async () => {
    expect(await main(['version', '--ref', 'refs/tags/v1.0.0'])).toBe(0)
    expect(readFileSync(join(out, 'output.txt'), 'utf8')).toBe(
      'version=1.0.0\ntag=v1.0.0\nprerelease=false\nrelease=true\n',
    )
  })

  it('build refuses another OS (a release builds each OS on its own runner)', async () => {
    const other = process.platform === 'win32' ? 'mac' : 'win'
    await expect(main(['build', '--platform', other, '--version', '1.0.0'])).rejects.toThrow(
      /builds only on its own OS/,
    )
  })

  it('unknown commands and missing options are usage errors', async () => {
    await expect(main(['publish'])).rejects.toThrow(/unknown command/)
    await expect(main(['collect', '--version', '1.0.0'])).rejects.toThrow(/--dir/)
  })

  it('build takes only the tag of its own version', async () => {
    const host = hostPlatform() ?? 'linux'
    await expect(
      main(['build', '--platform', host, '--version', '1.0.0', '--tag', 'v1.0.1']),
    ).rejects.toThrow(/--tag v1\.0\.1 is not v1\.0\.0/)
  })

  // Linux never signs, so only a Windows or macOS host can show the refusal (it comes before anything is built).
  it.skipIf(hostPlatform() === 'linux' || hostPlatform() === null)(
    'with REQUIRE_SIGNED_RELEASE, build refuses a final tag this OS would ship unsigned, before building anything',
    async () => {
      const host = hostPlatform() ?? 'win'
      const names = allSecretNames()
      const kept = Object.fromEntries([...names, REQUIRE_SIGNED_VAR].map((n) => [n, process.env[n]]))
      for (const n of names) delete process.env[n]
      // Only with REQUIRE_SIGNED_RELEASE does a final tag refuse to build unsigned.
      process.env[REQUIRE_SIGNED_VAR] = 'true'
      try {
        await expect(
          main(['build', '--platform', host, '--version', '1.0.0', '--tag', 'v1.0.0']),
        ).rejects.toThrow(/is a final release, and (Windows|macOS) would not be signed/)
      } finally {
        for (const [n, v] of Object.entries(kept)) {
          if (v === undefined) delete process.env[n]
          else process.env[n] = v
        }
      }
    },
  )
})
