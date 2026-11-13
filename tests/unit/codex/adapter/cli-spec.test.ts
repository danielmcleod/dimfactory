// Finding Codex (resolve-cli: "`.cmd` → parse the shim. Codex maps to its native
// `@openai/codex-<plat>-<arch>/vendor/<triple>/bin/codex.exe`, with `codex-path` prepended to PATH"; "Validate with
// --version, plus parseVersion to identify the product").
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CODEX_TRIPLES,
  codexDesktopBundle,
  codexFromJsEntry,
  codexWellKnown,
  parseCodexVersion,
} from '@core/adapters/codex/cli-spec.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('version', () => {
  it('identifies codex-cli and keeps a prerelease suffix', () => {
    expect(parseCodexVersion('codex-cli 0.160.1\n')).toEqual({ version: '0.160.1' })
    expect(parseCodexVersion('codex-cli 0.147.0-alpha.6.5')).toEqual({ version: '0.147.0-alpha.6.5' })
    expect(parseCodexVersion('claude 2.1.289 (Claude Code)')).toBeNull()
    expect(parseCodexVersion('0.160.1')).toBeNull()
  })
})

describe('locations', () => {
  it('the standalone installer first, the Desktop alpha last (win32)', () => {
    expect(
      codexWellKnown({
        platform: 'win32',
        home: 'C:\\Users\\me',
        localAppData: 'C:\\Users\\me\\AppData\\Local',
      }),
    ).toEqual(['C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'])
    expect(codexDesktopBundle({ platform: 'win32', home: 'C:\\Users\\me' })).toEqual([
      'C:\\Users\\me\\.codex\\.sandbox-bin\\codex.exe',
    ])
    expect(codexDesktopBundle({ platform: 'linux', home: '/home/me' })).toEqual([])
  })
})

describe('npm launcher → the native binary', () => {
  const key = `${process.platform}-${process.arch}`
  const triple = CODEX_TRIPLES[key]
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'

  it.runIf(triple !== undefined)(
    'maps @openai/codex/bin/codex.js to vendor/<triple>/bin with codex-path on PATH',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'codex-npm-'))
      dirs.push(root)
      const pkg = join(root, 'node_modules', '@openai', 'codex')
      const entry = join(pkg, 'bin', 'codex.js')
      mkdirSync(join(pkg, 'bin'), { recursive: true })
      writeFileSync(entry, '// launcher')
      const tripleDir = join(pkg, 'node_modules', '@openai', `codex-${key}`, 'vendor', triple!)
      mkdirSync(join(tripleDir, 'bin'), { recursive: true })
      mkdirSync(join(tripleDir, 'codex-path'), { recursive: true })
      writeFileSync(join(tripleDir, 'bin', exe), 'MZ')
      expect(codexFromJsEntry(entry)).toEqual({
        exe: join(tripleDir, 'bin', exe),
        pathPrepend: [join(tripleDir, 'codex-path')],
      })
    },
  )

  it.runIf(triple !== undefined)('a hoisted platform package and the legacy layout are found too', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-npm-'))
    dirs.push(root)
    const scope = join(root, 'node_modules', '@openai')
    const entry = join(scope, 'codex', 'bin', 'codex.js')
    mkdirSync(join(scope, 'codex', 'bin'), { recursive: true })
    writeFileSync(entry, '// launcher')
    const legacy = join(scope, `codex-${key}`, 'vendor', triple!)
    mkdirSync(join(legacy, 'codex'), { recursive: true })
    writeFileSync(join(legacy, 'codex', exe), 'MZ')
    expect(codexFromJsEntry(entry)).toEqual({ exe: join(legacy, 'codex', exe) })
  })

  it('a launcher without its platform package maps to the expected (missing) binary; any other JS entry is not Codex', () => {
    const entry = join(tmpdir(), 'nowhere', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const r = codexFromJsEntry(entry, 'win32', 'x64')
    expect(r?.exe).toMatch(/x86_64-pc-windows-msvc[\\/]bin[\\/]codex\.exe$/)
    expect(
      codexFromJsEntry(join(tmpdir(), 'node_modules', 'dim-factory-fake-cli', 'fake-cli.mjs')),
    ).toBeNull()
  })
})
