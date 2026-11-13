// Realistic .cmd shim texts per package manager (CRLF, as written on disk).
import { describe, expect, it } from 'vitest'
import { parseShimText } from '../../../src/core/proc/shim.ts'

const crlf = (lines: string[]): string => lines.join('\r\n')

const NPM_JS = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*',
  '',
])

/** npm 7–9 layout: ENDLOCAL after the call, entry without an extension. */
const NPM_EXTENSIONLESS = crlf([
  '@ECHO off',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  '"%_prog%"  "%dp0%\\node_modules\\less\\bin\\lessc" %*',
  'ENDLOCAL',
  'EXIT /b %errorlevel%',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  '',
])

/** cmd-shim for a target without a shebang (the native claude.exe from @anthropic-ai/claude-code). */
const NPM_EXE = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  '',
])

const PNPM_JS = crlf([
  '@SETLOCAL',
  '@IF NOT DEFINED NODE_PATH (',
  '  @SET "NODE_PATH=C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules"',
  ') ELSE (',
  '  @SET "NODE_PATH=%NODE_PATH%;C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules"',
  ')',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ')',
  '',
])

/** pnpm's own self-installed shim. */
const PNPM_EXE = crlf(['@SETLOCAL', '@"%~dp0\\.tools\\pnpm-exe\\10.28.0\\pnpm.exe"   %*', ''])

/** yarn classic global bin (old cmd-shim layout). */
const YARN_JS = crlf([
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\Data\\global\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*',
  ') ELSE (',
  '  @SETLOCAL',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\..\\Data\\global\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*',
  ')',
])

/** yarn classic forwarding to the package's own .bin shim. */
const YARN_CHAIN = crlf(['@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\gemini.cmd" %*', ''])

const VOLTA = crlf(['@echo off', 'volta run claude %*', ''])
const VOLTA_N0 = crlf(['@echo off', 'volta run %~n0 %*', ''])

const ABSOLUTE = crlf(['@echo off', '"C:\\Program Files\\Tool\\tool.exe" %*', ''])

const NPM_DIR = 'C:\\Users\\u\\AppData\\Roaming\\npm'

describe('parseShimText corpus', () => {
  it('npm cmd-shim with a JS entry and an optional local node.exe', () => {
    const shim = `${NPM_DIR}\\gemini.cmd`
    expect(parseShimText(NPM_JS, shim)).toEqual({
      kind: 'js',
      entry: `${NPM_DIR}\\node_modules\\@google\\gemini-cli\\dist\\index.js`,
      localNode: `${NPM_DIR}\\node.exe`,
      manager: 'npm',
    })
    const noLocalNode = parseShimText(NPM_JS, shim, (p) => !p.endsWith('node.exe'))
    expect(noLocalNode).toMatchObject({ kind: 'js', localNode: null })
  })

  it('npm cmd-shim with an extensionless entry run by "%_prog%"', () => {
    expect(parseShimText(NPM_EXTENSIONLESS, `${NPM_DIR}\\lessc.cmd`)).toMatchObject({
      kind: 'js',
      entry: `${NPM_DIR}\\node_modules\\less\\bin\\lessc`,
      manager: 'npm',
    })
  })

  it('npm cmd-shim forwarding to a native exe', () => {
    expect(parseShimText(NPM_EXE, `${NPM_DIR}\\claude.cmd`)).toEqual({
      kind: 'exe',
      path: `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
      manager: 'npm',
    })
  })

  it('pnpm global shim (%~dp0, NODE_PATH lines ignored)', () => {
    const dir = 'C:\\Users\\u\\AppData\\Local\\pnpm'
    expect(parseShimText(PNPM_JS, `${dir}\\codex.CMD`)).toEqual({
      kind: 'js',
      entry: `${dir}\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js`,
      localNode: `${dir}\\node.exe`,
      manager: 'pnpm',
    })
    expect(parseShimText(PNPM_EXE, `${dir}\\pnpm.CMD`)).toEqual({
      kind: 'exe',
      path: `${dir}\\.tools\\pnpm-exe\\10.28.0\\pnpm.exe`,
      manager: 'pnpm',
    })
  })

  it('yarn classic shim resolves ..\\ relative to the shim directory', () => {
    const dir = 'C:\\Users\\u\\AppData\\Local\\Yarn\\bin'
    expect(parseShimText(YARN_JS, `${dir}\\gemini.cmd`)).toMatchObject({
      kind: 'js',
      entry:
        'C:\\Users\\u\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@google\\gemini-cli\\dist\\index.js',
      manager: 'yarn',
    })
    expect(parseShimText(YARN_CHAIN, `${dir}\\gemini.cmd`)).toEqual({
      kind: 'cmd',
      path: 'C:\\Users\\u\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\.bin\\gemini.cmd',
      manager: 'yarn',
    })
  })

  it('volta forwarding shims', () => {
    const dir = 'C:\\Users\\u\\AppData\\Local\\Volta\\bin'
    expect(parseShimText(VOLTA, `${dir}\\claude.cmd`)).toEqual({
      kind: 'command',
      command: 'volta',
      args: ['run', 'claude'],
      manager: 'volta',
    })
    expect(parseShimText(VOLTA_N0, `${dir}\\gemini.cmd`)).toMatchObject({ args: ['run', 'gemini'] })
  })

  it('absolute targets', () => {
    expect(parseShimText(ABSOLUTE, 'C:\\bin\\tool.cmd')).toMatchObject({
      kind: 'exe',
      path: 'C:\\Program Files\\Tool\\tool.exe',
    })
  })

  it('prefers the first existing exe, then a JS entry', () => {
    const both = crlf(['"%~dp0\\missing.exe" %*', '"%_prog%" "%~dp0\\entry.js" %*'])
    expect(parseShimText(both, 'C:\\d\\x.cmd', (p) => !p.endsWith('missing.exe'))).toMatchObject({
      kind: 'js',
      entry: 'C:\\d\\entry.js',
    })
  })

  it('reports unknown formats and missing targets', () => {
    expect(parseShimText('@echo off\r\npnpm dlx %*\r\n', 'C:\\d\\pnpx.cmd')).toEqual({
      kind: 'unknown',
      reason: 'no executable or JS entry found in shim',
    })
    expect(parseShimText(NPM_EXE, `${NPM_DIR}\\claude.cmd`, () => false)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('shim target missing') as unknown,
    })
  })

  it('ignores REM lines and SET assignments', () => {
    const text = crlf([
      '@REM "%~dp0\\decoy.exe"',
      ':: "%~dp0\\decoy2.exe"',
      '@SET "X=%~dp0\\decoy3.exe"',
      '"%~dp0\\real.exe" %*',
    ])
    expect(parseShimText(text, 'C:\\d\\t.cmd')).toMatchObject({ kind: 'exe', path: 'C:\\d\\real.exe' })
  })
})
