// The optional light 3D game (game-3d-lite): three.js is never bundled with Dim Factory. The template's project
// installs it from npm into its own node_modules (package.json lists it; needs Node.js) and loads it with an import
// map, so no bundler is needed and the preview stays offline (the static server serves node_modules from the same
// origin). Easy picks the template from words like 3D, three.js or marble only when Node.js is there, and otherwise
// makes the game in 2D and says why. The bundled file list is what it was (no three.js), the packaged app holds no
// three.js, and the Deploy helper names three.js's licence from node_modules.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installedLicences, runChecklist } from '@core/deploy/checklist.ts'
import { EasyService } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { GAME_3D_TEMPLATE, chooseTemplate, detectKind, easyTask, ideaBrief } from '@core/easy/resolve.ts'
import { silentLogger } from '@core/log.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { startStaticServer } from '@core/preview/static-server.ts'
import { copyTemplateFiles, readVendorManifest } from '@core/templates/files.ts'
import {
  BUILTIN_TEMPLATE_IDS,
  loadTemplates,
  readBuiltinTemplates,
  templatePackProblem,
} from '@core/templates/load.ts'
import { TEMPLATE_TASK_MAX, TemplateZ } from '@shared/templates.ts'
import type { Template } from '@shared/templates.ts'
import { fallbackText, installsText } from '@renderer/pages/easy/text.ts'
import { layoutMarble3d, THREE_DIR } from './marble3d-fixture.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const packs = readBuiltinPacks().map((v) => v.pack)
const template = (id: string): Template => readBuiltinTemplates().find((t) => t.id === id) as Template
const NODE = { node: true, python: false }
const NONE = { node: false, python: false }
const THREE_VERSION = (
  JSON.parse(readFileSync(join(THREE_DIR, 'package.json'), 'utf8')) as { version: string }
).version

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-games3d-'))
  dirs.push(d)
  return d
}

describe('the game-3d-lite template', () => {
  const t = template(GAME_3D_TEMPLATE)

  it('is a built-in Games template that fits its pack and the task cap', () => {
    expect(BUILTIN_TEMPLATE_IDS).toContain('game-3d-lite')
    expect(TemplateZ.safeParse(t).success).toBe(true)
    expect(t.pack).toBe('games')
    expect(t.recipe).toBe('new-game')
    expect(templatePackProblem(t, packs)).toBeNull()
    expect(t.task.length).toBeLessThanOrEqual(TEMPLATE_TASK_MAX)
    expect(t.brief.fields['engine']?.choices).toEqual(['threejs'])
    expect(t.fullOnly).toBeUndefined()
    for (const text of [t.label, t.description, t.task]) expect(text).not.toMatch(/[–—]/)
    // Every game's must-haves, as the other game templates ask for them.
    expect(t.task).toContain('playtest.json')
    expect(t.task).toContain('never copy a famous game')
    expect(t.task).toContain('pause with P or Esc')
  })

  it('installs three.js into the project with npm and loads it from node_modules with an import map', () => {
    expect(t.installs).toEqual([{ package: 'three', name: 'three.js', license: 'MIT' }])
    expect(t.description).toMatch(/installs itself with npm/)
    expect(t.description).toMatch(/does not bundle it/)
    expect(t.description).toMatch(/Needs Node\.js/)
    // package.json lists three (pinned to the current release line); the install names no package, so the Easy
    // project permission ("installing what the project lists") covers it.
    expect(t.task).toContain(`"three": "^0.186.1"`)
    expect(t.task).toContain('then run npm install with no package names')
    expect(t.task).toContain('"three":"./node_modules/three/build/three.module.js"')
    expect(t.task).toContain('Never load three.js from a CDN')
    expect(t.task).toContain('If the folder already uses Vite')
    expect(t.task).toContain('Add a .gitignore for node_modules')
    expect(t.task).toContain('credits (three.js, MIT, installed with npm')
    // The pin covers the copy this repository tests with.
    expect(THREE_VERSION).toMatch(/^0\.186\.\d+$/)
  })

  it('copies only the starter files: never three.js, never node_modules', async () => {
    const project = temp()
    const written = await copyTemplateFiles({ template: t, layer: 'builtin' }, project)
    expect(written.sort()).toEqual(
      [
        'docs/game-test-hook.md',
        'lib/VENDORED.md',
        'src/engine/input.js',
        'src/engine/loop.js',
        'src/engine/rng.js',
        'src/engine/storage.js',
        'src/engine/test-hook.js',
      ].sort(),
    )
    expect(existsSync(join(project, 'node_modules'))).toBe(false)
    expect(existsSync(join(project, 'lib', 'LICENSES'))).toBe(false)
    expect(readFileSync(join(project, 'lib', 'VENDORED.md'), 'utf8')).not.toMatch(/three/i)
  })

  it('is listed for New project with the other games', async () => {
    const list = await loadTemplates({ home: temp() })
    expect(list.issues).toEqual([])
    const games = list.templates.filter((v) => v.template.pack === 'games').map((v) => v.template.id)
    expect(games.indexOf('game-3d-lite')).toBe(games.indexOf('game-vite') + 1)
  })

  it('a user template may name a library it installs, but never a malformed package', () => {
    const base = { ...t, files: undefined }
    expect(
      TemplateZ.safeParse({ ...base, installs: [{ package: '../x', name: 'x', license: 'MIT' }] }).success,
    ).toBe(false)
    expect(
      TemplateZ.safeParse({ ...base, installs: [{ package: '@scope/lib', name: 'Lib', license: 'MIT' }] })
        .success,
    ).toBe(true)
  })
})

