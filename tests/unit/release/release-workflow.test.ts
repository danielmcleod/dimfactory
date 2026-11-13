// .github/workflows/release.yml (docs/RELEASING.md): what it runs on, the checks a
// release must pass, unsigned first (no step needs a secret; the signing steps run only for a signed build, and an
// unsigned one says so and has its macOS ad hoc signature checked), signing only through scripts/release.mjs with each
// secret given to its own OS's build step and nowhere else, the secrets reachable only from a tag run (the `release`
// environment), the fuse wire checked on every OS, actions pinned to full commit SHAs, write access only where the
// draft release is made, and a draft, never a published release. Read as text, line by line, as tests/unit/release/ci-coverage.test.ts reads ci.yml.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  allSecretNames,
  DRY_RUN_ENVIRONMENT,
  expectedArtifacts,
  NOTES_TEMPLATE,
  packagedApps,
  RELEASE_ENVIRONMENT,
  REQUIRE_SIGNED_VAR,
  SIGNING_SECRETS,
} from '../../../scripts/release.mjs'

const wf = readFileSync('.github/workflows/release.yml', 'utf8')
const lines = wf.split(/\r?\n/)
const releasing = readFileSync('docs/RELEASING.md', 'utf8')

const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0
const isContent = (line: string): boolean => line.trim() !== '' && !line.trim().startsWith('#')

/** The lines of the block a line opens: it and every following line indented deeper (blank lines kept). */
function blockAt(start: number): string[] {
  const head = lines[start] ?? ''
  const base = indentOf(head.replace(/^(\s*)- /, '$1  '))
  const out = [head]
  for (const line of lines.slice(start + 1)) {
    if (isContent(line) && indentOf(line) <= indentOf(head)) break
    if (isContent(line) && indentOf(line) < base) break
    out.push(line)
  }
  return out
}

/** A job's block (`  <name>:` under `jobs:`). */
function job(name: string): string {
  const i = lines.findIndex((l) => l === `  ${name}:`)
  expect(i, `job ${name}`).toBeGreaterThan(0)
  return blockAt(i).join('\n')
}

/** The steps of a job, each as its text (`      - ` items under `    steps:`). */
function steps(name: string): string[] {
  const start = lines.findIndex((l) => l === `  ${name}:`)
  const jobLines = blockAt(start)
  const s = jobLines.findIndex((l) => l === '    steps:')
  expect(s, `${name} steps`).toBeGreaterThan(0)
  const out: string[] = []
  for (const line of jobLines.slice(s + 1)) {
    if (line.startsWith('      - ')) out.push(line)
    else if (out.length > 0) out[out.length - 1] += `\n${line}`
  }
  return out
}

const buildStep = (): string => {
  const found = steps('build').filter((s) => /run: node scripts\/release\.mjs build\b/.test(s))
  expect(found).toHaveLength(1)
  return found[0] ?? ''
}

