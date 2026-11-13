#!/usr/bin/env node
// Release builds for .github/workflows/release.yml (docs/RELEASING.md): unsigned first (Windows unsigned, macOS ad hoc
// signed, Linux with SHA256SUMS + AppArmor), with Azure Artifact Signing and Developer ID + notarization dormant until
// their secrets are set. The workflow stays thin: what it decides lives here, with unit tests in
// tests/unit/release/.
//
//   node scripts/release.mjs version [--ref <git ref>]
//       The version to build. A tag vX.Y.Z or vX.Y.Z-pre must carry package.json's X.Y.Z (bump package.json first);
//       it is released as a draft. Any other ref (a branch) builds package.json's version and releases nothing (a dry
//       run). Prints the result as JSON and writes version, tag, prerelease and release to $GITHUB_OUTPUT when set.
//   node scripts/release.mjs build --platform <win|mac|linux> --version <v> [--tag <vX.Y.Z[-pre]>] [--homepage <url>]
//       electron-builder for this machine's OS (never another's), after `pnpm build`. It signs only when every secret
//       that OS needs is set: none set builds unsigned (macOS: ad hoc), some set is an error naming the missing ones.
//       `--tag` is the tag this build releases (empty or left out for a dry run). An unsigned tag build is logged and
//       goes on, unless the repository variable REQUIRE_SIGNED_RELEASE is "true": then a final tag (no -pre) must sign
//       Windows and macOS, and an unsigned one is an error before anything is built (signingVerdict). The installers
//       then move to
//       dist/release/, next to release-<platform>.json (version, signing, size and SHA-256 of each) and
//       SHA256SUMS-<platform>.txt. Writes signed and notarized to $GITHUB_OUTPUT when set.
//   node scripts/release.mjs collect --dir <folder> --version <v> [--platforms win,mac,linux]
//       The release job, over every OS's downloaded files: checks each installer against its OS's manifest (name,
//       size, SHA-256) and, for a final version with REQUIRE_SIGNED_RELEASE set, that Windows and macOS were signed,
//       then writes SHA256SUMS (every installer), notes.md (the draft's text, from .github/release-notes.md) and
//       files.txt (what to attach) into the folder.
//
// Secrets are read from the environment by the names in SIGNING_SECRETS (the GitHub secret names, documented in
// docs/RELEASING.md). They are secrets of the RELEASE_ENVIRONMENT, which only a v* tag run reaches. No value is ever
// printed; only names.
// Exit: 0 done · 1 failed (the message says why) · 2 usage
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BRAND } from '../src/shared/brand.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PLATFORMS = /** @type {const} */ (['win', 'mac', 'linux'])
const HOST_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' }

/** A failure the user can act on: printed as a one-line message, exit 1. */
export class ReleaseError extends Error {}

/**
 * Every secret the release reads, by OS. These are the GitHub secret names; release.yml passes each to the build step
 * under the same name, and docs/RELEASING.md documents each one.
 */
