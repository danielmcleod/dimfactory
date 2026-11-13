// Security pass, IPC ("ipc.ts(sender check+zod) → core handlers"):
// - one channel in, one out: ipcMain is used only by src/main/ipc.ts, ipcRenderer/contextBridge only by the preload,
//   and the push channel only by push.ts; the preload exposes `window.dimFactory` and nothing else;
// - the sender check: only the main window's live top frame showing the app's renderer passes, and a refused sender
//   reaches nothing (not the envelope check, not a handler, not core);
// - every command's request schema is a strict object all the way down (an unknown key anywhere is refused), with no
//   `any` and an `unknown` only where a refinement or main's own capping judges it (log.write data, JSON patch values);
// - e2e.* exist only under DIM_FACTORY_E2E=1, and a command name that is an Object.prototype key is unknown.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { createRouter } from '../../../src/main/router.ts'
import { senderAllowed, rendererTarget } from '../../../src/main/urls.ts'
import type { SenderInfo } from '../../../src/main/urls.ts'
import { makeEnvelope } from '../../../src/preload/wire.ts'
import { JSON_VALUE_MAX_NODES, REQUEST_SCHEMAS, parseRequest } from '../../../src/shared/ipc-schemas.ts'
import { COMMAND_AREA } from '../../../src/shared/ipc.ts'
import type { Cmd, Result } from '../../../src/shared/ipc.ts'

const SRC = resolve('src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.includes(`${sep}protocol${sep}`))
}
const rel = (f: string): string => relative(resolve('.'), f).split(sep).join('/')
/** Code lines only: `//` comment lines and JSDoc lines are skipped. */
function codeLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
}
function filesUsing(re: RegExp): string[] {
  return sourceFiles(SRC)
    .filter((f) => codeLines(f).some((l) => re.test(l)))
    .map(rel)
    .sort()
}