describe('release.yml triggers and jobs', () => {
  it('runs on a v* tag and by hand, nothing else', () => {
    const on = blockAt(lines.indexOf('on:')).join('\n')
    expect(on).toMatch(/^ {2}push:\n {4}tags: \['v\*'\]$/m)
    expect(on).toMatch(/^ {2}workflow_dispatch:/m)
    expect(on).not.toMatch(/pull_request|schedule|branches:/)
  })

  it('builds on Windows, macOS and Ubuntu, one OS per leg', () => {
    const b = job('build')
    expect(b).toMatch(/- os: windows-latest\n\s+platform: win/)
    expect(b).toMatch(/- os: macos-latest\n\s+platform: mac/)
    expect(b).toMatch(/- os: ubuntu-latest\n\s+platform: linux/)
    expect(b).toMatch(/runs-on: \$\{\{ matrix\.os \}\}/)
  })

  it('installs from the frozen lockfile and runs typecheck, unit tests and the packaged smoke test', () => {
    const p = job('prepare')
    const b = job('build')
    for (const text of [p, b]) expect(text).toMatch(/run: pnpm install --frozen-lockfile$/m)
    expect(p).toMatch(/run: pnpm typecheck$/m)
    expect(p).toMatch(/run: node scripts\/release\.mjs version$/m)
    expect(b).toMatch(/run: pnpm test$/m)
    expect(b).toMatch(/run: pnpm smoke:packaged$/m)
    // The tests run before the installers are built, and the smoke after.
    const at = (re: RegExp): number => steps('build').findIndex((s) => re.test(s))
    expect(at(/run: pnpm test$/m)).toBeGreaterThan(0)
    expect(at(/run: pnpm test$/m)).toBeLessThan(at(/scripts\/release\.mjs build/))
    expect(at(/scripts\/release\.mjs build/)).toBeLessThan(at(/run: pnpm smoke:packaged$/m))
  })

  it('smoke-tests the Intel macOS dmg on an Intel Mac, from the file the build uploaded', () => {
    const j = job('smoke-mac-intel')
    expect(j).toMatch(/needs: \[prepare, build\]/)
    // An Intel runner: under Rosetta on the build's arm64 runner the app ran its own checks out of time.
    expect(j).toMatch(/runs-on: macos-15-intel$/m)
    expect(job('build')).not.toMatch(/arch -x86_64|install-rosetta/)
    const s = steps('smoke-mac-intel')
    const download = s.find((x) => x.includes('actions/download-artifact@')) ?? ''
    expect(download).toMatch(/name: dim-factory-\$\{\{ needs\.prepare\.outputs\.version \}\}-mac$/m)
    const smoke = s.find((x) => x.includes('smoke-packaged.mjs')) ?? ''
    // The Intel dmg as the release names it, mounted, its signature checked, and the app in it run.
    expect(smoke).toContain('hdiutil attach "release/dim-factory-$VERSION-x64.dmg"')
    expect(expectedArtifacts('mac', '1.0.0').map((f) => f.name)).toContain('dim-factory-1.0.0-x64.dmg')
    expect(smoke).toMatch(/codesign --verify --deep --strict/)
    expect(smoke).toMatch(
      /node scripts\/smoke-packaged\.mjs --app "\$mount\/Dim Factory\.app\/Contents\/MacOS\/Dim Factory"$/m,
    )
    // With the usual time limit, and its result counts.
    expect(smoke).not.toMatch(/smoke-packaged\.mjs[^\n]*(--timeout|\|\|)/)
    // The smoke script needs the checkout and Node, nothing installed.
    expect(j).not.toMatch(/pnpm install/)
  })

  it('creates a draft release, only for a tag, after every OS built and smoke-tested, from checked files', () => {
    const r = job('release')
    expect(r).toMatch(/needs: \[prepare, build, smoke-mac-intel\]/)
    expect(r).toMatch(/if: needs\.prepare\.outputs\.release == 'true'/)
    expect(r).toMatch(/gh release create "\$TAG" "\$\{files\[@\]\}" --draft --verify-tag/)
    expect(r).not.toMatch(/--draft=false|gh release edit [^\n]*--draft=false/)
    expect(r).toMatch(/run: node scripts\/release\.mjs collect --dir release --version "\$VERSION"/)
    expect(r).toMatch(/sha256sum --check --strict SHA256SUMS/)
    // A published release is never overwritten.
    expect(r).toMatch(/already published/)
  })

  it('checks the fuse wire of every packaged app on every OS, failing when one is missing', () => {
    const fuse = steps('build').find((s) => s.includes('tests/unit/security/fuses.test.ts')) ?? ''
    expect(fuse).toMatch(/run: pnpm exec vitest run --project unit tests\/unit\/security\/fuses\.test\.ts$/m)
    expect(fuse).not.toMatch(/^\s+if:/m)
    expect(fuse).toMatch(/env:\n\s+REQUIRE_PACKAGED: '1'/)
    // After the installers are built.
    const at = (re: RegExp): number => steps('build').findIndex((s) => re.test(s))
    expect(at(/scripts\/release\.mjs build/)).toBeLessThan(at(/fuses\.test\.ts/))
  })

  it('uploads each OS installers with its manifest and sums', () => {
    const upload = steps('build').find((s) => s.includes('actions/upload-artifact@')) ?? ''
    expect(upload).toMatch(/path: dist\/release\/$/m)
    expect(upload).toMatch(/if-no-files-found: error/)
  })
})

