// Run & Preview detection corpus: one fixture folder per way to run a project, written to a temp dir. Package scripts
// (dev, start, preview; the package manager as Verify finds it; Electron's own window), index.html for the static
// server (the folder first, then docs/ dist/ …), Python entry points (Django, Streamlit, FastAPI, Flask, a plain
// script; uv/poetry runners), docker compose (with its published port), cargo run, go run, notebooks, the packs'
// strategies as data, the order commands are offered in, de-duplication, trust read against grants, and RUN.md.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pack } from '../../../src/shared/brief.ts'
import { PackZ } from '../../../src/shared/brief.ts'
import { readBuiltinPacks } from '../../../src/core/packs/load.ts'
import {
  composeUrlHint,
  detectPreviewCommands,
  pythonEntry,
  readRunMd,
} from '../../../src/core/preview/detect.ts'
import { previewGrantCommand, previewHash } from '../../../src/core/preview/trust.ts'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import { pkg, removeDir, tempDir, writeFiles } from '../verify/helpers.ts'
import type { Files } from '../verify/helpers.ts'

let root = ''
beforeEach(() => {
  root = tempDir('dim-factory-preview-')
})
afterEach(() => removeDir(root))

async function detect(
  files: Files,
  o: { packs?: Pack[]; grants?: TrustGrants; platform?: NodeJS.Platform } = {},
) {
  writeFiles(root, files)
  return detectPreviewCommands({ folder: root, platform: o.platform ?? 'linux', ...o })
}

const ids = (list: readonly { id: string }[]): string[] => list.map((c) => c.id)

