// The Deploy helper's options and copyable steps: the packs' deploy targets (data, validated), the placeholder values
// read from a folder (a value that is not plain falls back to a safe default), the order targets are offered in and
// the recommended one, and the caveat rules for every cost and security statement. Surge and Firebase Hosting: in
// which packs, their commands with the placeholders filled, and the Firebase config's placeholder project id.
import { describe, expect, it } from 'vitest'
import { PackZ } from '@shared/brief.ts'
import {
  DEPLOY_CLASSES,
  DEPLOY_CONFIG_PATH,
  DEPLOY_CONFIG_PURPOSE,
  DEPLOY_COST_CAVEAT,
  FIREBASE_PROJECT_PLACEHOLDER,
  PackDeployZ,
} from '@shared/deploy.ts'
import type { PackDeployTarget } from '@shared/deploy.ts'
import {
  appPort,
  buildDir,
  fillCommand,
  optionViews,
  placeholderValues,
  recommendedTarget,
  shellOf,
  slugName,
  stepViews,
  targetsFor,
} from '@core/deploy/commands.ts'
import { emptySignals } from '@core/deploy/signals.ts'
import type { DeploySignals } from '@core/deploy/signals.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'

const packs = readBuiltinPacks().map((v) => v.pack)
const sig = (over: Partial<DeploySignals> = {}): DeploySignals => ({ ...emptySignals('My Shop'), ...over })

describe('pack data: deploy targets', () => {
  it('every built-in pack still validates, with Software in full and lighter packs for the rest', () => {
    for (const v of readBuiltinPacks()) expect(PackZ.safeParse(v.pack).success, v.pack.id).toBe(true)
    const software = packs.find((p) => p.id === 'software')
    expect(software?.deploy?.targets.length).toBeGreaterThanOrEqual(12)
    for (const id of ['documents', 'data', 'design']) {
      const p = packs.find((x) => x.id === id)
      expect(p?.deploy?.targets.length, id).toBeGreaterThan(0)
      expect(p?.deploy?.targets.length ?? 0, id).toBeLessThan(software?.deploy?.targets.length ?? 0)
    }
  })

  it('the software pack has a target for every class', () => {
    for (const cls of DEPLOY_CLASSES) expect(targetsFor(packs, 'software', cls), cls).toBeDefined()
  })

  it('no target text claims a deploy is free, safe or secure', () => {
    const claims =
      /\b(?:is free|free forever|always free|completely free|100% free|secure|guaranteed|safe)\b/i
    for (const p of packs) {
      for (const t of p.deploy?.targets ?? []) {
        for (const text of [
          t.freeTier,
          t.cost,
          t.coldStarts,
          t.customDomains,
          t.dataResidency,
          t.needs ?? '',
        ]) {
          expect(text, `${p.id}/${t.id}`).not.toMatch(claims)
          expect(text, `${p.id}/${t.id}`).not.toMatch(/—/)
        }
        for (const s of t.steps) expect(`${s.label} ${s.note ?? ''}`).not.toMatch(/—/)
      }
    }
  })

  it('refuses an unknown placeholder, a duplicate target and a command with a line break', () => {
    const t = {
      id: 'x',
      label: 'X',
      classes: ['static-site'],
      freeTier: 'a',
      cost: 'b',
      coldStarts: 'c',
      customDomains: 'd',
      dataResidency: 'e',
      configs: [],
      steps: [{ label: 'go', run: 'deploy {nope}' }],
    }
    expect(PackDeployZ.safeParse({ targets: [t] }).success).toBe(false)
    const ok = { ...t, steps: [{ label: 'go', run: 'deploy {dir}' }] }
    expect(PackDeployZ.safeParse({ targets: [ok] }).success).toBe(true)
    expect(PackDeployZ.safeParse({ targets: [ok, ok] }).success).toBe(false)
    expect(
      PackDeployZ.safeParse({ targets: [{ ...t, steps: [{ label: 'go', run: 'a\nb' }] }] }).success,
    ).toBe(false)
  })
})