describe('the bundled file list and the app stay free of three.js', () => {
  it('the vendor manifest is unchanged: the starter files and Phaser, nothing else', async () => {
    const m = await readVendorManifest()
    // The web starter's files (Dim Factory's own, MIT) are their own entries after the game's.
    expect(m.entries.filter((e) => !e.id.startsWith('react-')).map((e) => e.id)).toEqual([
      'game-loop',
      'game-rng',
      'game-input',
      'game-storage',
      'game-test-hook',
      'game-test-hook-doc',
      'game-server',
      'game-rooms',
      'game-server-doc',
      'phaser',
    ])
    expect(JSON.stringify(m)).not.toMatch(/three/i)
    const vendor = join(REPO, 'src', 'core', 'templates', 'vendor')
    expect(readdirSync(join(vendor, 'third-party'))).toEqual(['phaser'])
  })

  it('three is a devDependency of Dim Factory only, and the packaged app ships no node_modules', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    expect(pkg['devDependencies']?.['three']).toMatch(/^\^0\.186\./)
    expect(pkg['dependencies']?.['three']).toBeUndefined()
    const builder = readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/^files:\n {2}- out\/\*\*\n {2}- package\.json\n/m)
    // No app source imports three.js (electron-vite bundles every import, so an import would ship it).
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'vendor') walk(p)
        } else if (
          /\.(?:ts|tsx|js|mjs)$/.test(e.name) &&
          /from\s+['"]three(?:\/[^'"]*)?['"]/.test(readFileSync(p, 'utf8'))
        )
          hits.push(p)
      }
    }
    walk(join(REPO, 'src'))
    expect(hits).toEqual([])
  })

  it('a packaged app.asar (when one was built) holds no three.js', () => {
    const dist = join(REPO, 'dist')
    const asars = existsSync(dist)
      ? readdirSync(dist)
          .filter((d) => d.endsWith('-unpacked') || /^mac/.test(d))
          .map((d) => join(dist, d, 'resources', 'app.asar'))
          .filter((p) => existsSync(p))
      : []
    for (const asar of asars) {
      const files = asarFiles(asar)
      expect(files.length, asar).toBeGreaterThan(0)
      expect(
        files.filter((f) => /(?:^|\/)node_modules\//.test(f)),
        asar,
      ).toEqual([])
      expect(
        files.filter((f) => /three/i.test(f)),
        asar,
      ).toEqual([])
    }
  })
})