describe('package scripts', () => {
  it('offers dev, start and preview in that order with the package manager Verify finds', async () => {
    const list = await detect({
      'package.json': pkg({
        preview: 'vite preview',
        start: 'node server.js',
        dev: 'vite',
        build: 'vite build',
      }),
      'pnpm-lock.yaml': '',
    })
    expect(ids(list)).toEqual(['pkg:dev', 'pkg:start', 'pkg:preview'])
    expect(list[0]).toMatchObject({
      label: 'pnpm run dev',
      argv: ['pnpm', 'run', 'dev'],
      kind: 'server',
      source: 'package.json',
      cwdRel: '.',
      trust: 'untrusted',
    })
    expect(list[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads an Electron app as its own window, with or without a script', async () => {
    const withScript = await detect({
      'package.json': pkg({ dev: 'electron-vite dev' }, { devDependencies: { electron: '44.0.0' } }),
    })
    expect(withScript.map((c) => [c.id, c.kind, c.source])).toEqual([['pkg:dev', 'app', 'electron']])
    removeDir(root)
    root = tempDir('dim-factory-preview-')
    const bare = await detect({
      'package.json': pkg({}, { main: 'main.js', devDependencies: { electron: '44.0.0' } }),
    })
    expect(bare.map((c) => [c.id, c.argv])).toEqual([['electron', ['electron', '.']]])
  })

  it('finds nothing in an empty folder or a package with no start script', async () => {
    expect(await detect({})).toEqual([])
    expect(await detect({ 'package.json': pkg({ build: 'tsc', test: 'vitest' }) })).toEqual([])
  })
})

describe('static files', () => {
  it('serves index.html of the folder first, then docs/, dist/ and the rest (three at most)', async () => {
    const list = await detect({
      'index.html': '<h1>root</h1>',
      'docs/index.html': '',
      'dist/index.html': '',
      'build/index.html': '',
    })
    expect(list.map((c) => [c.id, c.label, c.staticRoot, c.trust])).toEqual([
      ['static:.', 'Serve index.html', '.', 'none'],
      ['static:docs', 'Serve docs/index.html', 'docs', 'none'],
      ['static:dist', 'Serve dist/index.html', 'dist', 'none'],
    ])
    expect(list.every((c) => c.argv.length === 0 && c.kind === 'static')).toBe(true)
  })

  it('comes after the commands that start the project', async () => {
    const list = await detect({ 'package.json': pkg({ dev: 'vite' }), 'index.html': '' })
    expect(ids(list)).toEqual(['pkg:dev', 'static:.'])
  })
})

describe('python', () => {
  it('reads Django, Streamlit, FastAPI, Flask and a plain script', () => {
    expect(pythonEntry('app.py', 'import streamlit as st\n', 'python3').argv).toEqual([
      'streamlit',
      'run',
      'app.py',
      '--server.headless',
      'true',
    ])
    expect(pythonEntry('main.py', 'from fastapi import FastAPI\napi = FastAPI()\n', 'python3')).toEqual({
      argv: ['uvicorn', 'main:api'],
      kind: 'server',
    })
    expect(
      pythonEntry('main.py', 'import uvicorn\napp = FastAPI()\nuvicorn.run(app)\n', 'python3').argv,
    ).toEqual(['python3', 'main.py'])
    expect(pythonEntry('app.py', 'from flask import Flask\napp = Flask(__name__)\n', 'python').argv).toEqual([
      'flask',
      '--app',
      'app',
      'run',
    ])
    expect(pythonEntry('run.py', 'print("hi")\n', 'python')).toMatchObject({
      argv: ['python', 'run.py'],
      kind: 'command',
    })
  })

  it("prefixes uv's or poetry's runner and uses python on Windows", async () => {
    const list = await detect(
      { 'manage.py': '', 'main.py': 'print(1)\n', 'uv.lock': '' },
      { platform: 'win32' },
    )
    expect(list.map((c) => c.argv)).toEqual([
      ['uv', 'run', 'python', 'manage.py', 'runserver'],
      ['uv', 'run', 'python', 'main.py'],
    ])
  })
})

describe('compose, cargo, go and notebooks', () => {
  it('reads docker compose with its first published port as the expected address', async () => {
    const list = await detect({
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n',
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'docker:compose',
      argv: ['docker', 'compose', 'up'],
      urlHint: 'http://127.0.0.1:8080/',
    })
    expect(composeUrlHint('ports:\n  - 127.0.0.1:3000:3000\n')).toBe('http://127.0.0.1:3000/')
    expect(composeUrlHint('image: x\n')).toBeUndefined()
  })

  it('runs a Rust binary, a web server when it depends on one', async () => {
    const cli = await detect({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/main.rs': 'fn main() {}' })
    expect(cli.map((c) => [c.argv, c.kind])).toEqual([[['cargo', 'run'], 'command']])
    removeDir(root)
    root = tempDir('dim-factory-preview-')
    const web = await detect({
      'Cargo.toml': '[package]\nname = "x"\n[dependencies]\naxum = "0.8"\n',
      'src/main.rs': '',
    })
    expect(web[0]?.kind).toBe('server')
    removeDir(root)
    root = tempDir('dim-factory-preview-')
    expect(await detect({ 'Cargo.toml': '[package]\nname = "lib"\n', 'src/lib.rs': '' })).toEqual([])
  })

  it('runs go main packages at the root or under cmd/', async () => {
    const root1 = await detect({
      'go.mod': 'module x\n',
      'main.go': 'package main\nimport "net/http"\n',
    })
    expect(root1.map((c) => [c.argv, c.kind])).toEqual([[['go', 'run', '.'], 'server']])
    removeDir(root)
    root = tempDir('dim-factory-preview-')
    const cmd = await detect({ 'go.mod': 'module x\n', 'cmd/tool/main.go': 'package main\n' })
    expect(cmd.map((c) => [c.argv, c.kind])).toEqual([[['go', 'run', './cmd/tool'], 'command']])
  })

  it('opens notebooks in JupyterLab', async () => {
    const list = await detect({ 'analysis.ipynb': '{}' })
    expect(list.map((c) => c.argv)).toEqual([['jupyter', 'lab', '--no-browser']])
  })
})

describe('packs add strategies as data', () => {
  const builtins = readBuiltinPacks().map((v) => v.pack)

  it('the built-in packs validate with their strategies', () => {
    for (const p of builtins) expect(PackZ.safeParse(p).success).toBe(true)
    const all = builtins.flatMap((p) => (p.preview ?? []).map((s) => `${p.id}:${s.id}`))
    expect(all).toEqual(
      expect.arrayContaining(['documents:mkdocs', 'data:streamlit', 'data:quarto', 'software:php']),
    )
  })

  it("offers a pack's strategy when its files are there, with its expected address", async () => {
    const list = await detect({ 'mkdocs.yml': 'site_name: x\n', 'index.php': '<?php' }, { packs: builtins })
    expect(list.map((c) => [c.id, c.argv, c.urlHint])).toEqual([
      ['pack:software:php', ['php', '-S', '127.0.0.1:8000'], 'http://127.0.0.1:8000/'],
      ['pack:documents:mkdocs', ['mkdocs', 'serve'], undefined],
    ])
  })

  it('needs every file a strategy names, and refuses a pack with a shell-like argument line', async () => {
    expect(await detect({ '_config.yml': '' }, { packs: builtins })).toEqual([])
    const bad = {
      ...builtins[0],
      preview: [{ id: 'x', when: { files: ['a'] }, run: ['a\nb'], kind: 'server' }],
    }
    expect(PackZ.safeParse(bad).success).toBe(false)
    const badUrl = {
      ...builtins[0],
      preview: [{ id: 'x', when: { files: ['a'] }, run: ['a'], kind: 'server', url: 'https://example.com/' }],
    }
    expect(PackZ.safeParse(badUrl).success).toBe(false)
  })

  it('leaves out a command an earlier one already offers', async () => {
    const pack = {
      ...builtins[0],
      id: 'extra',
      preview: [{ id: 'dup', when: { files: ['package.json'] }, run: ['npm', 'run', 'dev'], kind: 'server' }],
    } as Pack
    const list = await detect({ 'package.json': pkg({ dev: 'vite' }) }, { packs: [pack] })
    expect(ids(list)).toEqual(['pkg:dev'])
  })
})

describe('trust', () => {
  it("reads trusted against a preview grant for the script body, never a verify grant's", async () => {
    const files = { 'package.json': pkg({ dev: 'vite' }) }
    const first = await detect(files)
    const dev = first[0]
    expect(dev?.trust).toBe('untrusted')
    const body = JSON.stringify({ dev: 'vite' }, null, 2)
    const grant = previewGrantCommand({ argv: ['npm', 'run', 'dev'], cwdRel: '.' }, body)
    expect(dev?.hash).toBe(previewHash({ argv: ['npm', 'run', 'dev'], cwdRel: '.' }, body))
    const verifyGrant = { ...grant, kind: 'verify' as const }
    const onlyVerify: TrustGrants = {
      commands: { [commandGrantHash(verifyGrant)]: { ...verifyGrant, argv: [...verifyGrant.argv], at: 1 } },
    }
    expect((await detectPreviewCommands({ folder: root, grants: onlyVerify }))[0]?.trust).toBe('untrusted')
    const granted: TrustGrants = {
      commands: { [dev?.hash ?? '']: { ...grant, argv: [...grant.argv], at: 1 } },
    }
    expect((await detectPreviewCommands({ folder: root, grants: granted }))[0]?.trust).toBe('trusted')
    // A changed script needs a new grant.
    writeFiles(root, { 'package.json': pkg({ dev: 'vite --host 0.0.0.0' }) })
    expect((await detectPreviewCommands({ folder: root, grants: granted }))[0]?.trust).toBe('changed')
  })

  it("covers a compose command's compose files", async () => {
    const list = await detect({
      'docker-compose.yml': 'services: {}\n',
      'docker-compose.override.yml': 'x: 1\n',
    })
    const before = list[0]?.hash
    writeFiles(root, { 'docker-compose.override.yml': 'x: 2\n' })
    const after = (await detectPreviewCommands({ folder: root }))[0]?.hash
    expect(before).not.toBe(after)
  })

  it('keeps cwdRel relative to the scope root', async () => {
    writeFiles(root, { 'web/package.json': pkg({ dev: 'vite' }) })
    const list = await detectPreviewCommands({ folder: join(root, 'web'), scopeRoot: root })
    expect(list[0]?.cwdRel).toBe('web')
  })
})

describe('RUN.md', () => {
  it('reads it in any case, cut at the cap', async () => {
    writeFiles(root, { 'Run.md': '# How to run\n\n- npm start\n' })
    expect(await readRunMd(root, 1000)).toEqual({ text: '# How to run\n\n- npm start\n', truncated: false })
    expect(await readRunMd(root, 5)).toEqual({ text: '# How', truncated: true })
    removeDir(root)
    root = tempDir('dim-factory-preview-')
    expect(await readRunMd(root, 1000)).toBeNull()
  })
})
