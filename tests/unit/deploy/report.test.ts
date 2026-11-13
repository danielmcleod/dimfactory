// The Deploy helper's report for a folder (deploy.inspect, `dimf deploy`) and the Deploy step's plan: the class with
// the brief and the user's pick, the options with their steps and the caveats, the checklist with the folder's ticks,
// and the config files the step would write (only the missing ones; .env.example only when the code reads variables
// it does not list).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEPLOY_COMMANDS_CAVEAT,
  DEPLOY_CONFIG_PATH,
  DEPLOY_COST_CAVEAT,
  DEPLOY_SECURITY_CAVEAT,
} from '@shared/deploy.ts'
import { filesToWrite, inspectDeploy, planDeploy, presentConfigs } from '@core/deploy/report.ts'
import { readDeployTicks, setDeployTick } from '@core/deploy/store.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'

const packs = readBuiltinPacks().map((v) => v.pack)
const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dimf-report-'))
  temps.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  return dir
}

const EXPRESS = {
  'package.json':
    '{"name":"@acme/shop","version":"2.0.0","dependencies":{"express":"4"},"scripts":{"start":"node server.js"}}',
  'server.js': 'const port = process.env.PORT\nconst db = process.env.DATABASE_URL\n',
}

describe('inspectDeploy', () => {
  it('offers "Make an upload file" for a static site (itch.io steps for a game), not for a server app', async () => {
    const site = folder({ 'index.html': '<p>hi</p>' })
    const r = await inspectDeploy({ folder: site, packs, branch: null })
    expect(r.cls.id).toBe('static-site')
    expect(r.upload).toEqual({ dir: '.', ready: true, game: false })
    expect(r.options.map((o) => o.id)).toEqual(expect.arrayContaining(['surge', 'firebase-hosting']))
    const game = await inspectDeploy({
      folder: site,
      packs,
      branch: null,
      brief: { category: 'games', fields: {} },
    })
    expect(game.upload?.game).toBe(true)
    const server = await inspectDeploy({ folder: folder(EXPRESS), packs, branch: null })
    expect(server.upload).toBeUndefined()
  })

  it('classifies, offers the targets with their steps, carries every caveat, and checks the folder', async () => {
    const dir = folder(EXPRESS)
    const r = await inspectDeploy({ folder: dir, packs, branch: 'main', platform: 'linux' })
    expect(r.cls).toMatchObject({ id: 'server-app', source: 'folder' })
    expect(r.category).toBe('software')
    expect(r.target).toBe('render')
    expect(r.options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['render', 'fly', 'railway', 'vps-docker']),
    )
    expect(r.caveats).toEqual({
      cost: DEPLOY_COST_CAVEAT,
      security: DEPLOY_SECURITY_CAVEAT,
      commands: DEPLOY_COMMANDS_CAVEAT,
    })
    const vps = r.options.find((o) => o.id === 'vps-docker')
    expect(vps?.steps.map((s) => s.command)).toContain(
      'docker run -d --name shop --restart unless-stopped --env-file .env -p 3000:3000 shop',
    )
    expect(vps?.steps.every((s) => s.shell === 'sh')).toBe(true)
    expect(r.env.map((v) => v.name)).toEqual(['DATABASE_URL', 'PORT'])
    expect(r.checklist.find((i) => i.id === 'env-vars')?.state).toBe('warn')
    expect(r.classes).toHaveLength(9)
  })

  it("follows the user's class pick and the run's chosen target, and carries the folder's ticks", async () => {
    const dir = folder(EXPRESS)
    const r = await inspectDeploy({
      folder: dir,
      packs,
      cls: 'container',
      target: 'fly',
      ticks: { https: 99 },
      branch: null,
      platform: 'win32',
    })
    expect(r.cls).toMatchObject({ id: 'container', source: 'user' })
    expect(r.target).toBe('fly')
    expect(r.options.find((o) => o.recommended)?.id).toBe('fly')
    expect(r.checklist.find((i) => i.id === 'https')?.tickedAt).toBe(99)
    expect(r.options[0]?.steps[0]?.shell).toBe('powershell')
  })

  it("a brief in another category uses its pack, and the brief's hosting choice picks the target", async () => {
    const docs = folder({ 'mkdocs.yml': 'site_name: x\n', 'docs/index.md': '# hi\n' })
    const r = await inspectDeploy({
      folder: docs,
      packs,
      brief: { category: 'documents', fields: { format: { choices: ['html-site'] } } },
      branch: 'main',
    })
    expect(r.cls).toMatchObject({ id: 'docs-site', source: 'brief' })
    expect(r.category).toBe('documents')
    expect(r.options.find((o) => o.id === 'netlify')?.steps.map((s) => s.command)).toContain(
      'npx netlify-cli deploy --prod --dir site',
    )
    const app = folder(EXPRESS)
    const hosted = await inspectDeploy({
      folder: app,
      packs,
      brief: { category: 'software', fields: { hosting: { choices: ['self-hosted'] } } },
      branch: 'main',
    })
    expect(hosted.target).toBe('vps-docker')
  })
})

describe('the Deploy step plan', () => {
  it('lists only the missing config files of the target, and .env.example when variables are unlisted', async () => {
    const dir = folder({ ...EXPRESS, Dockerfile: 'FROM node:20\n' })
    const p = await planDeploy({ folder: dir, packs, target: 'fly', branch: 'main' })
    expect(p.target).toEqual({ id: 'fly', label: 'Fly.io' })
    expect(p.files.map((f) => f.path)).toEqual(['fly.toml', '.env.example'])
    expect(p.present).toEqual(['Dockerfile'])
    expect(p.env).toEqual(['DATABASE_URL', 'PORT'])
    // A Dockerfile makes it a container deliverable; Fly.io serves both.
    expect(p.cls.id).toBe('container')
  })

  it('a target whose config is all there has nothing to write', async () => {
    const dir = folder({ 'index.html': '<p>x</p>', 'netlify.toml': '[build]\n' })
    const p = await planDeploy({ folder: dir, packs, target: 'netlify', branch: 'main' })
    expect(p.files).toEqual([])
    expect(p.present).toEqual(['netlify.toml'])
  })

  it('filesToWrite keeps the kinds order and never rewrites a file that is there', () => {
    const present = new Set([DEPLOY_CONFIG_PATH.dockerfile])
    expect(filesToWrite(['fly', 'dockerfile', 'env-example'], present, []).map((f) => f.kind)).toEqual([
      'fly',
    ])
    expect(filesToWrite(['netlify'], new Set(), ['API_KEY']).map((f) => f.kind)).toEqual([
      'netlify',
      'env-example',
    ])
  })

  it('presentConfigs finds the workflow file in its folder', async () => {
    const dir = folder({ '.github/workflows/deploy.yml': 'on: push\n' })
    expect([...(await presentConfigs(dir))]).toEqual(['.github/workflows/deploy.yml'])
  })
})

describe('checklist ticks', () => {
  it('are kept per folder, and an untick removes one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dimf-home-'))
    temps.push(home)
    const dir = folder({})
    expect(await readDeployTicks(home, dir)).toEqual({})
    expect(await setDeployTick(home, dir, 'https', 5)).toEqual({ https: 5 })
    expect(await setDeployTick(home, dir, 'backups', 6)).toEqual({ https: 5, backups: 6 })
    expect(await setDeployTick(home, dir, 'https', null)).toEqual({ backups: 6 })
    expect(await readDeployTicks(home, dir)).toEqual({ backups: 6 })
  })
})