/** The file paths an asar archive holds (its JSON header; no dependency needed to read it). */
function asarFiles(file: string): string[] {
  const buf = readFileSync(file)
  // A pickle of the header size, then a pickle holding the header JSON: [payload size][string length][string].
  const len = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + len).toString('utf8')) as AsarDir
  const out: string[] = []
  const walk = (dir: AsarDir, prefix: string): void => {
    for (const [name, node] of Object.entries(dir.files)) {
      const p = prefix === '' ? name : `${prefix}/${name}`
      if ('files' in node) walk(node, p)
      else out.push(p)
    }
  }
  walk(header, '')
  return out
}
interface AsarDir {
  files: Record<string, AsarDir | { size?: number }>
}

describe('Easy picks the 3D template only with Node.js', () => {
  it.each([
    'A 3D marble game where you tilt the board',
    'A three.js game with a spinning cube to dodge',
    'A threejs flying game through rings',
    'A 3D maze I can roll a ball through',
    'A marble run game for my kids',
  ])('"%s" is a game in 3D', (idea) => {
    expect(detectKind(idea, packs).kind).toBe('game')
    expect(chooseTemplate('game', idea, NODE)).toEqual({ templateId: 'game-3d-lite' })
  })

  it('a 3D maze or a marble run on its own is a game', () => {
    expect(detectKind('a 3d maze', packs)).toEqual({ kind: 'game', source: 'words' })
    expect(detectKind('A marble run with ramps', packs)).toEqual({ kind: 'game', source: 'words' })
  })

  it('without Node.js it falls back to a 2D template and says what it wanted', () => {
    expect(chooseTemplate('game', 'A 3D marble game where you tilt the board', NONE)).toEqual({
      templateId: 'game-canvas',
      fallback: { wanted: 'game-3d-lite', needs: 'node' },
    })
    // Its nearest flat form is a game drawn on a canvas, whatever else the idea names.
    expect(chooseTemplate('game', 'A 3D puzzle with sliding tiles', NONE)).toEqual({
      templateId: 'game-canvas',
      fallback: { wanted: 'game-3d-lite', needs: 'node' },
    })
    expect(fallbackText('Light 3D game (three.js)', 'node', 'game-3d-lite')).toBe(
      'A 3D game uses three.js, which is installed into the project with Node.js. Node.js is not installed, so it starts as a 2D game that needs nothing installed.',
    )
  })

  it('a 2D idea never gets the 3D template, and 3D beats Vite', () => {
    expect(chooseTemplate('game', 'A snake game I can play on my phone', NODE).templateId).toBe('game-canvas')
    expect(chooseTemplate('game', 'A space shooter in TypeScript with Vite', NODE).templateId).toBe(
      'game-vite',
    )
    expect(chooseTemplate('game', 'A 3D space shooter in TypeScript', NODE).templateId).toBe('game-3d-lite')
    // Not a game: "3D" alone does not make a website a game.
    expect(chooseTemplate('website', 'A website with a 3D logo', NODE).templateId).toBe('react-site')
  })

  it('the 2D fallback Brief keeps its own engine even when the idea names three.js', () => {
    const idea = 'A three.js game with a spinning cube to dodge'
    const flat = ideaBrief('game', template('game-canvas'), idea, packs)
    expect(flat.fields['engine']?.choices).toEqual(['canvas'])
    const deep = ideaBrief('game', template('game-3d-lite'), idea, packs)
    expect(deep.fields['engine']?.choices).toEqual(['threejs'])
    expect(easyTask(template('game-3d-lite'), idea)).toContain('./node_modules/three/build/three.module.js')
  })

  it('the confirm screen says three.js is installed into the project and needs Node', async () => {
    const svc = (toolchain: typeof NODE): EasyService => {
      const home = temp()
      const deps: EasyDeps = {
        home,
        documentsDir: join(temp(), 'Documents'),
        newHome: false,
        log: silentLogger,
        now: () => 1000,
        readUser: () => Promise.resolve({ easy: { projectsDir: temp() } }),
        patchUser: () => Promise.resolve(),
        packs: () => Promise.resolve(packs),
        templates: () => loadTemplates({ home }),
        readiness: () => ({ claude: true, codex: false, profile: 'claude-only', runnable: true }),
        toolchain: () => Promise.resolve(toolchain),
        estimate: () => Promise.resolve(null),
        prepareFolder: (folder) => Promise.resolve(folder),
        saveBrief: () => Promise.resolve(),
        startRun: () => Promise.resolve({ runId: 'r1', displayNo: 1 }),
        summaries: () => [],
        runTask: () => Promise.resolve(null),
        exists: () => false,
      }
      return new EasyService(deps)
    }
    const idea = 'A 3D marble game where you tilt the board'
    const withNode = await svc(NODE).resolve({ idea })
    expect(withNode.template.id).toBe('game-3d-lite')
    expect(withNode.installs).toEqual(['three.js'])
    expect(withNode.fallback).toBeUndefined()
    expect(installsText(withNode.installs ?? [])).toBe(
      'Uses three.js, installed into the project (needs Node).',
    )
    const without = await svc(NONE).resolve({ idea })
    expect(without.template.id).toBe('game-canvas')
    expect(without.installs).toBeUndefined()
    expect(without.fallback).toEqual({
      wanted: { id: 'game-3d-lite', label: 'Light 3D game (three.js)' },
      needs: 'node',
    })
  })
})