export const SIGNING_SECRETS = Object.freeze({
  /** Azure Artifact Signing (formerly Trusted Signing). All seven, or none. */
  win: Object.freeze([
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_SIGNING_ENDPOINT',
    'AZURE_SIGNING_ACCOUNT',
    'AZURE_SIGNING_CERT_PROFILE',
    'AZURE_SIGNING_PUBLISHER',
  ]),
  /** The Developer ID Application certificate: a base64 .p12 and its password. */
  macCertificate: Object.freeze(['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD']),
  /** Notarization with an App Store Connect API key (preferred when both sets are complete). */
  macApiKey: Object.freeze(['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']),
  /** Notarization with an Apple ID and an app-specific password. */
  macAppleId: Object.freeze(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']),
})

/** Every name in SIGNING_SECRETS, in order. */
export function allSecretNames() {
  return Object.values(SIGNING_SECRETS).flat()
}

/**
 * The GitHub environment that holds the signing secrets. Its deployment rule admits only `v*` tags, so a tag run's
 * build job (which runs in it) can sign and nothing else can reach them: a branch run builds in DRY_RUN_ENVIRONMENT,
 * which holds no secrets (docs/RELEASING.md "Secrets").
 */
export const RELEASE_ENVIRONMENT = 'release'
/** Where a dry run (a manual run on a branch) builds: no secrets, so unsigned. GitHub creates it on first use. */
export const DRY_RUN_ENVIRONMENT = 'release-dry-run'

/**
 * The repository variable (release.yml passes `vars.REQUIRE_SIGNED_RELEASE` under this name) that makes a final tag
 * refuse to ship an unsigned Windows or macOS build. Unset, every release may be unsigned (docs/RELEASING.md
 * "Turning on signing").
 */
export const REQUIRE_SIGNED_VAR = 'REQUIRE_SIGNED_RELEASE'

/** Whether the environment asks final releases to be signed (`REQUIRE_SIGNED_RELEASE=true`). */
export function requireSigned(env) {
  return (
    typeof env[REQUIRE_SIGNED_VAR] === 'string' && env[REQUIRE_SIGNED_VAR].trim().toLowerCase() === 'true'
  )
}

/** The template release.yml's draft notes are made from (releaseNotes fills it). */
export const NOTES_TEMPLATE = '.github/release-notes.md'

const PLATFORM_TITLE = { win: 'Windows', mac: 'macOS', linux: 'Linux' }

// ---- versions ---------------------------------------------------------------------------------------------------

const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?$`)

/** `X.Y.Z` or `X.Y.Z-pre` (no build metadata), or null. */
export function parseVersion(text) {
  const m = SEMVER.exec(String(text))
  if (m === null) return null
  return { base: `${m[1]}.${m[2]}.${m[3]}`, prerelease: m[4] ?? null }
}

/**
 * What a workflow run builds. A tag must be v<version> whose X.Y.Z is package.json's; anything else is a dry run of
 * package.json's version.
 */
export function resolveRelease({ ref, packageVersion }) {
  const pkg = parseVersion(packageVersion)
  if (pkg === null)
    throw new ReleaseError(`package.json version "${packageVersion}" is not X.Y.Z or X.Y.Z-pre`)
  const tagRef =
    typeof ref === 'string' && ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : null
  if (tagRef === null) {
    return {
      version: packageVersion,
      base: pkg.base,
      tag: null,
      prerelease: pkg.prerelease !== null,
      release: false,
    }
  }
  const version = tagRef.startsWith('v') ? tagRef.slice(1) : ''
  const parsed = parseVersion(version)
  if (parsed === null) throw new ReleaseError(`tag ${tagRef} is not vX.Y.Z or vX.Y.Z-pre`)
  if (parsed.base !== pkg.base)
    throw new ReleaseError(
      `tag ${tagRef} does not match package.json version ${packageVersion}: set package.json to ${parsed.base} ` +
        'in the tagged commit, or tag that version',
    )
  return { version, base: parsed.base, tag: tagRef, prerelease: parsed.prerelease !== null, release: true }
}

// ---- signing ----------------------------------------------------------------------------------------------------

const isSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== ''
const missingOf = (env, names) => names.filter((n) => !isSet(env, n))

/**
 * Whether this OS's build signs, from which secrets are set. All or nothing per OS: a partial set is a mistake to
 * fix, never a silent unsigned build.
 * @returns {{ platform: string, signed: boolean, notarization: 'api-key' | 'apple-id' | null, notes: string[] }}
 */
export function signingPlan(platform, env) {
  if (platform === 'linux')
    return {
      platform,
      signed: false,
      notarization: null,
      notes: ['Linux packages are not signed (SHA256SUMS).'],
    }
  if (platform === 'win') {
    const names = SIGNING_SECRETS.win
    const missing = missingOf(env, names)
    if (missing.length === names.length)
      return { platform, signed: false, notarization: null, notes: ['No Windows signing secrets are set.'] }
    if (missing.length > 0)
      throw new ReleaseError(
        `Windows signing is half set up: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing ` +
          '(set every Azure secret, or none for an unsigned build)',
      )
    return { platform, signed: true, notarization: null, notes: ['Windows: Azure Artifact Signing.'] }
  }
  if (platform !== 'mac') throw new ReleaseError(`unknown platform "${platform}" (win, mac or linux)`)
  const cert = SIGNING_SECRETS.macCertificate
  const sets = { 'api-key': SIGNING_SECRETS.macApiKey, 'apple-id': SIGNING_SECRETS.macAppleId }
  const certMissing = missingOf(env, cert)
  const complete = []
  const partial = []
  for (const [kind, names] of Object.entries(sets)) {
    const missing = missingOf(env, names)
    if (missing.length === 0) complete.push(kind)
    else if (missing.length < names.length) partial.push(missing)
  }
  if (certMissing.length === cert.length && complete.length === 0 && partial.length === 0)
    return { platform, signed: false, notarization: null, notes: ['No macOS signing secrets are set.'] }
  const problems = []
  if (certMissing.length > 0) problems.push(`the Developer ID certificate needs ${certMissing.join(' and ')}`)
  for (const missing of partial) problems.push(`notarization is half set up (${missing.join(', ')} missing)`)
  if (complete.length === 0 && partial.length === 0)
    problems.push(
      `notarization needs ${SIGNING_SECRETS.macApiKey.join(', ')}, or ${SIGNING_SECRETS.macAppleId.join(', ')}`,
    )
  if (problems.length > 0)
    throw new ReleaseError(
      `macOS signing is half set up: ${problems.join('; ')} (set the certificate and one notarization set, or none ` +
        'for an unsigned build)',
    )
  const notarization = complete.includes('api-key') ? 'api-key' : 'apple-id'
  const notes = [
    `macOS: Developer ID, notarized with ${notarization === 'api-key' ? 'an API key' : 'an Apple ID'}.`,
  ]
  if (complete.length === 2) notes.push('Both notarization sets are complete; the API key is used.')
  return { platform, signed: true, notarization, notes }
}

/** The secrets an OS signs with, as a sentence. */
function secretsToSign(platform) {
  if (platform === 'win') return SIGNING_SECRETS.win.join(', ')
  return (
    `${SIGNING_SECRETS.macCertificate.join(', ')}, with ${SIGNING_SECRETS.macApiKey.join(', ')} ` +
    `(or ${SIGNING_SECRETS.macAppleId.join(', ')})`
  )
}

/**
 * What this build's signing means for its run (docs/RELEASING.md "Cutting a release"). Unsigned is the default: a tag
 * build without that OS's secrets goes on with a notice that says so and how to turn signing on. Only with
 * `requireSigned` (the REQUIRE_SIGNED_RELEASE variable) does a final tag (vX.Y.Z) refuse to build unsigned: an error,
 * raised before electron-builder runs, naming the secrets to set. A dry run (no tag) builds unsigned because a branch
 * never reaches the release environment (a notice); a dry run that did sign means the secrets are stored where a
 * branch reaches them (a warning). Linux is never signed: null.
 * @returns {{ level: 'error' | 'warning' | 'notice', message: string } | null}
 */
export function signingVerdict({ plan, tag, version, requireSigned = false }) {
  if (plan.platform === 'linux') return null
  const os = PLATFORM_TITLE[plan.platform]
  const isTag = typeof tag === 'string' && tag !== ''
  if (!isTag)
    return plan.signed
      ? {
          level: 'warning',
          message:
            `${os} signing secrets reached a dry run, so this branch's build is signed. Keep them as secrets of ` +
            `the "${RELEASE_ENVIRONMENT}" environment only, never as repository or organization secrets ` +
            '(docs/RELEASING.md "Turning on signing").',
        }
      : {
          level: 'notice',
          message: `${os} is not signed in this dry run: only a v* tag run gets the signing secrets.`,
        }
  if (plan.signed) return null
  const parsed = parseVersion(version)
  if (parsed === null) throw new ReleaseError(`version "${version}" is not X.Y.Z or X.Y.Z-pre`)
  if (requireSigned && parsed.prerelease === null)
    return {
      level: 'error',
      message:
        `${tag} is a final release, and ${os} would not be signed: no ${os} signing secrets reached the build, and ` +
        `${REQUIRE_SIGNED_VAR} is true. Set ${secretsToSign(plan.platform)} in the "${RELEASE_ENVIRONMENT}" ` +
        'environment (docs/RELEASING.md "Turning on signing") and run the workflow again on this tag, or set ' +
        `${REQUIRE_SIGNED_VAR} to false for an unsigned release. Nothing was released.`,
    }
  const what = plan.platform === 'mac' ? 'ad hoc signed, not notarized' : 'unsigned'
  return {
    level: 'notice',
    message:
      `${os} signing skipped for ${tag}: no ${os} signing secrets are set, so this build is ${what}. To sign, set ` +
      `${secretsToSign(plan.platform)} in the "${RELEASE_ENVIRONMENT}" environment (docs/RELEASING.md "Turning on ` +
      'signing").',
  }
}