describe('placeholder values', () => {
  it('slugs a name every provider and Docker accept', () => {
    expect(slugName('@acme/My Shop API')).toBe('my-shop-api')
    expect(slugName('9lives')).toBeUndefined()
    expect(slugName('---')).toBeUndefined()
    expect(slugName(undefined)).toBeUndefined()
  })

  it('reads the build folder from the tools the folder uses', () => {
    expect(buildDir(sig({ files: ['mkdocs.yml'] }), 'docs-site')).toBe('site')
    expect(
      buildDir(
        sig({ pkg: { deps: ['vite', 'react'], scripts: {}, private: true, library: false, bin: false } }),
        'spa',
      ),
    ).toBe('dist')
    expect(
      buildDir(
        sig({ pkg: { deps: ['react-scripts'], scripts: {}, private: true, library: false, bin: false } }),
        'spa',
      ),
    ).toBe('build')
    expect(buildDir(sig({ html: true, files: ['index.html'] }), 'static-site')).toBe('.')
    expect(buildDir(sig({ dirs: ['public'] }), 'spa')).toBe('public')
  })

  it("takes the port from the Dockerfile's EXPOSE, else the stack's usual one", () => {
    expect(appPort(sig({ exposePort: 4000 }))).toBe('4000')
    expect(appPort(sig({ pkg: { deps: [], scripts: {}, private: true, library: false, bin: false } }))).toBe(
      '3000',
    )
    expect(appPort(sig({ python: { deps: [], buildSystem: false, scripts: false } }))).toBe('8000')
    expect(appPort(sig())).toBe('8080')
  })

  it('a value that is not plain falls back to its default, so a copied command carries nothing smuggled in', () => {
    const s = sig({
      pkg: {
        name: 'shop',
        version: '1.0.0; rm -rf ~',
        deps: [],
        scripts: {},
        private: true,
        library: false,
        bin: false,
      },
    })
    const v = placeholderValues(s, 'server-app', { branch: 'main && curl evil' })
    expect(v.version).toBe('0.1.0')
    expect(v.branch).toBe('main')
    expect(v.name).toBe('shop')
    const ok = placeholderValues(s, 'server-app', { branch: 'feature/x-1' })
    expect(ok.branch).toBe('feature/x-1')
  })

  it('fills known placeholders and leaves others as written', () => {
    const v = { name: 'shop', dir: 'dist', branch: 'main', port: '3000', version: '1.2.3' }
    expect(fillCommand('npx netlify-cli deploy --prod --dir {dir}', v)).toBe(
      'npx netlify-cli deploy --prod --dir dist',
    )
    expect(fillCommand('docker run -p {port}:{port} {name} {other}', v)).toBe(
      'docker run -p 3000:3000 shop {other}',
    )
  })
})

describe('targets and steps', () => {
  it('offers the targets made for a class first, in pack order', () => {
    const server = targetsFor(packs, 'software', 'server-app')
    expect(server?.targets[0]?.id).toBe('render')
    expect(server?.targets.map((t) => t.id)).toContain('vercel')
    const stat = targetsFor(packs, 'software', 'static-site')
    expect(stat?.targets[0]?.id).toBe('github-pages')
  })

  it("uses the category's pack, and the software pack when the category has nothing for the class", () => {
    expect(targetsFor(packs, 'documents', 'docs-site')?.pack.id).toBe('documents')
    expect(targetsFor(packs, 'documents', 'server-app')?.pack.id).toBe('software')
    expect(targetsFor(packs, 'operations', 'container')?.pack.id).toBe('software')
  })

  it('recommends the chosen target, else the brief hosting choice, else the first', () => {
    const t = targetsFor(packs, 'software', 'server-app')?.targets ?? []
    expect(recommendedTarget(t, { chosen: 'fly' })?.id).toBe('fly')
    expect(recommendedTarget(t, { chosen: 'npm' })?.id).toBe('render')
    expect(recommendedTarget(t, { hosting: ['self-hosted'] })?.id).toBe('vps-docker')
    expect(recommendedTarget(t, {})?.id).toBe('render')
  })

  it('makes copyable steps with ids, the shell of the platform, and plain instructions without a command', () => {
    const gh = packs
      .find((p) => p.id === 'software')
      ?.deploy?.targets.find((t) => t.id === 'github-pages') as PackDeployTarget
    const v = { name: 'shop', dir: 'dist', branch: 'trunk', port: '3000', version: '1.2.3' }
    const steps = stepViews(gh, v, shellOf('win32'))
    expect(steps[0]).toMatchObject({
      id: 'github-pages:1',
      command: 'git push origin trunk',
      shell: 'powershell',
    })
    expect(steps.some((s) => s.command === undefined)).toBe(true)
    expect(shellOf('linux')).toBe('sh')
  })

  it('option views mark the recommended one and which config files are there', () => {
    const found = targetsFor(packs, 'software', 'server-app')
    if (found === undefined) throw new Error('no targets')
    const views = optionViews({
      pack: found.pack,
      targets: found.targets,
      recommended: 'fly',
      values: placeholderValues(sig(), 'server-app'),
      shell: 'sh',
      present: new Set(['Dockerfile']),
    })
    const fly = views.find((o) => o.id === 'fly')
    expect(fly?.recommended).toBe(true)
    expect(fly?.configs.find((c) => c.kind === 'dockerfile')?.present).toBe(true)
    expect(fly?.configs.find((c) => c.kind === 'fly')).toMatchObject({ path: 'fly.toml', present: false })
    expect(views.filter((o) => o.recommended)).toHaveLength(1)
  })

  it('the cost caveat says to check current pricing', () => {
    expect(DEPLOY_COST_CAVEAT).toMatch(/current pricing/)
  })
})