describe('the Games pack says three.js is optional and installed with npm', () => {
  it('the engine hint', () => {
    const games = packs.find((p) => p.id === 'games')
    const three = games?.groups.find((g) => g.id === 'engine')?.options.find((o) => o.id === 'threejs')
    expect(three?.hint).toBe(
      'Light 3D. Optional: installed into the project with npm, not bundled with Dim Factory. Needs Node.js.',
    )
    expect(three?.hint).not.toMatch(/yet/)
  })
})

describe('the 3D fixture over the static server', () => {
  it('serves the page and node_modules/three module files as JavaScript, same origin', async () => {
    const folder = temp()
    layoutMarble3d(folder)
    const server = await startStaticServer(folder)
    try {
      const page = await fetch(`${server.url}index.html`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('"three": "./node_modules/three/build/three.module.js"')
      for (const f of ['three.module.js', 'three.core.js']) {
        const r = await fetch(`${server.url}node_modules/three/build/${f}`)
        expect(r.status, f).toBe(200)
        expect(r.headers.get('content-type'), f).toBe('text/javascript; charset=utf-8')
        expect(r.headers.get('x-content-type-options'), f).toBe('nosniff')
        const body = await r.text()
        expect(body.length, f).toBe(readFileSync(join(THREE_DIR, 'build', f), 'utf8').length)
      }
      // The module reaches the core with a relative import, which resolves on the same server.
      const mod = await (await fetch(`${server.url}node_modules/three/build/three.module.js`)).text()
      expect(mod).toContain("from './three.core.js'")
      const pkg = await fetch(`${server.url}node_modules/three/package.json`)
      expect(pkg.headers.get('content-type')).toBe('application/json; charset=utf-8')
      // Without npm install there is nothing to load (the page then shows nothing, which the play-test reports).
      const bare = temp()
      layoutMarble3d(bare, { three: false })
      const s2 = await startStaticServer(bare)
      try {
        expect((await fetch(`${s2.url}node_modules/three/build/three.module.js`)).status).toBe(404)
      } finally {
        await s2.close()
      }
    } finally {
      await server.close()
    }
  })
})

describe('the Deploy helper names the licences of installed packages', () => {
  it('reads three.js from node_modules/three/package.json', async () => {
    const folder = temp()
    layoutMarble3d(folder)
    expect(await installedLicences(folder)).toEqual([
      { name: 'three', version: THREE_VERSION, license: 'MIT' },
    ])
    const r = await runChecklist(folder, 'static-site')
    const lic = r.items.find((i) => i.id === 'license')
    expect(lic?.detail).toContain('It installs one package to run, with its licence in node_modules.')
    expect(lic?.evidence).toContain(`three ${THREE_VERSION}: MIT (node_modules/three/package.json)`)
  })

  it('says so when a package is not installed yet, and reads nothing outside node_modules', async () => {
    const folder = temp()
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ dependencies: { three: '^0.186.1', '../../evil': '1.0.0' } }),
    )
    mkdirSync(join(folder, 'node_modules'))
    expect(await installedLicences(folder)).toEqual([{ name: 'three', version: null, license: null }])
    expect(await installedLicences(temp())).toEqual([])
  })
})