/** Every variable electron-builder would sign or notarize with; an unsigned build clears them all. */
const BUILDER_SIGNING_VARS = Object.freeze([
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
])

/**
 * The environment electron-builder runs with: exactly the signing variables the plan uses, under electron-builder's
 * own names, and none of the others (so a variable left on a runner can never sign or notarize by accident).
 * `apiKeyPath` is where the API key's .p8 was written (electron-builder's APPLE_API_KEY is a path).
 * @returns {{ set: Record<string, string>, unset: string[] }}
 */
export function builderEnv(plan, env, apiKeyPath) {
  const set = {}
  if (plan.platform === 'mac' && plan.signed) {
    set.CSC_LINK = env.MAC_CSC_LINK
    set.CSC_KEY_PASSWORD = env.MAC_CSC_KEY_PASSWORD
    if (plan.notarization === 'api-key') {
      if (typeof apiKeyPath !== 'string' || apiKeyPath === '')
        throw new ReleaseError('internal: the API key file was not written')
      set.APPLE_API_KEY = apiKeyPath
      set.APPLE_API_KEY_ID = env.APPLE_API_KEY_ID
      set.APPLE_API_ISSUER = env.APPLE_API_ISSUER
    } else {
      set.APPLE_ID = env.APPLE_ID
      set.APPLE_APP_SPECIFIC_PASSWORD = env.APPLE_APP_SPECIFIC_PASSWORD
      set.APPLE_TEAM_ID = env.APPLE_TEAM_ID
    }
  } else {
    // Unsigned, and Windows (Azure reads only the AZURE_* credentials): never pick up a certificate on the machine.
    set.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
  // Windows signs through the Azure EnvironmentCredential (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET),
  // which stay as they are; an unsigned Windows build drops them.
  const unset = [...BUILDER_SIGNING_VARS, 'CSC_IDENTITY_AUTO_DISCOVERY'].filter((n) => !(n in set))
  if (plan.platform === 'win' && !plan.signed)
    unset.push('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET')
  return { set, unset }
}

/**
 * electron-builder settings layered over electron-builder.yml for one release build: the version from the tag, the
 * numeric build version (Windows file version, CFBundleVersion), the deb's homepage, and signing per the plan.
 */
export function builderConfig({ plan, version, env, homepage }) {
  const parsed = parseVersion(version)
  if (parsed === null) throw new ReleaseError(`version "${version}" is not X.Y.Z or X.Y.Z-pre`)
  const extraMetadata = { version }
  if (typeof homepage === 'string' && homepage !== '') extraMetadata.homepage = homepage
  else if (plan.platform === 'linux')
    throw new ReleaseError(
      'the deb needs a homepage: pass --homepage <url> (release.yml uses the GitHub repository)',
    )
  /** @type {Record<string, unknown>} */
  const config = { extraMetadata, buildVersion: parsed.base, forceCodeSigning: plan.signed }
  if (plan.platform === 'win' && plan.signed) {
    config.win = {
      azureSignOptions: {
        endpoint: env.AZURE_SIGNING_ENDPOINT.trim(),
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT.trim(),
        certificateProfileName: env.AZURE_SIGNING_CERT_PROFILE.trim(),
        publisherName: env.AZURE_SIGNING_PUBLISHER.trim(),
      },
    }
  }
  if (plan.platform === 'mac')
    config.mac = plan.signed
      ? { notarize: true }
      : // Ad hoc: Apple silicon refuses to run an app with no signature at all. identity "-" signs every binary in the
        // bundle ad hoc (electron-builder's mac.identity documentation; null would skip signing entirely). The hardened
        // runtime is off with it: its library validation would refuse the ad hoc signed frameworks, and it only matters
        // for notarization, which needs a Developer ID. Both architectures get the same treatment.
        { notarize: false, identity: '-', hardenedRuntime: false }
  return config
}

/** The homepage the workflow's repository gives, or null outside GitHub Actions. */
export function repositoryHomepage(env) {
  const server = env.GITHUB_SERVER_URL
  const repo = env.GITHUB_REPOSITORY
  return isSet(env, 'GITHUB_SERVER_URL') && isSet(env, 'GITHUB_REPOSITORY') ? `${server}/${repo}` : null
}

// ---- artifacts --------------------------------------------------------------------------------------------------

/**
 * The installers one OS's build produces, named by electron-builder.yml's artifactName patterns (a unit test keeps
 * the two in step), with what each is for.
 * @returns {{ name: string, for: string }[]}
 */
export function expectedArtifacts(platform, version) {
  switch (platform) {
    case 'win':
      return [{ name: `${BRAND.slug}-setup-${version}.exe`, for: 'Windows 10 and 11, x64' }]
    case 'mac':
      return [
        { name: `${BRAND.slug}-${version}-arm64.dmg`, for: 'macOS, Apple silicon' },
        { name: `${BRAND.slug}-${version}-x64.dmg`, for: 'macOS, Intel' },
      ]
    case 'linux':
      return [
        {
          name: `${BRAND.slug}_${version}_amd64.deb`,
          for: 'Ubuntu and Debian, x64 (installs the AppArmor profile)',
        },
        { name: `${BRAND.slug}-${version}-x86_64.AppImage`, for: 'Linux, x64 (see the AppArmor note)' },
      ]
    default:
      throw new ReleaseError(`unknown platform "${platform}" (win, mac or linux)`)
  }
}

/**
 * The unpacked apps one OS's build leaves in dist/ (relative to the project, `/`-separated), one per architecture:
 * what release.yml checks the signatures and the fuse wire of (tests/unit/security/fuses.test.ts reads the wire from
 * these). A macOS path is the .app, whose Electron Framework holds the fuses; x64 has no arch suffix.
 * @returns {{ arch: string, path: string }[]}
 */
export function packagedApps(platform) {
  switch (platform) {
    case 'win':
      return [{ arch: 'x64', path: `dist/win-unpacked/${BRAND.displayName}.exe` }]
    case 'mac':
      return [
        { arch: 'arm64', path: `dist/mac-arm64/${BRAND.displayName}.app` },
        { arch: 'x64', path: `dist/mac/${BRAND.displayName}.app` },
      ]
    case 'linux':
      return [{ arch: 'x64', path: `dist/linux-unpacked/${BRAND.slug}` }]
    default:
      throw new ReleaseError(`unknown platform "${platform}" (win, mac or linux)`)
  }
}

/** The release platform of a Node platform (win32, darwin, linux), or null. */
export function hostPlatform(nodePlatform = process.platform) {
  return HOST_PLATFORM[nodePlatform] ?? null
}

/** SHA-256 of a file, hex. */
export function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
  })
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** `sha256sum` text: one `<hex>  <name>` line per file, sorted by name. */
export function sumsText(files) {
  return [...files]
    .sort(byName)
    .map((f) => `${f.sha256}  ${f.name}\n`)
    .join('')
}

