// Packaged-app smoke test (CI's package job, on all three OS). Runs the unpacked build from dist/ with `--smoke-test`
// and a throwaway DIM_FACTORY_HOME; it passes only on exit code 0 with a stdout line starting `SMOKE OK`.
//
//   node scripts/smoke-packaged.mjs [--app <executable>] [--timeout <ms>]      (pnpm smoke:packaged)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BRAND, HOME_ENV, envName } from '../src/shared/brand.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_CAP = 256 * 1024

const log = (line) => console.log(`smoke-packaged: ${line}`)

/** electron-builder names output dirs `<os>[-<arch>][-unpacked]`, with no arch suffix for x64. */
function archScore(dir) {
  const base = dir.replace(/-unpacked$/, '')
  const arch = base.includes('-') ? base.slice(base.indexOf('-') + 1) : 'x64'
  return arch === process.arch ? 2 : arch === 'universal' ? 1 : 0
}

/** The unpacked app electron-builder --dir produced for this OS (the host arch first). */
function findApp(dist) {
  const dirs = existsSync(dist) ? readdirSync(dist) : []
  const archFirst = (names) => [...names].sort((a, b) => archScore(b) - archScore(a))
  let candidates
  switch (process.platform) {
    case 'win32':
      candidates = archFirst(dirs.filter((d) => /^win(-[a-z0-9]+)?-unpacked$/.test(d))).map((d) =>
        join(dist, d, `${BRAND.displayName}.exe`),
      )
      break
    case 'darwin':
      candidates = archFirst(dirs.filter((d) => /^mac(-[a-z0-9]+)?$/.test(d))).map((d) =>
        join(dist, d, `${BRAND.displayName}.app`, 'Contents', 'MacOS', BRAND.displayName),
      )
      break
    default:
      candidates = archFirst(dirs.filter((d) => /^linux(-[a-z0-9]+)?-unpacked$/.test(d))).map((d) =>
        join(dist, d, BRAND.slug),
      )
  }
  return { app: candidates.find((p) => existsSync(p)) ?? null, looked: candidates }
}

const readSysctl = (path) => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Linux only. Chromium sandboxes the renderer with unprivileged user namespaces, or else with the SUID chrome-sandbox
 * helper. An unpacked build has no SUID helper (only the deb's postinst sets it up, and CI does it with sudo), and
 * Ubuntu 24.04 restricts user namespaces through AppArmor, which the deb's profile lifts for the installed path only.
 * With neither available Electron aborts at start, so the smoke runs unsandboxed and says so. The CI package job
 * sets the SUID bit first, so CI always exercises the real sandbox.
 */
function linuxSandboxArgs(app) {
  try {
    const st = statSync(join(dirname(app), 'chrome-sandbox'))
    if (st.uid === 0 && (st.mode & 0o4000) !== 0) return []
  } catch {
    // no helper at all: fall through to the user-namespace check
  }
  const restricted =
    readSysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' ||
    readSysctl('/proc/sys/kernel/unprivileged_userns_clone') === '0'
  if (!restricted) return []
  log('chrome-sandbox is not SUID root and user namespaces are restricted: running with --no-sandbox')
  return ['--no-sandbox']
}

function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function tail(text, max = 8000) {
  return text.length > max ? `…${text.slice(-max)}` : text
}

async function main() {
  const { values } = parseArgs({
    options: { app: { type: 'string' }, timeout: { type: 'string' } },
    allowPositionals: false,
  })
  const timeoutMs = Number(values.timeout ?? process.env['SMOKE_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    log(`--timeout must be a positive number of milliseconds, got "${values.timeout}"`)
    return 2
  }

  let app = values.app !== undefined ? resolve(values.app) : null
  if (app === null) {
    const found = findApp(join(ROOT, 'dist'))
    if (found.app === null) {
      const where =
        found.looked.length > 0 ? found.looked.join(', ') : 'dist/ has no unpacked build for this OS'
      log(`no packaged app found (${where}). Run "pnpm package:dir" first.`)
      return 1
    }
    app = found.app
  } else if (!existsSync(app)) {
    log(`--app ${app} does not exist`)
    return 1
  }

  const home = mkdtempSync(join(tmpdir(), `${BRAND.slug}-smoke-`))
  const env = { ...process.env, [HOME_ENV]: home }
  // The smoke checks a normal boot: no E2E hooks, and nothing that would run Electron as plain Node.
  for (const k of [
    'ELECTRON_RUN_AS_NODE',
    envName('E2E'),
    envName('E2E_PICK_FOLDER'),
    envName('E2E_TIME_SCALE'),
  ]) {
    delete env[k]
  }

  let command = app
  let args = ['--smoke-test']
  if (process.platform === 'linux') {
    args = [...linuxSandboxArgs(app), ...args]
    if (!env['DISPLAY'] && !env['WAYLAND_DISPLAY']) {
      // Headless CI: a virtual X server for the window the smoke opens.
      command = 'xvfb-run'
      args = ['-a', '-s', '-screen 0 1280x800x24', app, ...args]
    }
  }

  log(`${[command, ...args].join(' ')} (${HOME_ENV}=${home}, timeout ${Math.round(timeoutMs / 1000)} s)`)
  const started = Date.now()
  const result = await new Promise((done) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: own process group, so a timeout kills Electron's helpers and Xvfb too.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout = (stdout + d).slice(-OUTPUT_CAP)
    })
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr = (stderr + d).slice(-OUTPUT_CAP)
    })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ code: null, signal: null, stdout, stderr, timedOut, spawnError: err })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      // Anything the app left behind in its group (POSIX); on Windows the tree died with the browser process.
      if (process.platform !== 'win32') killTree(child)
      done({ code, signal, stdout, stderr, timedOut, spawnError: null })
    })
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (err) {
    log(`could not delete ${home}: ${err instanceof Error ? err.message : String(err)}`)
  }

  const lines = result.stdout.split(/\r?\n/)
  const ok = lines.find((l) => l.startsWith('SMOKE OK'))
  if (result.code === 0 && ok !== undefined) {
    console.log(ok)
    log(`passed in ${seconds} s`)
    return 0
  }

  const fail = lines.find((l) => l.startsWith('SMOKE FAIL'))
  const why = result.spawnError
    ? `could not start ${command}: ${result.spawnError.message}${command === 'xvfb-run' ? ' (install xvfb or set DISPLAY)' : ''}`
    : result.timedOut
      ? `no result within ${Math.round(timeoutMs / 1000)} s; killed the app`
      : result.code === 0
        ? 'exit code 0 but no "SMOKE OK" line on stdout'
        : `exit code ${result.code ?? 'none'}${result.signal ? ` (signal ${result.signal})` : ''}`
  log(`FAILED after ${seconds} s: ${why}`)
  if (fail !== undefined) log(`app reported: ${fail}`)
  console.log('---- stdout ----')
  console.log(tail(result.stdout.trimEnd()) || '(empty)')
  console.log('---- stderr ----')
  console.log(tail(result.stderr.trimEnd()) || '(empty)')
  return 1
}

process.exitCode = await main()
