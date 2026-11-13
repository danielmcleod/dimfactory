// Sharing a React site safely: the checklist flags variables a build puts into the page as public (and one named like
// a secret as a problem), treats a Google browser key as a key to restrict rather than a secret, and gives advice that
// is right for a static site; the upload file refuses a real secret with that advice and takes a restrictable key with
// a warning; "Get it ready to share" knows the build command and what its result means; and each host's steps say how
// inner pages of a single-page app open.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCommandOf, buildResultOf } from '@core/deploy/build.ts'
import { isPublicEnvName, looksSecretName, runChecklist, secretAdvice } from '@core/deploy/checklist.ts'
import { SPA_ROUTING_STEP, classSteps, placeholderValues } from '@core/deploy/commands.ts'
import { emptySignals, readDeploySignals } from '@core/deploy/signals.ts'
import { UPLOAD_SECRET_ADVICE, makeUploadFile, uploadView } from '@core/deploy/upload.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import type { VerifyCommandResult } from '@shared/verify.ts'

// Synthesized key shapes (never real keys).
const GOOGLE_KEY = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('')
const OPENAI_KEY = ['sk-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'].join('')

let root: string
let project: string

function write(rel: string, content: string): void {
  const p = join(project, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dimf-share-'))
  project = join(root, 'site')
  mkdirSync(project)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('variables and keys a page makes public', () => {
  it('names a build puts into the page, and names that look secret', () => {
    for (const n of ['VITE_API_URL', 'NEXT_PUBLIC_SITE', 'REACT_APP_X', 'PUBLIC_KEY_ID', 'EXPO_PUBLIC_A'])
      expect(isPublicEnvName(n), n).toBe(true)
    expect(isPublicEnvName('OPENAI_API_KEY')).toBe(false)
    expect(looksSecretName('VITE_OPENAI_API_KEY')).toBe(true)
    expect(looksSecretName('VITE_STRIPE_SECRET')).toBe(true)
    expect(looksSecretName('VITE_SUPABASE_ANON_KEY')).toBe(false)
    expect(looksSecretName('VITE_GOOGLE_MAPS_KEY')).toBe(false)
    expect(looksSecretName('VITE_SITE_URL')).toBe(false)
  })

  it('the checklist flags them, and one named like a secret is a problem', async () => {
    write('src/api.ts', 'export const url = import.meta.env.VITE_SUPABASE_URL\n')
    let r = await runChecklist(project, 'spa')
    const pub = r.items.find((i) => i.id === 'env-public')
    expect(pub?.state).toBe('warn')
    expect(pub?.evidence).toEqual(['VITE_SUPABASE_URL (public: built into the page)'])
    expect(r.env.find((v) => v.name === 'VITE_SUPABASE_URL')?.public).toBe(true)
    write('src/ai.ts', 'const key = import.meta.env.VITE_OPENAI_API_KEY\n')
    r = await runChecklist(project, 'spa')
    const bad = r.items.find((i) => i.id === 'env-public')
    expect(bad?.state).toBe('problem')
    expect(bad?.detail).toMatch(/server function/)
    expect(bad?.evidence).toContain('VITE_OPENAI_API_KEY (public: built into the page; named like a secret)')
    // A server's own variable is not public.
    rmSync(join(project, 'src'), { recursive: true })
    write('server.js', 'const key = process.env.OPENAI_API_KEY\n')
    r = await runChecklist(project, 'server-app')
    expect(r.items.find((i) => i.id === 'env-public')).toBeUndefined()
  })

  it('a Google browser key is a key to restrict, not a secret; a real secret gets advice right for its kind', async () => {
    write('src/map.ts', `export const MAPS = '${GOOGLE_KEY}'\n`)
    let r = await runChecklist(project, 'spa')
    expect(r.items.find((i) => i.id === 'secrets')?.state).toBe('ok')
    const keys = r.items.find((i) => i.id === 'public-keys')
    expect(keys?.state).toBe('warn')
    expect(keys?.detail).toMatch(/Website restrictions/)
    write('src/ai.ts', `export const KEY = '${OPENAI_KEY}'\n`)
    r = await runChecklist(project, 'spa')
    const secrets = r.items.find((i) => i.id === 'secrets')
    expect(secrets?.state).toBe('problem')
    expect(secrets?.detail).toMatch(/A website's files are public/)
    expect(secrets?.detail).not.toMatch(/Move each to an environment variable/)
    expect(secretAdvice('server-app')).toMatch(/Move each to an environment variable/)
    expect(secretAdvice('static-site')).toMatch(/server function/)
  })

  it('the upload file refuses a real secret with the static advice, and takes a restrictable key with a warning', async () => {
    write('dist/index.html', '<!doctype html><title>x</title>')
    write('dist/assets/map.js', `const k='${GOOGLE_KEY}'`)
    const ok = await makeUploadFile({
      folder: project,
      dir: 'dist',
      outDir: root,
      baseName: 'site',
      game: false,
    })
    if (ok.status !== 'made') throw new Error(ok.reason)
    expect(ok.warning).toMatch(/can be read by anyone/)
    expect(ok.warning).toMatch(/Website restrictions/)
    expect(ok.warnings?.[0]).toMatch(/^assets\/map\.js:1 /)
    write('dist/assets/ai.js', `const k='${OPENAI_KEY}'`)
    const no = await makeUploadFile({
      folder: project,
      dir: 'dist',
      outDir: root,
      baseName: 'site',
      game: false,
    })
    expect(no.status).toBe('refused')
    if (no.status === 'refused') {
      expect(no.reason).toContain(UPLOAD_SECRET_ADVICE)
      expect(no.reason).not.toMatch(/environment variable/)
    }
  })
})

describe('Get it ready to share', () => {
  it('knows the build command, and the upload view names it while dist/ is missing', async () => {
    expect(await buildCommandOf(project)).toBeNull()
    write(
      'package.json',
      JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '7' } }),
    )
    expect(await buildCommandOf(project)).toEqual({ argv: ['npm', 'run', 'build'], display: 'npm run build' })
    const signals = await readDeploySignals(project)
    const v = await uploadView(project, signals, 'spa', { game: false })
    expect(v).toMatchObject({ dir: 'dist', ready: false, build: { command: 'npm run build' } })
    expect(v?.problem).toMatch(/Get it ready to share first/)
    write('dist/index.html', '<!doctype html>')
    expect(await uploadView(project, signals, 'spa', { game: false })).toMatchObject({
      dir: 'dist',
      ready: true,
      build: { command: 'npm run build' },
    })
    // A plain page served as it is has nothing to build.
    expect(
      (await uploadView(project, { ...emptySignals('x'), html: true }, 'static-site', { game: false }))
        ?.build,
    ).toBeUndefined()
  })

  it('a finished build: built, failed with its output, or could not run', () => {
    const base: VerifyCommandResult = {
      name: 'build',
      argv: ['npm', 'run', 'build'],
      status: 'pass',
      exitCode: 0,
      durationMs: 4200,
      excerpt: '',
      logPath: '',
    }
    expect(buildResultOf(base, 'dist')).toEqual({ status: 'built', dir: 'dist', durationMs: 4200 })
    const failed = buildResultOf({ ...base, status: 'fail', exitCode: 1, excerpt: 'error TS2304' }, 'dist')
    expect(failed).toMatchObject({ status: 'failed', excerpt: 'error TS2304' })
    const env = buildResultOf(
      { ...base, status: 'env', exitCode: null, reason: 'Dim Factory could not find npm' },
      'dist',
    )
    expect(env.status === 'failed' && env.reason).toMatch(/npm install/)
  })
})

describe("a single-page app's inner pages on each host", () => {
  const software = readBuiltinPacks().find((v) => v.pack.id === 'software')?.pack
  const targets = software?.deploy?.targets ?? []
  const values = placeholderValues(emptySignals('site'), 'spa')

  it('each static host says how a link to an inner page opens', () => {
    for (const id of ['netlify', 'cloudflare-pages', 'github-pages', 'vercel']) {
      const t = targets.find((x) => x.id === id)
      if (t === undefined) throw new Error(id)
      const steps = classSteps(t, 'spa', values, 'powershell')
      const last = steps.at(-1)
      expect(last?.id, id).toBe(`${id}:spa`)
      expect(last?.note, id).toBe(SPA_ROUTING_STEP[id])
      // A plain static site needs none.
      expect(classSteps(t, 'static-site', values, 'powershell').some((s) => s.id.endsWith(':spa'))).toBe(
        false,
      )
    }
    expect(SPA_ROUTING_STEP['netlify']).toMatch(/_redirects/)
    expect(SPA_ROUTING_STEP['github-pages']).toMatch(/404\.html/)
    expect(Object.values(SPA_ROUTING_STEP).join(' ')).not.toMatch(/[–—]/)
  })
})