/** The entries of `sha256sum` text (text or binary mode). */
export function parseSums(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (m === null) throw new ReleaseError(`not a sha256sum line: ${JSON.stringify(line.slice(0, 120))}`)
    out.push({ sha256: m[1], name: m[2] })
  }
  return out
}

const manifestName = (platform) => `release-${platform}.json`
const platformSumsName = (platform) => `SHA256SUMS-${platform}.txt`

/** Describes one OS's installers in `dir`: the manifest object written next to them. */
export async function describeArtifacts({ dir, platform, version, plan, commit }) {
  const files = []
  for (const a of expectedArtifacts(platform, version)) {
    const path = join(dir, a.name)
    if (!existsSync(path)) throw new ReleaseError(`${a.name} was not built (looked in ${dir})`)
    files.push({ name: a.name, bytes: statSync(path).size, sha256: await sha256File(path) })
  }
  return {
    schemaVersion: 1,
    platform,
    version,
    signed: plan.signed,
    signing: plan.signed
      ? platform === 'win'
        ? 'azure-artifact-signing'
        : 'developer-id'
      : platform === 'mac'
        ? 'ad-hoc'
        : null,
    notarization: plan.notarization,
    commit: commit ?? null,
    files,
  }
}

// A dmg itself is not signed (electron-builder's dmg.sign is off); the app inside it is.
const SIGNATURE_TEXT = {
  win: (m) => (m.signed ? 'Azure Artifact Signing' : 'Not signed'),
  mac: (m) =>
    m.signed ? 'The app inside: Developer ID, notarized and stapled' : 'Ad hoc signed, not notarized',
  linux: () => 'Checksum only',
}