describe('release.yml security', () => {
  it('pins every action to a full commit SHA with its release tag beside it, one SHA per action', () => {
    const uses = lines.filter((l) => /^\s*(- )?uses:/.test(l))
    expect(uses.length).toBeGreaterThanOrEqual(10)
    const pins = new Map<string, Set<string>>()
    for (const l of uses) {
      const m = /uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(l)
      expect(m, l).not.toBeNull()
      const key = m?.[1] ?? ''
      pins.set(key, (pins.get(key) ?? new Set()).add(`${m?.[2] ?? ''} ${m?.[3] ?? ''}`))
    }
    for (const [action, set] of pins) expect([...set], action).toHaveLength(1)
  })

  it('reads only by default; contents: write only in the release job', () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(job('release')).toMatch(/permissions:\n {6}contents: write/)
    for (const name of ['prepare', 'build', 'smoke-mac-intel']) expect(job(name)).not.toMatch(/permissions:/)
    expect(wf.match(/contents: write/g)).toHaveLength(1)
  })

  it('never keeps the checkout credentials and never restores a dependency cache', () => {
    const checkouts = wf.split('\n').filter((l) => l.includes('actions/checkout@')).length
    expect(wf.match(/persist-credentials: false/g)).toHaveLength(checkouts)
    const setups = wf.split('\n').filter((l) => l.includes('actions/setup-node@')).length
    expect(wf.match(/package-manager-cache: false/g)).toHaveLength(setups)
    expect(wf).not.toMatch(/^\s+cache:/m)
    expect(wf).not.toMatch(/actions\/cache@/)
  })

  it('gives secrets only to the build step, each to its own OS only', () => {
    const step = buildStep()
    const refs = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1])
    const inStep = [...step.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1])
    expect(refs).toEqual(inStep)
    const osOf = (name: string): string =>
      SIGNING_SECRETS.win.includes(name) ? 'win' : allSecretNames().includes(name) ? 'mac' : 'none'
    for (const name of allSecretNames()) {
      expect(step, name).toContain(
        `${name}: \${{ matrix.platform == '${osOf(name)}' && secrets.${name} || '' }}`,
      )
    }
    // Exactly the script's secrets: nothing else is read, and no job- or workflow-level env holds one.
    expect([...new Set(refs)].sort()).toEqual([...allSecretNames()].sort())
    expect(wf).not.toMatch(/secrets\.GITHUB_TOKEN|secrets: inherit/)
  })

  it('checks the signatures when the build signed', () => {
    const s = steps('build')
    const win = s.find((x) => x.includes('Get-AuthenticodeSignature')) ?? ''
    expect(win).toMatch(/if: matrix\.platform == 'win' && steps\.build\.outputs\.signed == 'true'/)
    expect(win).toMatch(/Status -ne 'Valid'/)
    for (const a of packagedApps('win')) expect(win).toContain(`'${a.path}'`)
    const mac = s.find((x) => x.includes('codesign --verify')) ?? ''
    expect(mac).toMatch(/if: matrix\.platform == 'mac' && steps\.build\.outputs\.signed == 'true'/)
    expect(mac).toMatch(/spctl --assess --type execute/)
    expect(mac).toMatch(/xcrun stapler validate/)
    // Both architectures' apps, as the script names them.
    expect(mac).toContain(
      `for app in ${packagedApps('mac')
        .map((a) => `"${a.path}"`)
        .join(' ')}; do`,
    )
    expect(buildStep()).toMatch(/^\s+id: build$/m)
  })

  it('unsigned first: every signing check runs only for a signed build; an unsigned one logs that it skipped', () => {
    const s = steps('build')
    const signedOnly = s.filter((x) => /Get-AuthenticodeSignature|spctl|stapler/.test(x))
    expect(signedOnly).toHaveLength(2)
    for (const step of signedOnly)
      expect(step).toMatch(/^\s+if: [^\n]*steps\.build\.outputs\.signed == 'true'$/m)
    const status = s.find((x) => x.includes('name: Signing status')) ?? ''
    expect(status).not.toMatch(/^\s+if:/m)
    expect(status).toMatch(/SIGNED: \$\{\{ steps\.build\.outputs\.signed \}\}/)
    expect(status).toContain('Signing skipped: no $PLATFORM signing secrets are configured')
    expect(status).toContain('GITHUB_STEP_SUMMARY')
    // After the build step, before the checks it explains.
    const at = (re: RegExp): number => s.findIndex((x) => re.test(x))
    expect(at(/scripts\/release\.mjs build/)).toBeLessThan(at(/name: Signing status/))
    expect(at(/name: Signing status/)).toBeLessThan(at(/Get-AuthenticodeSignature/))
  })

  it('macOS without a Developer ID: both apps must carry a valid ad hoc signature', () => {
    const adhoc = steps('build').find((x) => x.includes('name: Check the macOS ad hoc signatures')) ?? ''
    expect(adhoc).toMatch(/if: matrix\.platform == 'mac' && steps\.build\.outputs\.signed != 'true'/)
    expect(adhoc).toContain(
      `for app in ${packagedApps('mac')
        .map((a) => `"${a.path}"`)
        .join(' ')}; do`,
    )
    expect(adhoc).toMatch(/codesign --verify --deep --strict/)
    expect(adhoc).toMatch(/grep -F 'Signature=adhoc'/)
    expect(adhoc).not.toMatch(/spctl|stapler|notarytool/)
  })

  it('REQUIRE_SIGNED_RELEASE is a repository variable, given to the build and collect steps, never a secret', () => {
    expect(REQUIRE_SIGNED_VAR).toBe('REQUIRE_SIGNED_RELEASE')
    expect(job('build')).toMatch(/^ {6}REQUIRE_SIGNED_RELEASE: \$\{\{ vars\.REQUIRE_SIGNED_RELEASE \}\}$/m)
    const collect = steps('release').find((x) => x.includes('scripts/release.mjs collect')) ?? ''
    expect(collect).toMatch(/REQUIRE_SIGNED_RELEASE: \$\{\{ vars\.REQUIRE_SIGNED_RELEASE \}\}/)
    expect(wf).not.toMatch(/secrets\.REQUIRE_SIGNED_RELEASE/)
    // The only variable the workflow reads.
    expect([...new Set([...wf.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]))]).toEqual([
      REQUIRE_SIGNED_VAR,
    ])
  })

  it('makes the draft notes from the template in the checkout', () => {
    expect(steps('release').some((x) => x.includes('actions/checkout@'))).toBe(true)
    expect(NOTES_TEMPLATE).toBe('.github/release-notes.md')
    expect(wf).toContain(NOTES_TEMPLATE)
    expect(job('release')).toMatch(/--notes-file notes\.md/)
  })

  it('lets only a tag run reach the signing secrets: the build job runs in the release environment only then', () => {
    expect(job('build')).toContain(
      `    environment: \${{ needs.prepare.outputs.release == 'true' && '${RELEASE_ENVIRONMENT}' || '${DRY_RUN_ENVIRONMENT}' }}`,
    )
    // No other job runs in an environment (the release job needs no secret: it uses the workflow's own token).
    expect(wf.match(/^\s+environment:/gm)).toHaveLength(1)
    expect(job('prepare')).not.toMatch(/environment:/)
    expect(job('release')).not.toMatch(/environment:/)
  })

  it('tells the build which tag it releases, so a final tag can refuse to ship unsigned when asked to', () => {
    expect(job('build')).toMatch(/^ {6}TAG: \$\{\{ needs\.prepare\.outputs\.tag \}\}$/m)
    expect(buildStep()).toMatch(
      /run: node scripts\/release\.mjs build --platform "\$\{\{ matrix\.platform \}\}" --version "\$VERSION" --tag "\$TAG"$/m,
    )
  })
})

