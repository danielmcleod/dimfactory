// The process layer resolving an npm-installed Codex (resolve-cli: "`.cmd` → parse the shim. Codex
// maps to its native `@openai/codex-<plat>-<arch>/vendor/<triple>/bin/codex.exe`, with `codex-path` prepended to
// PATH"): the real resolver over a real file layout, with the version run stubbed.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CODEX_TRIPLES, codexCliSpec } from '@core/adapters/codex/cli-spec.ts'
import { resolveCli } from '@core/proc/resolve-cli.ts'
import type { RunFn } from '@core/proc/resolve-cli.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** npm cmd-shim (v6+) output for a %dp0%-relative JS entry. */
const cmdShim = (rel: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    '',
  ].join('\r\n')

/** A native header (PE / ELF / Mach-O) padded past the placeholder size. */
function nativeBinary(): Buffer {
  const magic =
    process.platform === 'win32'
      ? Buffer.from([0x4d, 0x5a])
      : process.platform === 'darwin'
        ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46])
  return Buffer.concat([magic, Buffer.alloc(8192)])
}

const key = `${process.platform}-${process.arch}`
const triple = CODEX_TRIPLES[key]

describe('an npm-installed Codex resolves to its native binary', () => {
  it.runIf(triple !== undefined)(
    'the launcher is never run: the native exe is, with codex-path on PATH',
    async () => {
      // Under the temp folder's real name: the launcher is a link on macOS and Linux, and following it gives the real
      // name (/private/var/... where tmpdir() says /var/...), which is what the resolved paths are spelled with.
      const prefix = mkdtempSync(join(realpathSync.native(tmpdir()), 'codex-prefix-'))
      dirs.push(prefix)
      const modules =
        process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
      const pkg = join(modules, '@openai', 'codex')
      mkdirSync(join(pkg, 'bin'), { recursive: true })
      writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n// launcher\n')
      const tripleDir = join(pkg, 'node_modules', '@openai', `codex-${key}`, 'vendor', triple!)
      const exe = join(tripleDir, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
      mkdirSync(join(tripleDir, 'bin'), { recursive: true })
      mkdirSync(join(tripleDir, 'codex-path'), { recursive: true })
      writeFileSync(exe, nativeBinary(), { mode: 0o755 })

      let shim: string
      if (process.platform === 'win32') {
        shim = join(prefix, 'codex.cmd')
        writeFileSync(shim, cmdShim('node_modules\\@openai\\codex\\bin\\codex.js'))
      } else {
        mkdirSync(join(prefix, 'bin'), { recursive: true })
        shim = join(prefix, 'bin', 'codex')
        symlinkSync(join(pkg, 'bin', 'codex.js'), shim)
      }

      const runs: { command: string; args: readonly string[]; path: string | undefined }[] = []
      const run: RunFn = (command, args, o) => {
        runs.push({ command, args, path: o.env['PATH'] ?? o.env['Path'] })
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: 'codex-cli 0.160.1\n',
          stderr: '',
          timedOut: false,
          ms: 1,
        })
      }
      const r = await resolveCli(codexCliSpec, {
        configuredPath: shim,
        candidates: 'configured',
        env: { PATH: tmpdir() },
        pathEnv: tmpdir(),
        run,
      })
      if (!r.ok) throw new Error(JSON.stringify(r.rejected))
      expect(r.cli).toMatchObject({
        command: exe,
        prefixArgs: [],
        kind: 'native',
        version: '0.160.1',
        pathPrepend: [join(tripleDir, 'codex-path')],
      })
      // The version check ran the native exe itself, codex-path first on its PATH.
      expect(runs).toHaveLength(1)
      expect(runs[0]!.command).toBe(exe)
      expect(runs[0]!.path?.startsWith(join(tripleDir, 'codex-path'))).toBe(true)
    },
  )
})