describe('the IPC surface', () => {
  it('ipcMain is used by src/main/ipc.ts alone, with one handle() and no on()/handleOnce()', () => {
    expect(filesUsing(/\bipcMain\b/)).toEqual(['src/main/ipc.ts'])
    const code = codeLines(resolve('src/main/ipc.ts')).join('\n')
    expect(code.match(/ipcMain\.handle\(/g)).toHaveLength(1)
    expect(code).not.toMatch(/ipcMain\.(on|once|handleOnce|addListener)\(/)
  })

  it('ipcRenderer and contextBridge are the preload entry only; it exposes window.dimFactory alone', () => {
    expect(filesUsing(/\b(ipcRenderer|contextBridge)\b/)).toEqual(['src/preload/index.ts'])
    const code = codeLines(resolve('src/preload/index.ts')).join('\n')
    expect(code.match(/exposeInMainWorld\(/g)).toHaveLength(1)
    expect(code).toMatch(/exposeInMainWorld\(\s*BRAND\.preloadGlobal,/)
    expect(code).not.toMatch(/ipcRenderer\.(send|sendSync|sendTo|postMessage)\b/)
  })

  it('the push channel is sent on by push.ts alone, to the main window', () => {
    expect(filesUsing(/EVT_CHANNEL/)).toEqual([
      'src/main/push.ts',
      'src/preload/bridge.ts',
      'src/shared/ipc.ts',
    ])
    expect(filesUsing(/\.send\(\s*EVT_CHANNEL/)).toEqual(['src/main/push.ts'])
    // No other renderer-facing channel exists.
    expect(filesUsing(/webContents\.send\(|\.sendToFrame\(|postMessage\(/)).toEqual([])
  })

  it('the renderer cannot reach Node or Electron (lint keeps the imports out; nothing slips past as require)', () => {
    const renderer = sourceFiles(join(SRC, 'renderer'))
    const offenders = renderer.filter((f) =>
      codeLines(f).some((l) =>
        /\brequire\(|from '(electron|node:[a-z_/]+)'|import\('(electron|node:)/.test(l),
      ),
    )
    expect(offenders.map(rel)).toEqual([])
  })
})

describe('the sender check', () => {
  const rendererDir = resolve('out', 'renderer')
  const target = rendererTarget({ devUrl: undefined, packaged: true, rendererDir })
  const appUrl = 'app://dim-factory/index.html#/'
  const ok: SenderInfo = { fromMainWindow: true, mainFrame: true, frameUrl: appUrl }

  it('passes only the main window, its live top frame, on the app page', () => {
    expect(senderAllowed(ok, target)).toBe(true)
    expect(senderAllowed({ ...ok, fromMainWindow: false }, target)).toBe(false)
    expect(senderAllowed({ ...ok, mainFrame: false }, target)).toBe(false)
    expect(senderAllowed({ ...ok, frameUrl: null }, target)).toBe(false)
    for (const u of [
      'https://evil.example/',
      pathToFileURL(resolve('README.md')).href,
      pathToFileURL(join(rendererDir, 'index.html')).href,
      'app://dim-factory.evil/index.html',
      'app://evil/index.html',
      'about:blank',
      'data:text/html,x',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      expect(senderAllowed({ ...ok, frameUrl: u }, target), u).toBe(false)
    }
  })

  it('a refused sender reaches nothing: no handler, no core, not even the envelope check', async () => {
    const core = vi.fn((): Promise<Result<unknown>> => Promise.resolve({ ok: true, value: 'core' }))
    const parse = vi.fn((cmd: Cmd, raw: unknown) => parseRequest(cmd, raw))
    const appInfo = vi.fn(() => Promise.resolve())
    const router = createRouter({ e2e: true, parse, main: { 'app.ready': appInfo }, core })
    for (const raw of [makeEnvelope('runs.list', {}, 'c'), makeEnvelope('app.ready', {}, 'c'), null, 'x']) {
      const r = await router(false, raw)
      expect(r).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This sender may not use Dim Factory commands.' },
      })
    }
    expect(parse).not.toHaveBeenCalled()
    expect(core).not.toHaveBeenCalled()
    expect(appInfo).not.toHaveBeenCalled()
  })
})

describe('command gating', () => {
  const core = vi.fn((): Promise<Result<unknown>> => Promise.resolve({ ok: true, value: 'core' }))
  const e2eState = vi.fn(() => Promise.reject(new Error('reached')))

  it('e2e.* exist only under DIM_FACTORY_E2E=1', async () => {
    const e2eCommands = Object.keys(COMMAND_AREA).filter((c) => COMMAND_AREA[c as Cmd] === 'e2e')
    expect(e2eCommands.sort()).toEqual(['e2e.clock', 'e2e.power', 'e2e.state'])
    expect(e2eCommands.every((c) => c.startsWith('e2e.'))).toBe(true)
    expect(
      Object.keys(COMMAND_AREA)
        .filter((c) => c.startsWith('e2e.'))
        .sort(),
    ).toEqual(e2eCommands.sort())
    const off = createRouter({ e2e: false, parse: parseRequest, main: { 'e2e.state': e2eState }, core })
    for (const cmd of e2eCommands) {
      const req =
        cmd === 'e2e.power' ? { event: 'suspend' } : cmd === 'e2e.clock' ? { advanceMs: 1 } : undefined
      const r = await off(true, makeEnvelope(cmd as Cmd, req, 'c'))
      expect(r.ok ? 'ok' : r.error.code, cmd).toBe('UNKNOWN_COMMAND')
    }
    expect(e2eState).not.toHaveBeenCalled()
    expect(core).not.toHaveBeenCalled()
  })

  it('a command named like an Object.prototype key is unknown', async () => {
    const router = createRouter({ e2e: true, parse: parseRequest, main: {}, core })
    for (const cmd of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = await router(true, { v: 1, cmd, req: {}, cid: 'c' })
      expect(r.ok ? 'ok' : r.error.code, cmd).toBe('UNKNOWN_COMMAND')
    }
    expect(core).not.toHaveBeenCalled()
  })
})

// ---- every request schema is strict -----------------------------------------------------------------------------

interface ZodDef {
  type: string
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  options?: z.ZodType[]
  element?: z.ZodType
  keyType?: z.ZodType
  valueType?: z.ZodType
  innerType?: z.ZodType
  in?: z.ZodType
  out?: z.ZodType
  items?: z.ZodType[]
  rest?: z.ZodType | null
  left?: z.ZodType
  right?: z.ZodType
  checks?: unknown[]
}
const defOf = (t: z.ZodType): ZodDef => (t as unknown as { _zod: { def: ZodDef } })._zod.def

/** `unknown` inside a request is acceptable only where something else judges the value. */
const UNKNOWN_ALLOWED = new Set([
  // main caps and redacts it (main-handlers.ts capLogWrite; the logger redacts every string).
  'log.write.data',
])

function walk(t: z.ZodType, path: string, problems: string[], seen = new Set<z.ZodType>()): void {
  if (seen.has(t)) return
  seen.add(t)
  const d = defOf(t)
  switch (d.type) {
    case 'object': {
      if (d.catchall === undefined || defOf(d.catchall).type !== 'never') problems.push(`${path}: not strict`)
      for (const [k, v] of Object.entries(d.shape ?? {})) walk(v, `${path}.${k}`, problems, seen)
      return
    }
    case 'any':
      problems.push(`${path}: any`)
      return
    case 'unknown':
      if (!UNKNOWN_ALLOWED.has(path) && (d.checks ?? []).length === 0)
        problems.push(`${path}: unchecked unknown`)
      return
    case 'union':
      for (const o of d.options ?? []) walk(o, path, problems, seen)
      return
    case 'array':
    case 'set':
      if (d.element !== undefined) walk(d.element, `${path}[]`, problems, seen)
      return
    case 'record':
    case 'map':
      if (d.keyType !== undefined) walk(d.keyType, `${path}{key}`, problems, seen)
      if (d.valueType !== undefined) walk(d.valueType, `${path}{}`, problems, seen)
      return
    case 'tuple':
      for (const [i, item] of (d.items ?? []).entries()) walk(item, `${path}[${i}]`, problems, seen)
      if (d.rest !== undefined && d.rest !== null) walk(d.rest, `${path}[...]`, problems, seen)
      return
    case 'intersection':
      if (d.left !== undefined) walk(d.left, path, problems, seen)
      if (d.right !== undefined) walk(d.right, path, problems, seen)
      return
    case 'pipe':
      if (d.in !== undefined) walk(d.in, path, problems, seen)
      return
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      if (d.innerType !== undefined) walk(d.innerType, path, problems, seen)
      return
    case 'lazy':
    case 'promise':
    case 'function':
    case 'custom':
      problems.push(`${path}: ${d.type} cannot be audited`)
      return
    default:
      // Leaves: string, number, boolean, bigint, literal, enum, null, undefined, void, never, date, nan, template…
      return
  }
}

describe('request schemas', () => {
  it('cover every command', () => {
    expect(Object.keys(REQUEST_SCHEMAS).sort()).toEqual(Object.keys(COMMAND_AREA).sort())
  })

  it('are strict objects all the way down, with no any and no unjudged unknown', () => {
    const problems: string[] = []
    for (const [cmd, schema] of Object.entries(REQUEST_SCHEMAS)) walk(schema as z.ZodType, cmd, problems)
    expect(problems).toEqual([])
  })

  it('refuse an unknown key at the top and deep inside', () => {
    const cases: [Cmd, unknown][] = [
      ['runs.get', { runId: 'r1', extra: 1 }],
      ['shell.open', { target: 'url', url: 'https://github.com/', also: 'x' }],
      ['config.patch', { scope: 'user', ops: [{ op: 'remove', path: '/x', from: '/y' }] }],
      [
        'trust.set',
        {
          folder: 'C:\\p',
          trusted: true,
          grant: { kind: 'command', command: { kind: 'verify', argv: ['npm'], cwdRel: '', x: 1 } },
        },
      ],
      ['runs.start', { folder: 'C:\\p', task: 't', overrides: { profile: 'balanced', nope: true } }],
    ]
    for (const [cmd, req] of cases) {
      const r = parseRequest(cmd, req)
      expect(r.ok ? 'ok' : r.error.code, cmd).toBe('VALIDATION')
    }
  })

  it('refuse a patch value whose shared references make it huge as JSON, quickly', () => {
    // IPC's structured clone keeps shared references: a chain of objects that each name the same child twice is
    // well under 1 KB as a message and 2^levels nodes as JSON. Unbounded, 24 levels took about 4 s and each level
    // doubled it, holding main's event loop.
    const chain = (levels: number): unknown => {
      let node: unknown = { leaf: 1 }
      for (let i = 0; i < levels; i++) node = { a: node, b: node }
      return structuredClone(node)
    }
    const value = chain(40)
    const cloned = value as { a: unknown; b: unknown }
    expect(cloned.a).toBe(cloned.b)
    const started = performance.now()
    const r = parseRequest('config.patch', { scope: 'user', ops: [{ op: 'add', path: '/x', value }] })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(r.ok ? 'ok' : r.error.code).toBe('VALIDATION')
    // A small value with a shared reference is still a JSON value (it is written out as two copies).
    const small = chain(4)
    expect(
      parseRequest('config.patch', { scope: 'user', ops: [{ op: 'add', path: '/x', value: small }] }).ok,
    ).toBe(true)
    // So is a plain value of many nodes under the bound, and one just past it is refused.
    const wide = (n: number): unknown => Array.from({ length: n }, (_, i) => i)
    const ok = parseRequest('config.patch', {
      scope: 'user',
      ops: [{ op: 'add', path: '/x', value: wide(JSON_VALUE_MAX_NODES - 1) }],
    })
    expect(ok.ok).toBe(true)
    const over = parseRequest('config.patch', {
      scope: 'user',
      ops: [{ op: 'add', path: '/x', value: wide(JSON_VALUE_MAX_NODES) }],
    })
    expect(over.ok ? 'ok' : over.error.code).toBe('VALIDATION')
  })

  it('a __proto__ key never pollutes the parsed request', () => {
    const raw = JSON.parse('{"runId":"r1","resolutions":{"__proto__":"mine","a.ts":"theirs"}}') as unknown
    const r = parseRequest('worktree.apply', raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.value.resolutions ?? {}
    expect(Object.getPrototypeOf(res)).toBe(Object.prototype)
    expect(Object.keys(res)).toEqual(['a.ts'])
    expect(({} as Record<string, unknown>)['mine']).toBeUndefined()
  })
})