const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`

/** The text of NOTES_TEMPLATE in this checkout. */
export function readNotesTemplate(root = ROOT) {
  return readFileSync(join(root, NOTES_TEMPLATE), 'utf8')
}

/**
 * NOTES_TEMPLATE filled in: `{{name}}` takes a value, and a `{{#if name}}` line ... `{{/if}}` line block (not nested)
 * keeps the lines between only when the flag is true. An unknown name is an error, so the template and this code
 * cannot drift apart unnoticed.
 */
export function fillTemplate(template, values, flags) {
  const lf = template.replace(/\r\n/g, '\n')
  const text = lf.replace(/^\{\{#if (\w+)\}\}\n([\s\S]*?)^\{\{\/if\}\}$\n?/gm, (_, name, body) => {
    if (!(name in flags)) throw new ReleaseError(`${NOTES_TEMPLATE}: unknown condition "${name}"`)
    return flags[name] ? body : ''
  })
  const filled = text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new ReleaseError(`${NOTES_TEMPLATE}: unknown placeholder "${name}"`)
    return values[name]
  })
  if (/\{\{|\}\}/.test(filled)) throw new ReleaseError(`${NOTES_TEMPLATE}: a "{{" or "}}" was left over`)
  // A dropped block leaves its blank lines behind.
  return `${filled.replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/**
 * The draft release's text, from NOTES_TEMPLATE (`template`, read from the checkout when left out). The user edits it
 * before publishing; it states only what the build knows.
 */
export function releaseNotes({ version, manifests, commit, runUrl, template }) {
  const table = ['| File | For | Size | Signature |', '| --- | --- | --- | --- |']
  for (const m of manifests) {
    const forOf = new Map(expectedArtifacts(m.platform, m.version).map((a) => [a.name, a.for]))
    for (const f of m.files)
      table.push(
        `| \`${f.name}\` | ${forOf.get(f.name) ?? PLATFORM_TITLE[m.platform]} | ${megabytes(f.bytes)} | ${SIGNATURE_TEXT[m.platform](m)} |`,
      )
  }
  const signedOf = (platform) => manifests.find((m) => m.platform === platform)?.signed === true
  const unsignedManifests = manifests.filter((m) => m.platform !== 'linux' && !m.signed)
  const unsigned = unsignedManifests.map((m) => PLATFORM_TITLE[m.platform])
  const signedNames = manifests
    .filter((m) => m.platform !== 'linux' && m.signed)
    .map((m) => PLATFORM_TITLE[m.platform])
  const guard = { win: 'Windows SmartScreen', mac: 'macOS Gatekeeper' }
  const signing =
    unsigned.length > 0
      ? `${unsigned.join(' and ')} ${unsigned.length === 1 ? 'is' : 'are'} not signed in this build: ` +
        `${unsignedManifests.map((m) => guard[m.platform]).join(' and ')} ${unsigned.length === 1 ? 'warns' : 'warn'} ` +
        'before the first launch. The steps below get past the warning once.'
      : signedNames.length > 0
        ? `${signedNames.join(' and ')} ${signedNames.length === 1 ? 'is' : 'are'} signed in this build.`
        : ''
  const [win] = expectedArtifacts('win', version)
  const [macArm, macIntel] = expectedArtifacts('mac', version)
  const [deb, appImage] = expectedArtifacts('linux', version)
  const builtFrom =
    commit || runUrl
      ? `Built from ${commit ? `\`${commit}\`` : 'this tag'}${runUrl ? ` by ${runUrl}` : ''}.`
      : ''
  return fillTemplate(
    template ?? readNotesTemplate(),
    {
      title: `${BRAND.displayName} ${version}${parseVersion(version)?.prerelease ? ' (pre-release)' : ''}.`,
      name: BRAND.displayName,
      version,
      files: table.join('\n'),
      signing,
      win_installer: win.name,
      mac_arm64_dmg: macArm.name,
      mac_x64_dmg: macIntel.name,
      deb: deb.name,
      appimage: appImage.name,
      slug: BRAND.slug,
      built_from: builtFrom,
    },
    { win_unsigned: !signedOf('win'), mac_unsigned: !signedOf('mac') },
  )
}

/**
 * The release job's check over every OS's files in `dir`: each manifest's installers are there with its size and
 * SHA-256, its per-OS sums agree, and every OS built the same version. Returns the combined sums and the notes.
 */
export async function collectRelease({
  dir,
  version,
  platforms = PLATFORMS,
  commit,
  runUrl,
  requireSigned = false,
  template,
}) {
  const parsedVersion = parseVersion(version)
  if (parsedVersion === null) throw new ReleaseError(`version "${version}" is not X.Y.Z or X.Y.Z-pre`)
  const final = parsedVersion.prerelease === null
  const manifests = []
  const all = []
  for (const platform of platforms) {
    const file = join(dir, manifestName(platform))
    if (!existsSync(file))
      throw new ReleaseError(`${manifestName(platform)} is missing: the ${platform} build did not finish`)
    const m = JSON.parse(readFileSync(file, 'utf8'))
    if (m.platform !== platform) throw new ReleaseError(`${manifestName(platform)} describes "${m.platform}"`)
    if (m.version !== version)
      throw new ReleaseError(`the ${platform} build is version ${m.version}, this release is ${version}`)
    // With REQUIRE_SIGNED_RELEASE the build refuses this already (signingVerdict); checked again where the files
    // are attached.
    if (requireSigned && final && platform !== 'linux' && m.signed !== true)
      throw new ReleaseError(
        `${version} is a final release, but the ${PLATFORM_TITLE[platform]} build is not signed: with ` +
          `${REQUIRE_SIGNED_VAR} true, a final release needs signed Windows and macOS installers ` +
          '(docs/RELEASING.md "Turning on signing")',
      )
    const want = expectedArtifacts(platform, version)
      .map((a) => a.name)
      .sort()
    const have = (m.files ?? []).map((f) => f.name).sort()
    if (JSON.stringify(want) !== JSON.stringify(have))
      throw new ReleaseError(
        `the ${platform} manifest lists ${have.join(', ') || 'nothing'}, expected ${want.join(', ')}`,
      )
    for (const f of m.files) {
      const path = join(dir, f.name)
      if (!existsSync(path)) throw new ReleaseError(`${f.name} is missing from ${dir}`)
      const bytes = statSync(path).size
      if (bytes !== f.bytes) throw new ReleaseError(`${f.name} is ${bytes} bytes, its build wrote ${f.bytes}`)
      const sha256 = await sha256File(path)
      if (sha256 !== f.sha256)
        throw new ReleaseError(`${f.name} does not match the SHA-256 its build recorded`)
      all.push({ name: f.name, sha256 })
    }
    const sumsFile = join(dir, platformSumsName(platform))
    if (!existsSync(sumsFile)) throw new ReleaseError(`${platformSumsName(platform)} is missing`)
    if (readFileSync(sumsFile, 'utf8') !== sumsText(m.files))
      throw new ReleaseError(`${platformSumsName(platform)} does not agree with ${manifestName(platform)}`)
    manifests.push(m)
  }
  const names = all.map((f) => f.name)
  if (new Set(names).size !== names.length)
    throw new ReleaseError('two builds produced a file of the same name')
  return {
    sums: sumsText(all),
    notes: releaseNotes({ version, manifests, commit, runUrl, template }),
    files: [...names.sort(), 'SHA256SUMS'],
    manifests,
  }
}

// ---- commands ---------------------------------------------------------------------------------------------------

const log = (line) => console.log(`release: ${line}`)

const inActions = () => process.env.GITHUB_ACTIONS === 'true'

/** A warning or notice on the workflow run (an annotation in GitHub Actions; a plain line elsewhere). */
function annotate(level, message) {
  if (inActions()) console.log(`::${level}::${message}`)
  else log(`${level}: ${message}`)
}

function writeOutputs(values) {
  const file = process.env.GITHUB_OUTPUT
  if (typeof file !== 'string' || file === '') return
  appendFileSync(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${String(v)}\n`)
      .join(''),
  )
}

function readPackageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

function versionCommand(values) {
  const r = resolveRelease({
    ref: values.ref ?? process.env.GITHUB_REF ?? '',
    packageVersion: readPackageVersion(),
  })
  writeOutputs({ version: r.version, tag: r.tag ?? '', prerelease: r.prerelease, release: r.release })
  console.log(JSON.stringify(r))
  if (!r.release && inActions())
    console.log(
      `::notice::Not a tag: a dry run of ${r.version}, unsigned. The installers are workflow artifacts; no release.`,
    )
  return 0
}

async function buildCommand(values) {
  const platform = values.platform
  if (!PLATFORMS.includes(platform)) throw new UsageError('--platform win|mac|linux is required')
  if (HOST_PLATFORM[process.platform] !== platform)
    throw new ReleaseError(`this is ${process.platform}: a ${platform} release builds only on its own OS`)
  const version = values.version ?? ''
  if (parseVersion(version) === null) throw new UsageError('--version X.Y.Z[-pre] is required')
  const tag = values.tag ?? ''
  if (tag !== '' && tag !== `v${version}`)
    throw new UsageError(`--tag ${tag} is not v${version} (leave it out, or empty, for a dry run)`)

  // Signing first: a final tag that would ship unsigned stops here, before anything is built.
  const plan = signingPlan(platform, process.env)
  for (const n of plan.notes) log(n)
  const verdict = signingVerdict({ plan, tag, version, requireSigned: requireSigned(process.env) })
  if (verdict?.level === 'error') throw new ReleaseError(verdict.message)
  if (verdict !== null) annotate(verdict.level, verdict.message)
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js')))
    throw new ReleaseError('out/ has no built app: run "pnpm build" first')
  const homepage = values.homepage ?? repositoryHomepage(process.env)

  const dist = join(ROOT, 'dist')
  const outDir = join(dist, 'release')
  rmSync(outDir, { recursive: true, force: true })
  // A failed build must never pick up an installer an earlier build left behind.
  for (const a of expectedArtifacts(platform, version)) rmSync(join(dist, a.name), { force: true })

  let keyDir = null
  try {
    let apiKeyPath
    if (plan.signed && plan.notarization === 'api-key') {
      keyDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), `${BRAND.slug}-notary-`))
      apiKeyPath = join(keyDir, `AuthKey_${process.env.APPLE_API_KEY_ID.trim()}.p8`)
      writeFileSync(apiKeyPath, process.env.APPLE_API_KEY_P8, { mode: 0o600 })
    }
    const { set, unset } = builderEnv(plan, process.env, apiKeyPath)
    for (const n of unset) delete process.env[n]
    Object.assign(process.env, set)
    const config = builderConfig({ plan, version, env: process.env, homepage })
    const signing = plan.signed
      ? 'signed'
      : platform === 'mac'
        ? 'ad hoc signed (no Developer ID)'
        : 'unsigned'
    log(`electron-builder --${platform} ${version}, ${signing}`)
    const builder = (await import('electron-builder')).default
    await builder.build({ [platform]: [], config, publish: 'never', projectDir: ROOT })
  } finally {
    if (keyDir !== null) rmSync(keyDir, { recursive: true, force: true })
  }

  mkdirSync(outDir, { recursive: true })
  for (const a of expectedArtifacts(platform, version)) {
    const from = join(dist, a.name)
    if (!existsSync(from)) throw new ReleaseError(`electron-builder finished without ${a.name}`)
    renameSync(from, join(outDir, a.name))
  }
  const manifest = await describeArtifacts({
    dir: outDir,
    platform,
    version,
    plan,
    commit: process.env.GITHUB_SHA,
  })
  writeFileSync(join(outDir, manifestName(platform)), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(outDir, platformSumsName(platform)), sumsText(manifest.files))
  for (const f of manifest.files) log(`${f.name}  ${f.bytes} bytes  sha256 ${f.sha256}`)
  writeOutputs({ signed: plan.signed, notarized: plan.notarization !== null })
  return 0
}