describe('Surge and Firebase Hosting', () => {
  const values = { name: 'shop', dir: 'dist', branch: 'main', port: '3000', version: '1.0.0' }
  const target = (packId: string, id: string): PackDeployTarget | undefined =>
    packs.find((p) => p.id === packId)?.deploy?.targets.find((t) => t.id === id)

  it('Surge is in the software, documents, design, data and games packs, for static classes only', () => {
    for (const id of ['software', 'documents', 'design', 'data', 'games']) {
      const t = target(id, 'surge')
      expect(t, id).toBeDefined()
      expect(PackDeployZ.safeParse({ targets: [t] }).success, id).toBe(true)
      for (const c of t?.classes ?? []) expect(['static-site', 'docs-site', 'spa']).toContain(c)
    }
    expect(target('software', 'surge')?.classes).toEqual(['static-site', 'docs-site', 'spa'])
  })

  it("Surge's commands publish the build folder to <name>.surge.sh and note the first-time sign-up", () => {
    const t = target('software', 'surge')
    if (t === undefined) throw new Error('no surge')
    const steps = stepViews(t, values, 'sh')
    const commands = steps.flatMap((s) => (s.command !== undefined ? [s.command] : []))
    expect(commands).toContain('npx surge dist shop.surge.sh')
    expect(commands).toContain('npx surge teardown shop.surge.sh')
    expect(steps.map((s) => s.note ?? '').join(' ')).toMatch(/first time.*email/i)
    expect(t.customDomains).toMatch(/domain/i)
    expect(t.freeTier).toMatch(/current pricing/)
  })

  it('Firebase Hosting is in the software, design, data and documents packs, with its config files', () => {
    for (const id of ['software', 'design', 'data', 'documents']) {
      const t = target(id, 'firebase-hosting')
      expect(t, id).toBeDefined()
      expect(PackDeployZ.safeParse({ targets: [t] }).success, id).toBe(true)
      expect(t?.configs, id).toEqual(['firebase', 'firebaserc'])
      for (const c of t?.classes ?? []) expect(['static-site', 'spa']).toContain(c)
    }
    expect(target('games', 'firebase-hosting')).toBeUndefined()
  })

  it("Firebase's steps install the CLI, sign in, set up hosting and deploy hosting only; Blaze is only for some features", () => {
    const t = target('software', 'firebase-hosting')
    if (t === undefined) throw new Error('no firebase')
    const commands = stepViews(t, values, 'sh').flatMap((s) => (s.command !== undefined ? [s.command] : []))
    expect(commands).toEqual([
      'npm install -g firebase-tools',
      'firebase login',
      'firebase init hosting',
      'firebase deploy --only hosting',
    ])
    expect(t.cost).toMatch(/Blaze plan is only needed for some features/)
    expect(t.freeTier).toMatch(/Spark plan.*current pricing/)
    const notes = t.steps.map((s) => s.note ?? '').join(' ')
    expect(notes).toMatch(/public directory/)
    expect(notes).toMatch(/single-page app/)
  })

  it('every placeholder in the new commands is one the schema allows', () => {
    for (const p of packs) {
      for (const t of p.deploy?.targets ?? []) {
        if (t.id !== 'surge' && t.id !== 'firebase-hosting') continue
        for (const s of t.steps) {
          for (const m of (s.run ?? '').matchAll(/\{([^}]*)\}/g))
            expect(['name', 'dir', 'branch', 'port', 'version']).toContain(m[1])
          expect(fillCommand(s.run ?? '', values)).not.toMatch(/[{}]/)
        }
      }
    }
  })

  it('the generated Firebase config names a placeholder project, never a real id', () => {
    expect(DEPLOY_CONFIG_PATH.firebase).toBe('firebase.json')
    expect(DEPLOY_CONFIG_PATH.firebaserc).toBe('.firebaserc')
    expect(DEPLOY_CONFIG_PURPOSE.firebaserc).toContain(FIREBASE_PROJECT_PLACEHOLDER)
    expect(DEPLOY_CONFIG_PURPOSE.firebaserc).toMatch(/never a real project id/)
  })

  it('adding them leaves each class its recommended target', () => {
    for (const [cat, cls, first] of [
      ['software', 'static-site', 'github-pages'],
      ['games', 'static-site', 'itch-io'],
      ['documents', 'docs-site', 'github-pages'],
      ['data', 'static-site', 'github-pages'],
      ['design', 'static-site', 'netlify'],
    ] as const) {
      const found = targetsFor(packs, cat, cls)
      expect(recommendedTarget(found?.targets ?? [])?.id, `${cat}/${cls}`).toBe(first)
    }
    // A data project's single-page app still falls back to Software's targets.
    expect(targetsFor(packs, 'data', 'spa')?.pack.id).toBe('software')
  })
})