describe('docs/RELEASING.md', () => {
  it('is the public guide: how releases are built, the install notes, signing; no private tooling', () => {
    for (const heading of ['## How a release is built', '## Cutting a release', '## Turning on signing'])
      expect(releasing).toContain(heading)
    expect(releasing).toContain('(../README.md#installing)')
    // Public: it may not cite the private publishing note or its tooling.
    expect(releasing).not.toMatch(/PUBLISHING\.md|scripts\/publish\.mjs|publish:main|`publish` branch/)
  })

  it('UI standards: no em dash', () => {
    expect(releasing).not.toContain(String.fromCodePoint(0x2014))
  })

  it('documents every secret the workflow reads', () => {
    for (const name of allSecretNames()) expect(releasing, name).toMatch(new RegExp(`\\| \`${name}\` \\|`))
  })

  it('is linked from the README', () => {
    expect(readFileSync('README.md', 'utf8')).toContain('(docs/RELEASING.md)')
  })

  it('keeps the secrets in the release environment, which admits only v* tags', () => {
    expect(releasing).toContain(`an environment named \`${RELEASE_ENVIRONMENT}\``)
    expect(releasing).toMatch(/Selected branches and tags[^\n]*\n?[^\n]*`v\*`/)
    expect(releasing).toMatch(/never as repository or organization secrets/)
    expect(releasing).toContain(`\`${DRY_RUN_ENVIRONMENT}\``)
  })

  it('makes a pre-release tag the first full run, and v1.0.0 only after its draft checks out', () => {
    const cutting = releasing.slice(
      releasing.indexOf('## Cutting a release'),
      releasing.indexOf('## Verifying'),
    )
    expect(cutting).toMatch(/git tag -a v1\.0\.0-rc\.1/)
    expect(cutting.indexOf('git tag -a v1.0.0-rc.1')).toBeLessThan(cutting.indexOf('git tag -a v1.0.0 '))
    // Unsigned by default; only REQUIRE_SIGNED_RELEASE makes an unsigned final tag fail.
    expect(cutting).toMatch(
      /A final tag builds unsigned like the candidate, unless the repository variable `REQUIRE_SIGNED_RELEASE`/,
    )
    expect(releasing).toMatch(/\| `REQUIRE_SIGNED_RELEASE` \|/)
  })

  it('says what is signed on macOS, and how to open an unsigned app on macOS 15 and later', () => {
    // Unsigned first: both apps are ad hoc signed (never notarized) until the Developer ID secrets are set.
    const dmgRows = releasing
      .split('\n')
      .filter((l) => /^\| `dim-factory-<version>-(arm64|x64)\.dmg`/.test(l))
    expect(dmgRows).toHaveLength(2)
    for (const row of dmgRows) expect(row.split('|')[3]?.trim(), row).toBe('Ad hoc signed, not notarized')
    expect(releasing).toContain('`mac.identity: "-"`')
    expect(releasing).toMatch(/`identity: null` would skip signing\s+entirely/)
    expect(releasing).not.toMatch(/Control-click/)
    expect(releasing).toMatch(/Privacy & Security[^\n]*Open Anyway/)
  })
})