async function collectCommand(values) {
  const dir = values.dir
  const version = values.version ?? ''
  if (typeof dir !== 'string' || dir === '') throw new UsageError('--dir <folder> is required')
  if (parseVersion(version) === null) throw new UsageError('--version X.Y.Z[-pre] is required')
  const platforms = (values.platforms ?? PLATFORMS.join(','))
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  for (const p of platforms) if (!PLATFORMS.includes(p)) throw new UsageError(`--platforms: unknown "${p}"`)
  const server = process.env.GITHUB_SERVER_URL
  const runUrl =
    server && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined
  const r = await collectRelease({
    dir,
    version,
    platforms,
    commit: process.env.GITHUB_SHA,
    runUrl,
    requireSigned: requireSigned(process.env),
  })
  writeFileSync(join(dir, 'SHA256SUMS'), r.sums)
  writeFileSync(join(dir, 'notes.md'), r.notes)
  writeFileSync(join(dir, 'files.txt'), `${r.files.join('\n')}\n`)
  log(
    `checked ${r.files.length - 1} installers from ${platforms.join(', ')}; wrote SHA256SUMS, notes.md, files.txt`,
  )
  return 0
}

class UsageError extends Error {}

const USAGE = `node scripts/release.mjs version [--ref <git ref>]
node scripts/release.mjs build --platform <win|mac|linux> --version <v> [--tag <v-tag>] [--homepage <url>]
node scripts/release.mjs collect --dir <folder> --version <v> [--platforms win,mac,linux]
`

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ref: { type: 'string' },
      platform: { type: 'string' },
      version: { type: 'string' },
      tag: { type: 'string' },
      homepage: { type: 'string' },
      dir: { type: 'string' },
      platforms: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  switch (positionals[0]) {
    case 'version':
      return versionCommand(values)
    case 'build':
      return buildCommand(values)
    case 'collect':
      return collectCommand(values)
    default:
      throw new UsageError(`unknown command "${positionals[0] ?? ''}"`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (err) {
    const usage =
      err instanceof UsageError || (err instanceof TypeError && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION')
    const message = err instanceof Error ? err.message : String(err)
    // The run's summary shows the reason too, not only the step's log.
    if (inActions()) console.log(`::error::${message.replace(/\r?\n/g, ' ')}`)
    process.stderr.write(`release: ${message}\n`)
    if (usage) process.stderr.write(USAGE)
    process.exitCode = usage ? 2 : 1
  }
}
