#!/usr/bin/env node
// Soak run (8 concurrent runs × 2 h; TOLERANCE below has the reasoning behind the tolerances). The built app, under
// Playwright's _electron, runs runs back to back in N temp folders on the fake Claude, Codex and Gemini, while this
// script samples memory, handles, processes, the event loop, renderer long tasks, throughput, the home folder and the
// logs every few minutes.
//
// Usage
//   node scripts/soak.mjs [--minutes 120] [--runs 8] [--sample-min 2] [--warmup-min 20] [--out test-results/soak]
//                         [--stream-kb 96] [--keep-runs <n>] [--retention-min 15] [--drain-min 8] [--settle-min 16]
//                         [--seed <n>] [--no-build] [--in-place] [--keep] [--no-clear] [--heap-snapshots]
//                         [--phases <n>]
//   (`pnpm soak --minutes 30` passes options through.)
//   --phases     split the soak's minutes into n phases (default 1). After each phase but the last the runs drain and
//                every run is removed (the 'cleared' sample, as at the end), then the next phase starts: the cleared
//                heap after each phase shows whether what main keeps once its runs are gone levels off (warm-up) or
//                grows with the runs (a leak that survives removal). Each phase's first --warmup-min minutes are left
//                out of the trends, and a series' slope is fitted within each phase (one level per phase, one slope)
//   --warmup-min samples before this are left out of the trends (default 20, or a quarter of a shorter soak): a
//                finished run stays loaded 5 min (core's UNLOAD_FINISHED_AFTER_MS) and its event ring 10 min more
//                (the bus's RING_TTL_MS), so main's heap reaches its working level after about 15 min of runs
//   --settle-min after the runs drained, wait this long before the idle-end sample (default 16: those 15 min)
//   --no-build   skip `pnpm -s build` (out/ must be current)
//   --in-place   launch the app from the repo (default: from a copy of out/ in the temp root, so a rebuild by
//                someone else during a long soak cannot change the running app's files)
//   --keep       keep the temp root (home, folders, fake logs) for inspection
//   --no-clear   skip the last phase (every run removed, then the 'cleared' sample)
//   --heap-snapshots  write main's and the renderer's heap snapshots at the first sample after the warm-up and at the
//                end of the runs; the summary lists what grew between them by constructor (a leak hunt: each
//                snapshot pauses the process a few seconds)
//   --summarize <soak-….samples.jsonl>  only analyse an earlier soak's samples again (with this script's checks)
//
// What runs (nothing real: DIM_FACTORY_E2E=1, DIM_FACTORY_E2E_VENDOR_SEARCH=configured, a temp DIM_FACTORY_HOME, private
// CODEX_HOME / GEMINI_CLI_HOME / GROK_HOME / CLAUDE_CONFIG_DIR, the fake CLI built into the temp root):
//   - N git folders (copies of tests/fixtures/sandboxes/ts-small). Folder i runs profile i mod 3:
//       claude-only   Claude native Plan → gate → Claude Implement (two command asks, a long stream, a write) →
//                     Review (findings on about half the runs) ∥ Critic → Fix resumes Implement's session
//       balanced      Claude Plan → gate → Codex Implement (a command approval, a long stream, a write) → Review ∥
//                     Critic → the gate before Fix → Codex Fix resumes the thread
//       soak-gemini   Gemini native Plan → gate → Gemini Implement (an edit ask, a long stream) → Claude Review ∥
//                     Gemini Critic (two requests Dim Factory rejects itself) → Gemini Fix (session/load)
//     When a run ends a new one starts in its folder. Asks are allowed and gates approved after random delays.
//   - The view moves between the Dashboard, run views (Flow, Diff, Log) of running runs and of the last 50 that
//     ended (their snapshots load again, their logs are read cold), Runs and Settings; the window reads as
//     unfocused half of the time (desktop notifications go to the E2E recorder); retention runs every few minutes
//     (the app's daily pass is off under E2E). Self-heal is off, so a failure shows as itself.
//
// Each sample (the view is moved to the Dashboard first, so the renderer is measured on the same screen):
//   main     process.memoryUsage() before and after a forced GC (Electron starts with --js-flags=--expose-gc), that heap
//            split into compiled code (V8's code and trusted spaces) and data, the
//            event-loop histogram since the last sample (main's E2E global; reset after the GC), active libuv
//            resources by type, OS handles (Windows HandleCount, /proc/<pid>/fd on Linux)
//   renderer JS heap after a forced GC (CDP HeapProfiler.collectGarbage), DOM nodes, event listeners, documents,
//            long tasks (> 50 ms) since the last sample, OS handles
//   app      working set and private bytes of every Electron process (app.getAppMetrics)
//   procs    the main process's descendants by name; the vendor processes core reports live (e2e.state); orphans =
//            processes whose command line names the temp root but that are not under the main process
//   runs     started, ended (completed / failed / cancelled), throughput per hour, asks and gates answered
//   home     size by area (runs, shadow repos, logs, the rest); the app log's error and warn lines; the fakes' errors
//
// Output (in --out): soak-<stamp>.csv (one row per sample), .samples.jsonl (every sample in full), .summary.md and
// .summary.json (trends after the warm-up, the checks below, anomalies), .log (this script's own log). Playwright
// clears test-results/ when an E2E run starts: the CSV and samples are written again whole at the end.
//
// Checks (after the warm-up; the tolerances and their reasons are in TOLERANCE below):
//   flat memory   what each completed run leaves behind (a series' least-squares slope over the runs completed an
//                 hour): main and renderer JS heap after GC, main external memory, OS handles and libuv resources
//                 within TOLERANCE; the Dashboard's DOM nodes and listeners, last third against first third
//   idle return   before the runs and after the drain and settle, the same OS handles and libuv resources
//   cleared       then every run of the history removed (runs.remove and its deletes): main's heap back near its
//                 level before the first run, so what the runs added was the history kept by design, not a leak;
//                 with --phases, the cleared heap levels off: from the first phase's clear to the last, what main's
//                 data heap (its heap less compiled code) kept per run completed in between is within
//                 TOLERANCE.clearedKbPerRun
//   processes     no orphan at any sample; once the runs drained, no vendor or git process under main; after the
//                 app quits, none of the temp root's processes is left
//   event loop    every sample interval's main event-loop p95 < 100 ms (else core moves to a utilityProcess)
//   logs          no error line in the app log; no Node warning on the app's stderr (an unclosed file handle, a
//                 listener leak); no fake CLI mismatch; no failed run, unexpected card or page error
// Exit code 0 when every check passes, 1 otherwise (2 on a setup failure).
//
// Safety: only processes this script started are touched (the app by its PID through Playwright; at the end, a
// leftover whose command line names the temp root, by PID). The temp root is deleted unless --keep.
import { execFile, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'

/* global window, location -- functions passed to page.evaluate run in the renderer */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'
const MB = 1024 * 1024
const HOUR_MS = 3_600_000

/**
 * Leak tolerances (after the warm-up), as what one completed run leaves behind: a series' least-squares slope over the
 * runs completed an hour (the soak's throughput varies, so a per-hour bound would judge the machine, not the app).
 *   - `mainHeapKbPerRun` 24: core keeps a run's history by design (its index summary, its step samples for the
 *     estimates, its run estimate), bounded by retention: about 4 KB a run, measured over 120 runs in a core outside
 *     Electron once their event rings were gone; main adds a notification window or two. A run left loaded (its
 *     controller and its ring) costs about 360 KB there and a ring alone about 290 KB: 10 or more times this bound.
 *   - `rendererHeapKbPerRun` 16: the renderer keeps a summary per run of the session (about 7 KB as objects) for the
 *     Runs page and its filters; a snapshot kept per run (the soak's other find) is about 20 KB more.
 *   - `externalKbPerRun` 8: nothing outside the JS heap is kept per run (buffers are per spawn).
 *   - `handlesPerRun` 0.2: an open file or pipe kept per run would be 1; a sample also counts the pipes and process
 *     handles of the passes running at that moment (10 to 25 children), which the slope averages out.
 *   - `idleHandles` 64: once idle (no child, before the runs and after the drain and settle) main's and the
 *     renderer's OS handles may differ by this much (caches the first runs open, a worker the Diff tab started); a
 *     handle kept per run would be hundreds after the soak's runs.
 *   - `domThirdsRatio` 1.15: the Dashboard's node and listener counts vary with what the 8 run cards show.
 *   - `clearedMainHeapMb` 8: with every run removed, main keeps what the session warmed up (the code compiled for the
 *     passes, the diff and the views, and the bounded caches: redaction patterns, the diff rows' 64 pairs): 5.2 MB
 *     after a 20-minute soak of 47 runs. A run left loaded (360 KB) or a ring never dropped (290 KB), over a soak's
 *     hundreds of runs, would be far more. This bound alone cannot tell warm-up from a small leak that survives
 *     removal (7.6 MB after the 2-hour soak's 450 runs, 0.4 MB under it); `clearedKbPerRun` can.
 *   - `clearedKbPerRun` 4 (--phases): from the first phase's clear to the last, main's data heap with every run
 *     removed (the heap after GC less V8's code and trusted spaces) grows by at most this much per run completed in
 *     between. Everything a run leaves by design goes with its removal (its history in main is about 4 KB), so the
 *     data heap stays where it was; a leak that survives removal at the rate the review feared (up to 7 KB a run)
 *     fails it, and over a few hundred runs it stays well above the cleared samples' noise. Compiled code is reported
 *     beside it, not judged per run: V8 optimizes a function once it turns hot, so a long session keeps adding the
 *     first optimized code of less-used functions (one or a few code objects each, bounded by the code base). The
 *     3-phase soak of 2026-10-12 measured both.
 */
const TOLERANCE = {
  mainHeapKbPerRun: 24,
  rendererHeapKbPerRun: 16,
  externalKbPerRun: 8,
  handlesPerRun: 0.2,
  idleHandles: 64,
  domThirdsRatio: 1.15,
  clearedMainHeapMb: 8,
  clearedKbPerRun: 4,
  eventLoopP95Ms: 100,
}

// ---- arguments ----------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    minutes: 120,
    runs: 8,
    sampleMin: 2,
    warmupMin: undefined,
    out: join(REPO_ROOT, 'test-results', 'soak'),
    streamKb: 96,
    keepRuns: undefined,
    retentionMin: 15,
    drainMin: 8,
    settleMin: 16,
    seed: Date.now() % 2_147_483_647,
    build: true,
    inPlace: false,
    keep: false,
    clear: true,
    heapSnapshots: false,
    phases: 1,
    summarize: undefined,
  }
  const num = (name, v) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a number, got ${v}`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    switch (a) {
      case '--minutes':
        o.minutes = num('minutes', next())
        break
      case '--runs':
        o.runs = Math.max(1, Math.round(num('runs', next())))
        break
      case '--sample-min':
        o.sampleMin = num('sample-min', next())
        break
      case '--warmup-min':
        o.warmupMin = num('warmup-min', next())
        break
      case '--out':
        o.out = resolve(next())
        break
      case '--stream-kb':
        o.streamKb = num('stream-kb', next())
        break
      case '--keep-runs':
        o.keepRuns = Math.max(1, Math.round(num('keep-runs', next())))
        break
      case '--retention-min':
        o.retentionMin = num('retention-min', next())
        break
      case '--drain-min':
        o.drainMin = num('drain-min', next())
        break
      case '--settle-min':
        o.settleMin = num('settle-min', next())
        break
      case '--seed':
        o.seed = Math.round(num('seed', next()))
        break
      case '--no-build':
        o.build = false
        break
      case '--in-place':
        o.inPlace = true
        break
      case '--keep':
        o.keep = true
        break
      case '--no-clear':
        o.clear = false
        break
      case '--heap-snapshots':
        o.heapSnapshots = true
        break
      case '--phases':
        o.phases = Math.max(1, Math.round(num('phases', next())))
        break
      case '--summarize':
        o.summarize = resolve(next())
        break
      case '--':
        // `pnpm soak -- --minutes 30` passes the separator through.
        break
      case '--help':
      case '-h':
        process.stdout.write(
          `${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]}\n`,
        )
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument ${a} (--help lists them)`)
    }
  }
  o.warmupMin ??= Math.min(20, o.minutes / o.phases / 4)
  return o
}

// ---- small helpers -----------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A sleep that ends early (resolving false) once `signal` aborts. */
function pause(ms, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((r) => {
    const done = (v) => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      r(v)
    }
    const onAbort = () => done(false)
    const t = setTimeout(() => done(true), ms)
    signal.addEventListener('abort', onAbort)
  })
}

/** mulberry32: a seeded PRNG, so a soak's random delays and views can be replayed with --seed. */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const mb = (bytes) => round(bytes / MB, 2)

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (s.length === 0) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Least-squares slope of y over x (x in ms) as units per hour; null with fewer than 3 points. */
/**
 * Least-squares slope per hour of `[x (ms), y, group?]` points. With groups (--phases), one level per group and one
 * slope for all: x and y are centred within their group, so a step between groups (every run removed) is not read
 * as a trend. Without groups it is the ordinary slope.
 */
function slopePerHour(points) {
  const p = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (p.length < 3) return null
  const means = new Map()
  for (const [x, y, g = 0] of p) {
    const m = means.get(g) ?? { x: 0, y: 0, n: 0 }
    m.x += x
    m.y += y
    m.n++
    means.set(g, m)
  }
  let num = 0
  let den = 0
  for (const [x, y, g = 0] of p) {
    const m = means.get(g)
    const dx = x - m.x / m.n
    num += dx * (y - m.y / m.n)
    den += dx ** 2
  }
  return den === 0 ? 0 : (num / den) * HOUR_MS
}

/** First and last third's medians of a series. */
function thirds(values) {
  const v = values.filter((x) => Number.isFinite(x))
  if (v.length < 3) return { first: null, last: null }
  const n = Math.max(1, Math.floor(v.length / 3))
  return { first: median(v.slice(0, n)), last: median(v.slice(-n)) }
}

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function execFileText(cmd, args, timeoutMs = 120_000) {
  return new Promise((res) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', maxBuffer: 256 * MB, windowsHide: true, timeout: timeoutMs },
      (err, stdout) => res(err === null ? stdout : null),
    )
  })
}

const samePathPrefix = (text, prefix) =>
  typeof text === 'string' &&
  text.replace(/\\/g, '/').toLowerCase().includes(prefix.replace(/\\/g, '/').toLowerCase())

// ---- the process table ---------------------------------------------------------------------------------------------

/** Every process: pid, ppid, name, OS handles (Windows), working set, command line. */
async function processTable() {
  if (IS_WIN) {
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,HandleCount,WorkingSetSize,' +
      'CommandLine | ConvertTo-Json -Compress -Depth 2'
    const out = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    if (out === null) return null
    let rows
    try {
      // Windows PowerShell 5.1 leaves control characters of a command line unescaped.
      rows = JSON.parse(out.replace(/\p{Cc}/gu, ' '))
    } catch {
      return null
    }
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      name: String(r.Name ?? ''),
      handles: r.HandleCount ?? null,
      ws: r.WorkingSetSize ?? null,
      cmd: r.CommandLine ?? '',
    }))
  }
  const out = await execFileText('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm=,args='])
  if (out === null) return null
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)
      if (m === null) return null
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        name: m[4].split('/').pop() ?? m[4],
        handles: null,
        ws: Number(m[3]) * 1024,
        cmd: m[5],
      }
    })
    .filter((r) => r !== null)
}

/** Open file descriptors of a process (Linux only; on Windows the table's HandleCount is used). */
function fdCount(pid) {
  if (process.platform !== 'linux' || pid === null || pid === undefined) return null
  try {
    return readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return null
  }
}

/** The descendants of `pid` (not itself). */
function descendants(table, pid) {
  const kids = new Map()
  for (const p of table) {
    if (p.pid === p.ppid) continue
    const list = kids.get(p.ppid) ?? []
    list.push(p)
    kids.set(p.ppid, list)
  }
  const out = []
  const seen = new Set([pid])
  const queue = [pid]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const c of kids.get(cur) ?? []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      out.push(c)
      queue.push(c.pid)
    }
  }
  return out
}

// ---- the home folder ---------------------------------------------------------------------------------------------

/** Bytes under `dir` by its first-level entry (links not followed). */
async function folderSizes(dir) {
  const byTop = {}
  let total = 0
  let files = 0
  const walk = async (d, top) => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      const key = top ?? e.name
      if (e.isDirectory()) {
        await walk(p, key)
        continue
      }
      try {
        const st = await lstat(p)
        byTop[key] = (byTop[key] ?? 0) + st.size
        total += st.size
        files++
      } catch {
        // removed while walking (retention, a run's temp file)
      }
    }
  }
  await walk(dir, undefined)
  return { total, files, byTop }
}

/** New lines of a growing text file since the last call (the app log rotates to `<file>.1`). */
class Tail {
  constructor(file) {
    this.file = file
    this.offset = 0
  }

  read() {
    const chunks = []
    let size
    try {
      size = statSync(this.file).size
    } catch {
      return []
    }
    if (size < this.offset) {
      chunks.push(readFrom(`${this.file}.1`, this.offset))
      this.offset = 0
    }
    chunks.push(readFrom(this.file, this.offset))
    this.offset = size
    return chunks
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
  }
}

function readFrom(file, offset) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size <= offset) return ''
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    // A line still being written is read next time.
    const text = buf.toString('utf8')
    const end = text.lastIndexOf('\n')
    return end === -1 ? '' : text.slice(0, end + 1)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Like Tail, but advancing only past complete lines (the fake CLI logs). */
class LineTail {
  constructor(file) {
    this.file = file
    this.offset = 0
  }

  read() {
    const text = readFrom(this.file, this.offset)
    this.offset += Buffer.byteLength(text, 'utf8')
    return text.split('\n').filter((l) => l.trim() !== '')
  }
}

// ---- fake vendor scenarios -------------------------------------------------------------------------------------------

const ts = (rel) => import(pathToFileURL(join(REPO_ROOT, rel)).href)

/** Text deltas of `size` characters with a `sleepMs` pause after each: a stream at a steady rate. */
const CHUNK_CHARS = 80
const CHUNK_SLEEP_MS = 50

function withPid(content) {
  return `// soak build $FAKE_PID\n${content}`
}

/** A write op made distinct per process ($FAKE_PID), so every run changes its folder. */
function distinctWrites(ops) {
  let n = 0
  for (const op of ops) {
    if (op.op !== 'writeFile' || typeof op.content !== 'string') continue
    op.content = withPid(op.content)
    op.substitute = true
    n++
  }
  if (n === 0) throw new Error('soak: a pass script has no write to make distinct')
  return ops
}

function readScript(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

function writeScript(file, ops) {
  writeFileSync(file, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
}

/**
 * The fake Claude: Plan (C06 native), Implement (C04a: two command asks, then the long answer streamed), Fix
 * resuming Implement's session (C08b, a shorter stream), Review (C02: findings when the fake's pid has an odd tens
 * digit, about half the runs, else NO FINDINGS) and Critic (NO FINDINGS). Every entry repeats.
 */
async function claudeScenario(root, implText, fixText) {
  const { makeScenario, REVIEW_WITH_FINDINGS } = await ts('tests/integration/run/scenario.ts')
  const { streamDeltas, VERSION_WRITE, FIX_WRITE } = await ts('tests/e2e/scenarios.ts')
  const sc = await makeScenario(
    {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE, text: implText }],
      resume: [{ recording: 'C08b-resume-fix', write: FIX_WRITE, text: fixText }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
    },
    root,
  )
  const pace = { chunkSize: CHUNK_CHARS, sleepMs: CHUNK_SLEEP_MS, sleepEvery: 1 }
  streamDeltas(sc, 'implement-1', implText, pace)
  streamDeltas(sc, 'resume-1', fixText, pace)
  for (const name of ['implement-1', 'resume-1']) {
    const file = join(sc.dir, `${name}.script.jsonl`)
    writeScript(file, distinctWrites(readScript(file)))
  }
  // Review: one script, two endings, chosen by the process id.
  const strip = (ops) => ops.filter((o) => !(o.op === 'label' && o.name === 'start'))
  const withFindings = strip(readScript(join(sc.dir, 'review-1.script.jsonl')))
  const clean = strip(readScript(join(sc.dir, 'review-default.script.jsonl')))
  const mixed = join(sc.dir, 'review-mixed.script.jsonl')
  writeScript(mixed, [
    {
      op: 'branch',
      on: { var: 'FAKE_PID' },
      cases: [{ matchRegex: '[13579][0-9]$', goto: 'soakFindings' }],
      default: 'soakClean',
    },
    { op: 'label', name: 'soakFindings' },
    ...withFindings,
    { op: 'label', name: 'soakClean' },
    ...clean,
  ])
  const scenarioFile = join(sc.dir, 'scenario.json')
  const entries = JSON.parse(readFileSync(scenarioFile, 'utf8'))
  for (const e of entries) {
    e.repeat = true
    if (e.script.endsWith('review-1.script.jsonl')) e.script = mixed
  }
  writeFileSync(scenarioFile, JSON.stringify(entries, null, 2))
  return { ...sc, env: { ...sc.env, FAKE_CLI_TIMEOUT_MS: '300000' } }
}

/** Replace the one long message of a Codex turn (two deltas) by deltas at the steady rate. */
function codexStream(ops, text) {
  const i = ops.findIndex((o) => o.json?.method === 'item/agentMessage/delta')
  if (i < 0 || ops[i + 1]?.json?.method !== 'item/agentMessage/delta')
    throw new Error('soak: no Codex deltas')
  const tmpl = ops[i].json
  const out = []
  for (let k = 0; k < text.length; k += CHUNK_CHARS) {
    out.push({
      op: 'stdout',
      json: { ...tmpl, params: { ...tmpl.params, delta: text.slice(k, k + CHUNK_CHARS) } },
    })
    out.push({ op: 'sleep', ms: CHUNK_SLEEP_MS })
  }
  ops.splice(i, 2, ...out)
  return ops
}

/** The fake Codex: Implement asks to run a command, streams, writes; Fix resumes the thread. */
async function codexFake(root, implText, fixText) {
  const { FakeCodex, CODEX_MODELS, editPass, resumePass, threadIdNow } = await ts(
    'tests/e2e/codex-helpers.ts',
  )
  const thread = threadIdNow('50a6')
  const implTotal = { input: 24_576, cached: 16_384, output: 1_450, reasoning: 512 }
  const edit = editPass({
    threadId: thread,
    turnId: 'turn-soak-implement',
    text: implText,
    approval: { command: 'npm test', reason: 'Run the test suite' },
    write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
    total: implTotal,
  })
  const resume = resumePass({
    threadId: thread,
    turnId: 'turn-soak-fix',
    text: fixText,
    write: { path: 'src/version.test.ts', content: 'import "./version"\n' },
    restored: implTotal,
    total: { input: 55_296, cached: 40_960, output: 2_430, reasoning: 896 },
  })
  const fake = new FakeCodex(root, {
    models: CODEX_MODELS,
    edit: distinctWrites(codexStream(edit, implText)),
    resume: { threadId: thread, ops: distinctWrites(codexStream(resume, fixText)) },
  })
  fake.writeRollout(thread)
  return { fake, env: { ...fake.env, FAKE_CLI_TIMEOUT_MS: '300000' } }
}

/** Replace a Gemini agent_message_chunk carrying `text` by chunks at the steady rate. */
function geminiStream(ops, text) {
  const i = ops.findIndex(
    (o) =>
      o.op === 'rpcNotify' &&
      o.params?.update?.sessionUpdate === 'agent_message_chunk' &&
      o.params.update.content?.text === text,
  )
  if (i < 0) throw new Error('soak: no Gemini message chunk to stream')
  const tmpl = ops[i]
  const out = []
  for (let k = 0; k < text.length; k += CHUNK_CHARS) {
    const update = { ...tmpl.params.update, content: { type: 'text', text: text.slice(k, k + CHUNK_CHARS) } }
    out.push({ ...tmpl, params: { ...tmpl.params, update } })
    out.push({ op: 'sleep', ms: CHUNK_SLEEP_MS })
  }
  ops.splice(i, 1, ...out)
  return ops
}

/** The fake Gemini: native Plan; Implement with an edit ask and a stream; Critic read-only; Fix by session/load. */
async function geminiFake(root, implText, fixText) {
  const { FakeGemini, SHELL_HERE, editPass, loadPass, planPass, readOnlyPass } = await ts(
    'tests/e2e/gemini-helpers.ts',
  )
  const edit = editPass({
    asks: [
      {
        toolCallId: 'run_shell_command-soak-1',
        kind: 'execute',
        title: 'npm test',
        content: `${SHELL_HERE} (Run the test suite)`,
        expect: 'proceed_once',
        after: 'completed',
        timeoutMs: 300_000,
      },
    ],
    write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
    text: implText,
    usage: { input: 11_264, cached: 6_144, output: 512, thought: 96 },
  })
  const load = loadPass({
    write: { path: 'src/version.test.ts', content: 'import "./version"\n' },
    text: fixText,
    usage: { input: 14_336, cached: 9_216, output: 640, thought: 160 },
  })
  const fake = new FakeGemini(root, {
    plan: planPass({
      plan: [
        '## Plan',
        '1. Read the version from package.json in src/cli.ts.',
        '2. Print it for --version and exit 0.',
        '3. Add a test in test/cli.test.ts.',
      ].join('\n'),
    }),
    edit: distinctWrites(geminiStream(edit, implText)),
    readOnly: readOnlyPass({
      asks: [
        {
          toolCallId: 'run_shell_command-soak-2',
          kind: 'execute',
          title: 'npm test',
          content: `${SHELL_HERE} (Run the test suite)`,
        },
        { toolCallId: 'write_file-soak-3', kind: 'edit', title: 'Writing to src/cli.ts' },
      ],
      text: 'NO FINDINGS',
      usage: { input: 12_288, cached: 8_192, output: 420, thought: 128 },
    }),
    load: distinctWrites(geminiStream(load, fixText)),
  })
  return { fake, env: { ...fake.env, FAKE_CLI_TIMEOUT_MS: '300000' } }
}

// ---- the soak -------------------------------------------------------------------------------------------------------

const PROFILES = [
  { name: 'claude-only', overrides: { profile: 'claude-only' } },
  { name: 'balanced', overrides: { profile: 'balanced', gates: { beforeFix: true } } },
  { name: 'soak-gemini', overrides: { profile: 'soak-gemini' } },
]

const SOAK_GEMINI_PROFILE = {
  plan: { vendor: 'gemini', model: null },
  implement: { vendor: 'gemini', model: null },
  review: { vendor: 'claude', model: 'sonnet' },
  critic: { vendor: 'gemini', model: null },
  fix: { inherit: 'implement', reuseSession: true },
}

const ACTIVE = ['queued', 'running', 'waiting', 'paused', 'failed']
const EXPECTED_CARDS = { 'gate:afterPlan': 'approve', 'gate:beforeFix': 'continue' }

class Soak {
  constructor(o) {
    this.o = o
    this.rand = prng(o.seed)
    this.t0 = Date.now()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    mkdirSync(o.out, { recursive: true })
    const base = join(o.out, `soak-${stamp}`)
    this.base = base
    /** --heap-snapshots: the snapshots written ({ process, tag, file, atMin, completed }). */
    this.heapSnapshots = []
    this.files = {
      csv: `${base}.csv`,
      jsonl: `${base}.samples.jsonl`,
      summary: `${base}.summary.md`,
      summaryJson: `${base}.summary.json`,
      log: `${base}.log`,
    }
    this.root = mkdtempSync(join(tmpdir(), 'dim-factory-soak-'))
    this.home = join(this.root, 'home')
    this.slots = []
    this.samples = []
    this.anomalies = []
    this.counts = {
      started: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      asksAnswered: 0,
      askAnswerErrors: 0,
      cardsResolved: 0,
      retentionPasses: 0,
      retentionRemoved: 0,
      navigations: 0,
      outcomes: {},
    }
    this.endedSinceSample = 0
    this.scheduled = new Set()
    this.pageErrors = []
    this.logErrors = []
    this.logWarns = 0
    /** Warn lines of the app log by message. */
    this.logWarnKinds = {}
    /** The app's stderr: Node process warnings (each an anomaly) and Chromium's own lines (counted only). */
    this.stderr = { nodeWarnings: [], chromiumLines: 0, otherLines: 0, sample: [] }
    this.loopWindows = []
    this.fakeErrors = []
    this.lingering = new Map()
    /** The last 50 runs that ended (the view visits them too). */
    this.endedRuns = []
    /** --phases: the phase running (1-based) and when its runs started (the first: the soak's start). */
    this.round = 1
    this.roundAt = this.t0
    this.draining = false
    /** Aborted when the runs drain: the view, focus and retention loops stop. */
    this.halt = new AbortController()
    this.sampling = false
    this.stopped = false
    this.app = null
    this.page = null
    this.cdp = null
    /** The process Playwright started (on Windows a cmd.exe that starts Electron): the root of the app's tree. */
    this.launcherPid = null
    this.mainPid = null
    this.rendererPid = null
    this.csvHeader = null
  }

  log(msg) {
    const min = ((Date.now() - this.t0) / 60_000).toFixed(1).padStart(6)
    const line = `[soak ${min} min] ${msg}`
    process.stdout.write(`${line}\n`)
    try {
      if (!existsSync(this.o.out)) mkdirSync(this.o.out, { recursive: true })
      appendFileSync(this.files.log, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // the log is best effort
    }
  }

  anomaly(kind, detail) {
    const a = { atMin: round((Date.now() - this.t0) / 60_000), kind, detail }
    this.anomalies.push(a)
    this.log(`ANOMALY ${kind}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }

  between(lo, hi) {
    return lo + this.rand() * (hi - lo)
  }

  // ---- setup ----

  async setup() {
    const o = this.o
    this.log(
      `root ${this.root}; seed ${o.seed}; ${o.runs} folders for ${o.minutes} min, a sample every ${o.sampleMin} min`,
    )
    if (o.build) {
      this.log('building (pnpm -s build)')
      const r = IS_WIN
        ? spawnSync('pnpm -s build', { cwd: REPO_ROOT, stdio: 'inherit', shell: true })
        : spawnSync('pnpm', ['-s', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
      if (r.status !== 0) throw new Error('pnpm -s build failed')
    }
    if (!existsSync(join(REPO_ROOT, 'out', 'main', 'index.js')))
      throw new Error('out/main/index.js is missing: build first')
    // The app: a copy of the build (package.json, out/, the tray icons), unless --in-place.
    if (o.inPlace) this.appDir = REPO_ROOT
    else {
      this.appDir = join(this.root, 'app')
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
      mkdirSync(this.appDir, { recursive: true })
      const appPkg = {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        private: true,
        type: 'module',
        main: pkg.main,
      }
      writeFileSync(join(this.appDir, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`)
      cpSync(join(REPO_ROOT, 'out'), join(this.appDir, 'out'), { recursive: true })
      const tray = join(REPO_ROOT, 'build', 'tray')
      if (existsSync(tray)) cpSync(tray, join(this.appDir, 'build', 'tray'), { recursive: true })
    }
    // The fake CLI, built into the temp root (its command lines name the root: how orphans are told apart).
    const { buildFakeCli } = await import(
      pathToFileURL(join(REPO_ROOT, 'scripts', 'build-fake-cli.mjs')).href
    )
    const build = await buildFakeCli({ outDir: join(this.root, 'fake-bin') })
    const launcher = (v) => (IS_WIN ? build.launchers.cmd?.[v] : build.launchers.sh?.[v])
    const { longText } = await ts('tests/e2e/scenarios.ts')
    const implText = longText(Math.round(o.streamKb * 1024))
    const fixText = longText(Math.round((o.streamKb * 1024) / 2))
    const claude = await claudeScenario(join(this.root, 'claude'), implText, fixText)
    const codex = await codexFake(join(this.root, 'codex'), implText, fixText)
    const gemini = await geminiFake(join(this.root, 'gemini'), implText, fixText)
    this.fakeLogs = [claude.log, codex.fake.log, gemini.fake.log].map((f) => new LineTail(f))
    const claudeConfigDir = join(this.root, 'claude-config')
    mkdirSync(claudeConfigDir, { recursive: true })
    // The folders.
    const { makeSandbox, hermeticEnv } = await ts('tests/integration/run/scenario.ts')
    for (let i = 0; i < o.runs; i++) {
      const folder = makeSandbox({ git: true }, join(this.root, 'folders', `f${i}`))
      this.slots.push({
        i,
        folder,
        profile: PROFILES[i % PROFILES.length],
        runId: null,
        nextStartAt: 0,
        startedAt: 0,
        runs: 0,
      })
    }
    // The home: user config (vendors, the soak profile, no self-heal) and a fresh catalog refresh date.
    mkdirSync(this.home, { recursive: true })
    const config = {
      profile: 'claude-only',
      profiles: { 'soak-gemini': SOAK_GEMINI_PROFILE },
      gates: { afterPlan: true, beforeFix: false },
      selfHeal: { enabled: false },
      ...(o.keepRuns !== undefined ? { storage: { keepRuns: o.keepRuns } } : {}),
      vendors: {
        claude: { path: launcher('claude'), env: { ...claude.env, CLAUDE_CONFIG_DIR: claudeConfigDir } },
        codex: { path: launcher('codex'), env: codex.env },
        gemini: { path: launcher('gemini'), env: gemini.env },
      },
    }
    writeFileSync(join(this.home, 'dimfactory.json'), `${JSON.stringify(config, null, 2)}\n`)
    const state = { schemaVersion: 1, catalog: { lastRefreshAt: Date.now(), snoozedUntil: null } }
    writeFileSync(join(this.home, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
    mkdirSync(join(this.root, 'user-home-app'), { recursive: true })
    this.env = hermeticEnv({
      DIM_FACTORY_HOME: this.home,
      DIM_FACTORY_E2E: '1',
      DIM_FACTORY_E2E_VENDOR_SEARCH: 'configured',
      CODEX_HOME: join(this.root, 'codex-home-app'),
      GEMINI_CLI_HOME: join(this.root, 'gemini-home-app'),
      GROK_HOME: join(this.root, 'grok-home-app'),
      DIM_FACTORY_E2E_USER_HOME: join(this.root, 'user-home-app'),
    })
    this.appLog = new Tail(join(this.home, 'logs', 'main.log'))
  }

  async launch() {
    const env = Object.fromEntries(Object.entries(this.env).filter(([, v]) => v !== undefined))
    this.app = await _electron.launch({
      args: ['--js-flags=--expose-gc', this.appDir],
      cwd: this.appDir,
      env,
      timeout: 90_000,
    })
    this.launcherPid = this.app.process().pid
    let partial = ''
    this.app.process().stderr?.on('data', (chunk) => {
      const lines = `${partial}${chunk}`.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) this.stderrLine(line)
    })
    this.app.process().once('exit', (code) => {
      if (!this.stopped) this.anomaly('app-exited', `the app exited with ${code}`)
      this.stopped = true
    })
    const page = await this.app.firstWindow({ timeout: 90_000 })
    this.page = page
    page.on('console', (m) => {
      if (m.type() === 'error') this.pageError(`console: ${m.text()}`)
    })
    page.on('pageerror', (e) => this.pageError(`pageerror: ${e.message}`))
    await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: 90_000 })
    const install = () => {
      const w = window
      w.__soakLongTasks = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__soakLongTasks.push(Math.round(e.duration))
      }).observe({ type: 'longtask', buffered: true })
    }
    await page.addInitScript(install)
    await page.evaluate(install)
    this.cdp = await page.context().newCDPSession(page)
    await this.cdp.send('Performance.enable')
    this.mainPid = await this.app.evaluate(() => process.pid)
    this.rendererPid = await this.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId(),
    )
    const hasGc = await this.app.evaluate(() => typeof globalThis.gc === 'function')
    if (!hasGc) this.log('warning: main has no gc(); the heap is measured without a forced GC')
    this.log(
      `app up: main pid ${this.mainPid} (started as ${this.launcherPid}), renderer pid ${this.rendererPid}`,
    )
  }

  /** One line of the app's stderr: a Node warning (`(node:<pid>) …Warning`) is an anomaly; the rest is counted. */
  stderrLine(line) {
    if (line.trim() === '') return
    if (/^\(node:\d+\) /.test(line) || /^\(electron\) /.test(line)) {
      this.stderr.nodeWarnings.push({
        atMin: round((Date.now() - this.t0) / 60_000),
        line: line.slice(0, 400),
      })
      this.anomaly('main-warning', line.slice(0, 300))
    } else if (/^\[\d+:\d+:/.test(line)) this.stderr.chromiumLines++
    else this.stderr.otherLines++
    if (this.stderr.sample.length < 20) this.stderr.sample.push(line.slice(0, 300))
  }

  pageError(text) {
    this.pageErrors.push({ atMin: round((Date.now() - this.t0) / 60_000), text: text.slice(0, 500) })
    this.log(`page error: ${text.slice(0, 300)}`)
  }

  async invoke(cmd, req) {
    return this.page.evaluate(([c, r]) => window.dimFactory.invoke(c, r), [cmd, req])
  }

  async call(cmd, req) {
    const r = await this.invoke(cmd, req)
    if (!r.ok) throw new Error(`${cmd}: ${r.error.code} ${r.error.message}`)
    return r.value
  }

  async main(fn) {
    return this.app.evaluate(fn)
  }

  async waitForVendors() {
    const want = ['claude', 'codex', 'gemini']
    const end = Date.now() + 180_000
    let forced = false
    for (;;) {
      const list = await this.call('vendors.list')
      const notReady = want.filter((v) => list.find((x) => x.vendor === v)?.health !== 'ready')
      if (notReady.length === 0) break
      if (Date.now() > end) throw new Error(`vendors not ready: ${notReady.join(', ')}`)
      if (!forced && Date.now() > end - 120_000) {
        forced = true
        await this.invoke('vendors.probe', { force: true })
      }
      await sleep(1000)
    }
    for (const s of this.slots.filter((x) => x.profile.name === 'soak-gemini'))
      await this.call('trust.set', {
        folder: s.folder,
        grant: { kind: 'vendorFolder', vendor: 'gemini' },
        trusted: true,
      })
    this.log('Claude, Codex and Gemini ready; Gemini folders trusted')
  }

  // ---- the driver ----

  async startRun(slot) {
    slot.runs++
    const task = `soak ${slot.i}.${slot.runs}: add a --version flag`
    try {
      const r = await this.call('runs.start', {
        folder: slot.folder,
        task,
        overrides: slot.profile.overrides,
      })
      slot.runId = r.runId
      slot.startedAt = Date.now()
      this.counts.started++
    } catch (err) {
      this.anomaly('start-failed', `folder ${slot.i}: ${err.message}`)
      slot.nextStartAt = Date.now() + 30_000
    }
  }

  async ended(slot) {
    const runId = slot.runId
    slot.runId = null
    slot.nextStartAt = this.draining ? Infinity : Date.now() + this.between(1_000, 5_000)
    let summary
    try {
      summary = (await this.call('runs.get', { runId })).summary
    } catch (err) {
      this.anomaly('ended-unreadable', `${runId}: ${err.message}`)
      return
    }
    this.endedSinceSample++
    this.endedRuns.push(runId)
    if (this.endedRuns.length > 50) this.endedRuns.shift()
    const key = `${summary.status}${summary.outcome !== undefined ? `/${summary.outcome}` : ''}`
    this.counts.outcomes[key] = (this.counts.outcomes[key] ?? 0) + 1
    if (summary.status === 'completed') this.counts.completed++
    else if (summary.status === 'cancelled') this.counts.cancelled++
    else this.counts.failed++
    if (summary.status !== 'completed') this.anomaly('run-not-completed', describe(summary))
  }

  async failed(slot, summary) {
    this.counts.failed++
    this.anomaly('run-failed', describe(summary))
    const runId = slot.runId
    slot.runId = null
    slot.nextStartAt = this.draining ? Infinity : Date.now() + 5_000
    this.endedSinceSample++
    const key = `${summary.status}/${summary.failure?.category ?? '-'}`
    this.counts.outcomes[key] = (this.counts.outcomes[key] ?? 0) + 1
    const r = await this.invoke('runs.close', { runId })
    if (!r.ok) this.anomaly('close-failed', `${runId}: ${r.error.code} ${r.error.message}`)
  }

  /** Answer asks and resolve cards of a run that waits, each after a random delay. */
  async attend(slot) {
    const runId = slot.runId
    let snap
    try {
      snap = await this.call('runs.get', { runId })
    } catch (err) {
      this.anomaly('get-failed', `${runId}: ${err.message}`)
      return
    }
    for (const ask of snap.asks) {
      const key = `ask:${runId}:${ask.requestId}`
      if (this.scheduled.has(key) || ask.pendingDenyUntil !== undefined) continue
      this.scheduled.add(key)
      setTimeout(() => void this.answer(runId, ask.requestId), this.between(1_500, 20_000))
    }
    for (const card of snap.cards) {
      if (!card.blocking) continue
      const key = `card:${runId}:${card.id}`
      if (this.scheduled.has(key)) continue
      this.scheduled.add(key)
      let choice = EXPECTED_CARDS[card.kind]
      if (choice === undefined) {
        // Not part of the soak's flow: the run is cancelled (a recheck could loop) and the card counts.
        const cancel = card.choices.find((c) => c.id === 'cancel' || c.id === 'stop')?.id
        this.anomaly('unexpected-card', `${runId} ${card.kind} "${card.title}" → ${cancel ?? 'runs.stop'}`)
        if (cancel === undefined) {
          void this.invoke('runs.stop', { runId })
          continue
        }
        choice = cancel
      }
      setTimeout(() => void this.resolveCard(runId, card.id, choice), this.between(1_500, 15_000))
    }
  }

  async answer(runId, requestId) {
    if (this.stopped) return
    const r = await this.invoke('asks.answer', { runId, requestId, decision: 'allow' }).catch((err) => ({
      ok: false,
      error: { code: 'SOAK', message: err.message },
    }))
    if (r.ok) this.counts.asksAnswered++
    else {
      this.counts.askAnswerErrors++
      this.anomaly('ask-answer-failed', `${runId} ${requestId}: ${r.error.code} ${r.error.message}`)
    }
  }

  async resolveCard(runId, cardId, choiceId) {
    if (this.stopped) return
    const r = await this.invoke('cards.resolve', { runId, cardId, choiceId }).catch((err) => ({
      ok: false,
      error: { code: 'SOAK', message: err.message },
    }))
    if (r.ok) this.counts.cardsResolved++
    else
      this.anomaly(
        'card-resolve-failed',
        `${runId} ${cardId} ${choiceId}: ${r.error.code} ${r.error.message}`,
      )
  }

  async tick(n) {
    const page = await this.call('runs.list', { status: ACTIVE, limit: 1000 })
    const byId = new Map(page.items.map((s) => [s.runId, s]))
    for (const slot of this.slots) {
      if (this.stopped) return
      if (slot.runId === null) {
        if (!this.draining && Date.now() >= slot.nextStartAt) await this.startRun(slot)
        continue
      }
      const s = byId.get(slot.runId)
      if (s === undefined) await this.ended(slot)
      else if (s.status === 'failed') await this.failed(slot, s)
      else if (s.status === 'paused') {
        this.anomaly('run-paused', describe(s))
        await this.failed(slot, s)
      } else if (s.status === 'waiting' || n % 5 === 0) await this.attend(slot)
    }
  }

  async driveLoop() {
    for (let n = 0; !this.stopped; n++) {
      try {
        await this.tick(n)
      } catch (err) {
        if (this.stopped) return
        this.anomaly('driver-error', err.message)
      }
      if (this.draining && this.slots.every((s) => s.runId === null)) return
      await sleep(2_000)
    }
  }

  // ---- the view, focus and retention ----

  async setHash(hash) {
    await this.page.evaluate((h) => {
      if (location.hash !== h) location.hash = h
    }, hash)
  }

  /**
   * Once, two minutes in: every kind of view, so what the app starts once (the Diff tab's highlighter workers, the
   * views' lazy chunks) starts in the warm-up and not in the measured samples.
   */
  async warmViews() {
    if (!(await pause(120_000, this.halt.signal))) return
    const live = this.slots.find((s) => s.runId !== null)?.runId
    const hashes = [
      ...(live !== undefined ? [`#/runs/${live}`, `#/runs/${live}/diff`, `#/runs/${live}/log`] : []),
      '#/runs',
      ...['general', 'vendors', 'catalog', 'diagnostics'].map((s) => `#/settings/${s}`),
      '#/',
    ]
    for (const h of hashes) {
      if (this.stopped || this.draining) return
      if (this.sampling) await sleep(5_000)
      await this.setHash(h).catch(() => undefined)
      await sleep(h.endsWith('/diff') ? 10_000 : 3_000)
    }
    this.log(`views warmed (${hashes.length} views)`)
  }

  async navLoop(warm = true) {
    if (warm) await this.warmViews()
    while (!this.stopped && !this.draining) {
      if (!(await pause(this.between(30_000, 75_000), this.halt.signal))) return
      if (this.stopped || this.sampling) continue
      try {
        const live = this.slots.filter((s) => s.runId !== null)
        const r = this.rand()
        let hash = '#/'
        const tab = this.rand() < 0.6 ? '' : this.rand() < 0.5 ? '/diff' : '/log'
        const pick = (list) => list[Math.floor(this.rand() * list.length)]
        if (r < 0.45 && live.length > 0) hash = `#/runs/${pick(live).runId}${tab}`
        // A finished run of the last 50 (its snapshot loads again; its log is read cold once its ring is gone).
        else if (r < 0.58 && this.endedRuns.length > 0) hash = `#/runs/${pick(this.endedRuns)}${tab}`
        else if (r < 0.7) hash = '#/runs'
        else if (r < 0.8)
          hash = `#/settings/${['general', 'vendors', 'catalog', 'diagnostics'][Math.floor(this.rand() * 4)]}`
        await this.setHash(hash)
        this.counts.navigations++
      } catch (err) {
        if (!this.stopped) this.anomaly('nav-error', err.message)
      }
    }
  }

  async focusLoop() {
    let unfocused = false
    while (!this.stopped && !this.draining) {
      if (!(await pause(10 * 60_000, this.halt.signal))) return
      unfocused = !unfocused
      try {
        await this.app.evaluate(
          (_e, f) => globalThis.__dimFactoryE2E.focus.simulate(f),
          unfocused ? false : null,
        )
        this.log(
          unfocused
            ? 'window reads unfocused (notifications go to the recorder)'
            : 'window focus is real again',
        )
      } catch (err) {
        if (!this.stopped) this.anomaly('focus-error', err.message)
      }
    }
  }

  async retentionLoop() {
    if (this.o.retentionMin <= 0) return
    while (!this.stopped && !this.draining) {
      if (!(await pause(this.o.retentionMin * 60_000, this.halt.signal))) return
      try {
        const report = await this.app.evaluate(() => globalThis.__dimFactoryE2E.history.retention())
        this.counts.retentionPasses++
        const removed = Array.isArray(report?.removed) ? report.removed.length : Number(report?.removed ?? 0)
        this.counts.retentionRemoved += Number.isFinite(removed) ? removed : 0
        this.log(`retention: ${JSON.stringify(report).slice(0, 300)}`)
      } catch (err) {
        if (!this.stopped) this.anomaly('retention-error', err.message)
      }
    }
  }

  // ---- sampling ----

  async sample(phase) {
    this.sampling = true
    const at = Date.now()
    try {
      await this.setHash('#/')
      await sleep(3_000)
      const loop = await this.main(() => globalThis.__dimFactoryE2E.eventLoop.read())
      const mainMem = await this.main(() => {
        const before = process.memoryUsage()
        globalThis.gc?.()
        globalThis.gc?.()
        const after = process.memoryUsage()
        // Compiled code and its metadata (machine code, bytecode, deoptimization data) live in V8's code and trusted
        // spaces; everything else on the heap is the app's data.
        let code = 0
        for (const sp of process.getBuiltinModule('node:v8').getHeapSpaceStatistics())
          if (/^(code|trusted)(_large_object)?_space$/.test(sp.space_name)) code += sp.space_used_size
        const resources = {}
        for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] ?? 0) + 1
        return { before, after, code, resources }
      })
      await this.main(() => globalThis.__dimFactoryE2E.eventLoop.reset())
      await this.cdp.send('HeapProfiler.collectGarbage')
      await this.cdp.send('HeapProfiler.collectGarbage')
      const metrics = Object.fromEntries(
        (await this.cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
      )
      const longTasks = await this.page.evaluate(() => {
        const out = window.__soakLongTasks ?? []
        window.__soakLongTasks = []
        return out
      })
      // The E2E notification recorder keeps the last 200 (RECORDED_MAX) for the specs to read: a stand-in the real
      // app does not have, emptied here so its fill does not read as main's growth. Counted first.
      const notifications = await this.main(() => {
        const n = globalThis.__dimFactoryE2E.notifications
        if (n === undefined) return null
        const count = n.list().length
        n.clear()
        return count
      })
      const appMetrics = await this.main(({ app }) =>
        app.getAppMetrics().map((m) => ({
          pid: m.pid,
          type: m.type,
          ws: m.memory.workingSetSize,
          priv: m.memory.privateBytes ?? null,
          cpu: m.cpu.percentCPUUsage,
        })),
      )
      const state = await this.call('e2e.state')
      const table = await processTable()
      const home = await folderSizes(this.home)
      const logs = this.scanAppLog()
      const fakeErrors = this.scanFakeLogs()

      // Processes.
      let procs = null
      if (table !== null) {
        const tree = descendants(table, this.mainPid)
        const inTree = new Set(descendants(table, this.launcherPid).map((p) => p.pid))
        inTree.add(this.launcherPid)
        const byName = {}
        for (const p of tree) {
          const name = p.name.toLowerCase()
          if (/^electron(\.exe)?$/.test(name)) continue
          byName[name] = (byName[name] ?? 0) + 1
        }
        const ours = table.filter((p) => samePathPrefix(p.cmd, this.root) && p.pid !== process.pid)
        const orphans = ours.filter((p) => !inTree.has(p.pid))
        const live = new Set(state.procs.map((p) => p.pid))
        const fakes = tree.filter((p) => samePathPrefix(p.cmd, join(this.root, 'fake-bin')))
        // A fake under main that core does not count as a pass's process, two samples running: lingering.
        const untracked = fakes.filter(
          (p) => !live.has(p.pid) && !(p.ppid !== this.mainPid && live.has(p.ppid)),
        )
        const nextLinger = new Map()
        for (const p of untracked) {
          const seen = (this.lingering.get(p.pid) ?? 0) + 1
          nextLinger.set(p.pid, seen)
          if (seen === 2) this.anomaly('lingering-child', `${p.pid} ${p.cmd.slice(0, 200)}`)
        }
        this.lingering = nextLinger
        for (const p of orphans) this.anomaly('orphan', `${p.pid} (parent ${p.ppid}) ${p.cmd.slice(0, 200)}`)
        const mainRow = table.find((p) => p.pid === this.mainPid)
        const rendererRow = table.find((p) => p.pid === this.rendererPid)
        procs = {
          children: Object.values(byName).reduce((s, n) => s + n, 0),
          byName,
          electron: tree.filter((p) => /^electron(\.exe)?$/i.test(p.name)).length,
          fakes: fakes.length,
          untracked: untracked.length,
          orphans: orphans.length,
          mainHandles: mainRow?.handles ?? fdCount(this.mainPid),
          rendererHandles: rendererRow?.handles ?? fdCount(this.rendererPid),
        }
      }
      const elapsed = at - this.t0
      const sinceLast = this.samples.length > 0 ? at - this.samples.at(-1).at : null
      // app.getAppMetrics() reports kilobytes.
      const ws = (type) => appMetrics.filter((m) => m.type === type).reduce((s, m) => s + m.ws, 0) * 1024
      const s = {
        at,
        phase,
        round: this.round,
        roundAt: this.roundAt,
        min: round(elapsed / 60_000, 2),
        runs: {
          active: this.slots.filter((x) => x.runId !== null).length,
          started: this.counts.started,
          completed: this.counts.completed,
          failed: this.counts.failed,
          cancelled: this.counts.cancelled,
          endedInterval: this.endedSinceSample,
          perHour:
            sinceLast !== null && sinceLast > 0 ? round((this.endedSinceSample * HOUR_MS) / sinceLast) : null,
          asksAnswered: this.counts.asksAnswered,
          cardsResolved: this.counts.cardsResolved,
          liveVendorProcs: state.procs.length,
          notificationsInterval: notifications,
        },
        main: {
          rssMb: mb(mainMem.after.rss),
          heapUsedBeforeGcMb: mb(mainMem.before.heapUsed),
          heapUsedMb: mb(mainMem.after.heapUsed),
          // The heap after GC split into compiled code (V8's code and trusted spaces) and the rest, the app's data.
          codeMb: mb(mainMem.code),
          dataHeapMb: mb(mainMem.after.heapUsed - mainMem.code),
          heapTotalMb: mb(mainMem.after.heapTotal),
          externalMb: mb(mainMem.after.external),
          arrayBuffersMb: mb(mainMem.after.arrayBuffers),
          resources: mainMem.resources,
          resourceCount: Object.values(mainMem.resources).reduce((a, b) => a + b, 0),
          eventLoopP95Ms: loop.p95Ms,
          eventLoopMaxMs: loop.maxMs,
          eventLoopP50Ms: loop.p50Ms,
          wsMb: mb(ws('Browser')),
        },
        renderer: {
          heapUsedMb: mb(metrics.JSHeapUsedSize ?? NaN),
          heapTotalMb: mb(metrics.JSHeapTotalSize ?? NaN),
          nodes: metrics.Nodes ?? null,
          listeners: metrics.JSEventListeners ?? null,
          documents: metrics.Documents ?? null,
          frames: metrics.Frames ?? null,
          longTasks: longTasks.length,
          longTaskMaxMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
          longTaskTotalMs: longTasks.reduce((a, b) => a + b, 0),
          wsMb: mb(ws('Tab')),
        },
        app: {
          wsMb: mb(appMetrics.reduce((a, m) => a + m.ws, 0) * 1024),
          privMb: mb(appMetrics.reduce((a, m) => a + (m.priv ?? 0), 0) * 1024),
          gpuWsMb: mb(ws('GPU')),
          processes: appMetrics.length,
          mainCpu: round(appMetrics.find((m) => m.type === 'Browser')?.cpu ?? NaN),
        },
        procs,
        home: {
          totalMb: mb(home.total),
          files: home.files,
          runsMb: mb(home.byTop['runs'] ?? 0),
          logsMb: mb(home.byTop['logs'] ?? 0),
          shadowMb: mb(
            Object.entries(home.byTop)
              .filter(([k]) => /shadow/i.test(k))
              .reduce((a, [, v]) => a + v, 0),
          ),
          byTop: Object.fromEntries(Object.entries(home.byTop).map(([k, v]) => [k, mb(v)])),
          runDirs: await countDirs(join(this.home, 'runs')),
        },
        logs: { errors: logs.errors, warns: logs.warns, windowP95MaxMs: logs.windowP95Max },
        fakeErrors,
        pageErrors: this.pageErrors.length,
        anomalies: this.anomalies.length,
      }
      this.endedSinceSample = 0
      this.samples.push(s)
      this.writeSample(s)
      this.log(
        `sample ${phase}: runs ${s.runs.completed} done/${s.runs.started} started (${s.runs.active} active, ` +
          `${s.runs.perHour ?? '-'}/h) · main heap ${s.main.heapUsedMb} MB (rss ${s.main.rssMb}) · renderer heap ` +
          `${s.renderer.heapUsedMb} MB, ${s.renderer.nodes} nodes · handles ${procs?.mainHandles ?? '-'} · children ` +
          `${procs?.children ?? '-'} · orphans ${procs?.orphans ?? '-'} · loop p95 ${loop.p95Ms} ms · long tasks ` +
          `${longTasks.length} · home ${s.home.totalMb} MB · log errors ${logs.errors}`,
      )
      return s
    } finally {
      this.sampling = false
    }
  }

  scanAppLog() {
    let errors = 0
    let windowP95Max = null
    for (const line of this.appLog.read()) {
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec.msg === 'event loop delay (60 s window)' && Number.isFinite(rec.p95Ms)) {
        this.loopWindows.push({ at: rec.ts, p95Ms: rec.p95Ms, maxMs: rec.maxMs })
        windowP95Max = Math.max(windowP95Max ?? 0, rec.p95Ms)
      }
      if (rec.level === 'error') {
        errors++
        this.logErrors.push({ ts: rec.ts, msg: rec.msg, rec: JSON.stringify(rec).slice(0, 800) })
      } else if (rec.level === 'warn') {
        this.logWarns++
        const k = String(rec.msg ?? '?').slice(0, 120)
        this.logWarnKinds[k] = (this.logWarnKinds[k] ?? 0) + 1
      }
    }
    return { errors: this.logErrors.length, warns: this.logWarns, windowP95Max, newErrors: errors }
  }

  scanFakeLogs() {
    for (const t of this.fakeLogs) {
      for (const line of t.read()) {
        if (!line.includes('"kind":"error"')) continue
        let rec
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        if (rec.kind !== 'error') continue
        this.fakeErrors.push({ file: t.file, pid: rec.pid, rec: line.slice(0, 800) })
        this.anomaly(
          'fake-error',
          `${t.file.split(/[\\/]/).slice(-2).join('/')} pid ${rec.pid}: ${line.slice(0, 300)}`,
        )
      }
    }
    return this.fakeErrors.length
  }

  writeSample(s) {
    const row = {
      min: s.min,
      phase: s.phase,
      soak_phase: s.round ?? 1,
      active: s.runs.active,
      started: s.runs.started,
      completed: s.runs.completed,
      failed: s.runs.failed,
      cancelled: s.runs.cancelled,
      runs_per_hour: s.runs.perHour,
      asks_answered: s.runs.asksAnswered,
      cards_resolved: s.runs.cardsResolved,
      notifications_interval: s.runs.notificationsInterval ?? '',
      live_vendor_procs: s.runs.liveVendorProcs,
      main_heap_after_gc_mb: s.main.heapUsedMb,
      main_code_mb: s.main.codeMb ?? '',
      main_data_heap_mb: s.main.dataHeapMb ?? '',
      main_heap_before_gc_mb: s.main.heapUsedBeforeGcMb,
      main_heap_total_mb: s.main.heapTotalMb,
      main_external_mb: s.main.externalMb,
      main_array_buffers_mb: s.main.arrayBuffersMb,
      main_rss_mb: s.main.rssMb,
      main_ws_mb: s.main.wsMb,
      main_cpu_pct: s.app.mainCpu,
      main_libuv_resources: s.main.resourceCount,
      main_os_handles: s.procs?.mainHandles ?? '',
      renderer_heap_after_gc_mb: s.renderer.heapUsedMb,
      renderer_heap_total_mb: s.renderer.heapTotalMb,
      renderer_dom_nodes: s.renderer.nodes,
      renderer_listeners: s.renderer.listeners,
      renderer_documents: s.renderer.documents,
      renderer_ws_mb: s.renderer.wsMb,
      renderer_os_handles: s.procs?.rendererHandles ?? '',
      gpu_ws_mb: s.app.gpuWsMb,
      app_ws_mb: s.app.wsMb,
      app_private_mb: s.app.privMb,
      electron_processes: s.app.processes,
      child_procs: s.procs?.children ?? '',
      fake_procs: s.procs?.fakes ?? '',
      untracked_fakes: s.procs?.untracked ?? '',
      orphans: s.procs?.orphans ?? '',
      event_loop_p50_ms: s.main.eventLoopP50Ms,
      event_loop_p95_ms: s.main.eventLoopP95Ms,
      event_loop_max_ms: s.main.eventLoopMaxMs,
      event_loop_60s_p95_max_ms: s.logs.windowP95MaxMs,
      long_tasks: s.renderer.longTasks,
      long_task_max_ms: s.renderer.longTaskMaxMs,
      home_mb: s.home.totalMb,
      home_files: s.home.files,
      home_runs_mb: s.home.runsMb,
      home_shadow_mb: s.home.shadowMb,
      home_logs_mb: s.home.logsMb,
      run_dirs: s.home.runDirs,
      log_errors: s.logs.errors,
      log_warns: s.logs.warns,
      fake_errors: s.fakeErrors,
      page_errors: s.pageErrors,
      anomalies: s.anomalies,
    }
    // Playwright clears test-results/ when it starts (an E2E run beside the soak): the folder comes back.
    mkdirSync(this.o.out, { recursive: true })
    if (this.csvHeader === null || !existsSync(this.files.csv)) {
      this.csvHeader = Object.keys(row)
      writeFileSync(this.files.csv, `${this.csvHeader.join(',')}\n`)
    }
    appendFileSync(this.files.csv, `${this.csvHeader.map((k) => csvCell(row[k])).join(',')}\n`)
    appendFileSync(this.files.jsonl, `${JSON.stringify(s)}\n`)
  }

  /** The CSV and the samples file again, whole, from memory (an earlier write may have been cleared away). */
  rewriteSampleFiles() {
    mkdirSync(this.o.out, { recursive: true })
    this.csvHeader = null
    writeFileSync(this.files.jsonl, '')
    for (const s of this.samples) this.writeSample(s)
  }

  async sampleLoop(until, last = true) {
    const every = this.o.sampleMin * 60_000
    let next = Date.now() + every
    while (!this.stopped && Date.now() < until) {
      await sleep(Math.max(0, Math.min(next, until) - Date.now()))
      if (this.stopped || Date.now() >= until) break
      try {
        await this.sample('run')
        const warm = Date.now() >= this.t0 + this.o.warmupMin * 60_000
        if (this.o.heapSnapshots && warm && !this.hasHeapSnapshot('a')) await this.takeHeapSnapshots('a')
      } catch (err) {
        if (!this.stopped) this.anomaly('sample-error', err.stack ?? err.message)
      }
      next += every
    }
    if (last && this.o.heapSnapshots && !this.stopped && this.hasHeapSnapshot('a'))
      await this.takeHeapSnapshots('b').catch((err) => this.anomaly('sample-error', err.stack ?? err.message))
  }

  hasHeapSnapshot(tag) {
    return this.heapSnapshots.some((x) => x.tag === tag)
  }

  /**
   * --heap-snapshots: main's heap (v8.writeHeapSnapshot after a forced GC) and the renderer's (CDP), written next to the
   * samples: 'start' (main, before the first run), 'a' (after the warm-up), 'b' (the end of the runs) and 'cleared'
   * (main, every run removed). The summary compares them by constructor (heapGrowth).
   */
  async takeHeapSnapshots(tag, renderer = true) {
    const atMin = round((Date.now() - this.t0) / 60_000)
    const main = `${this.base}.main-${tag}.heapsnapshot`
    await this.app.evaluate((_e, f) => {
      globalThis.gc?.()
      return process.getBuiltinModule('node:v8').writeHeapSnapshot(f)
    }, main)
    this.heapSnapshots.push({ process: 'main', tag, file: main, atMin, completed: this.counts.completed })
    if (!renderer) {
      this.log(`heap snapshot ${tag} written (${main})`)
      return
    }
    const rendererFile = `${this.base}.renderer-${tag}.heapsnapshot`
    const chunks = []
    const onChunk = (e) => chunks.push(e.chunk)
    this.cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
    try {
      await this.cdp.send('HeapProfiler.collectGarbage')
      await this.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    } finally {
      this.cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
    }
    writeFileSync(rendererFile, chunks.join(''))
    this.heapSnapshots.push({
      process: 'renderer',
      tag,
      file: rendererFile,
      atMin,
      completed: this.counts.completed,
    })
    this.log(`heap snapshots ${tag} written (${main}, ${rendererFile})`)
  }

  // ---- the run ----

  async run() {
    const o = this.o
    await this.setup()
    await this.launch()
    await this.waitForVendors()
    await sleep(10_000)
    await this.sample('idle-start')
    if (o.heapSnapshots) await this.takeHeapSnapshots('start', false)
    const phaseMs = (o.minutes * 60_000) / o.phases
    for (let phase = 1; phase <= o.phases && !this.stopped; phase++) {
      const last = phase === o.phases
      if (phase > 1) {
        // --phases: the next phase starts from an empty history; its runs and their rings build up again.
        this.round = phase
        this.roundAt = Date.now()
        this.draining = false
        this.halt = new AbortController()
        for (const s of this.slots) s.nextStartAt = Date.now() + this.between(1_000, 5_000)
      }
      const until = (phase === 1 ? this.t0 : this.roundAt) + phaseMs
      this.log(
        `${o.phases > 1 ? `phase ${phase} of ${o.phases}: ` : ''}starting ${o.runs} folders; the runs stop at ` +
          `${new Date(until).toLocaleTimeString()}`,
      )
      const drive = this.driveLoop()
      const side = [this.navLoop(phase === 1), this.focusLoop(), this.retentionLoop()]
      await this.sampleLoop(until, last)
      await this.drain(drive, side)
      if (last || this.app === null || this.stopped) break
      // Between phases: every run removed at once (no settle: removal closes a loaded run and drops its ring), then
      // the cleared sample this phase is judged by.
      await this.main(() => globalThis.__dimFactoryE2E.focus.simulate(null)).catch(() => undefined)
      await this.clearHistory()
      this.endedRuns = []
      await this.sample('cleared')
      if (o.heapSnapshots)
        await this.takeHeapSnapshots(`cleared-${phase}`, false).catch((err) =>
          this.anomaly('sample-error', err.message),
        )
    }
    if (this.app !== null && !this.stopped) {
      await this.main(() => globalThis.__dimFactoryE2E.focus.simulate(null)).catch(() => undefined)
      this.log(`settling ${o.settleMin} min before the idle sample`)
      await sleep(Math.max(20_000, o.settleMin * 60_000))
      const idle = await this.sample('idle-end')
      this.checkIdle(idle)
      if (o.clear) {
        await this.clearHistory()
        await this.sample('cleared')
        if (o.heapSnapshots)
          await this.takeHeapSnapshots('cleared', false).catch((err) =>
            this.anomaly('sample-error', err.message),
          )
      }
    }
    this.stopped = true
    await this.quit()
  }

  /** No new runs; the active ones finish (asks and gates still answered); then the loops of the phase end. */
  async drain(drive, side) {
    const o = this.o
    this.draining = true
    this.halt.abort()
    this.log('draining: no new runs; waiting for the active ones to end')
    const drainEnd = Date.now() + o.drainMin * 60_000
    while (!this.stopped && this.slots.some((s) => s.runId !== null) && Date.now() < drainEnd)
      await sleep(2_000)
    const left = this.slots.filter((s) => s.runId !== null)
    if (left.length > 0) {
      this.anomaly(
        'drain-timeout',
        `${left.length} runs still active after ${o.drainMin} min: ${left.map((s) => s.runId).join(', ')}`,
      )
      for (const s of left) await this.invoke('runs.stop', { runId: s.runId })
      await sleep(15_000)
    }
    await drive.catch(() => undefined)
    await Promise.allSettled(side)
  }

  /**
   * After the idle sample, every run of the history is removed (runs.remove, its undo window, the deletes), so what
   * main still holds is no run's: the 'cleared' sample shows whether its growth was the history kept by design.
   */
  async clearHistory() {
    const ids = []
    let cursor
    for (;;) {
      const page = await this.call('runs.list', { limit: 1000, ...(cursor !== undefined ? { cursor } : {}) })
      ids.push(...page.items.map((s) => s.runId))
      if (typeof page.nextCursor !== 'string') break
      cursor = page.nextCursor
    }
    for (let i = 0; i < ids.length; i += 500) {
      const r = await this.invoke('runs.remove', { runIds: ids.slice(i, i + 500) })
      if (!r.ok) this.anomaly('remove-failed', `${r.error.code} ${r.error.message}`)
    }
    // history.ts REMOVE_UNDO_MS (10 s), then the deletes in flight (the retention hook awaits them).
    await sleep(15_000)
    await this.main(() => globalThis.__dimFactoryE2E.history.retention()).catch((err) =>
      this.anomaly('retention-error', err.message),
    )
    const end = Date.now() + 300_000
    while ((await countDirs(join(this.home, 'runs'))) > 0 && Date.now() < end) await sleep(2_000)
    const left = await countDirs(join(this.home, 'runs'))
    if (left > 0)
      this.anomaly('clear-incomplete', `${left} run folders left after removing ${ids.length} runs`)
    this.log(`removed the ${ids.length} runs of the history; ${left} run folders left`)
    await sleep(10_000)
  }

  checkIdle(idle) {
    if (idle.procs === null) return
    const { byName } = idle.procs
    const workers = Object.entries(byName).filter(([n]) => !/^(conhost|crashpad_handler)(\.exe)?$/i.test(n))
    if (workers.length > 0) this.anomaly('children-after-drain', JSON.stringify(Object.fromEntries(workers)))
  }

  async quit() {
    const app = this.app
    if (app === null) return
    this.app = null
    const closed = await Promise.race([
      app.close().then(
        () => true,
        () => false,
      ),
      sleep(30_000).then(() => false),
    ])
    if (!closed) {
      this.anomaly('quit-timeout', 'the app did not close in 30 s; killing it')
      killPid(this.launcherPid, true)
    }
    await sleep(5_000)
    const table = await processTable()
    if (table === null) return
    const left = table.filter((p) => samePathPrefix(p.cmd, this.root) && p.pid !== process.pid)
    this.leftAfterQuit = left.map((p) => ({ pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 200) }))
    for (const p of left) {
      this.anomaly('left-after-quit', `${p.pid} ${p.name} ${p.cmd.slice(0, 200)}`)
      killPid(p.pid, false)
    }
  }

  // ---- the summary ----

  summarize() {
    return analyze({
      samples: this.samples,
      t0: this.t0,
      endAt: Date.now(),
      warmupMin: this.o.warmupMin,
      options: { ...this.o, out: undefined },
      root: this.root,
      counts: this.counts,
      loopWindows: this.loopWindows,
      logErrors: this.logErrors,
      logErrorCount: this.logErrors.length,
      logWarns: this.logWarns,
      logWarnKinds: this.logWarnKinds,
      stderr: this.stderr,
      fakeErrors: this.fakeErrors,
      fakeErrorCount: this.fakeErrors.length,
      pageErrors: this.pageErrors,
      pageErrorCount: this.pageErrors.length,
      anomalies: this.anomalies,
      leftAfterQuit: this.leftAfterQuit ?? [],
      heapGrowth: this.heapGrowth(),
      files: this.files,
    })
  }

  /**
   * --heap-snapshots: what grew by constructor (top 25), in each process, while the runs ran (after the warm-up to
   * the end of the runs) and, in main, from before the first run to every run removed.
   */
  heapGrowth() {
    const out = {}
    const pairs = [
      ['main', 'a', 'b'],
      ['renderer', 'a', 'b'],
      ['main', 'start', 'cleared'],
      // --phases: what main kept with every run removed, from the first phase's clear to the last, compiled code by
      // function name too (which code grew, if any did).
      ['main', 'cleared-1', 'cleared', true],
    ]
    for (const [proc, from, to, codeNames = false] of pairs) {
      const a = this.heapSnapshots.find((x) => x.process === proc && x.tag === from)
      const b = this.heapSnapshots.find((x) => x.process === proc && x.tag === to)
      if (a === undefined || b === undefined) continue
      const name = `${proc} ${from} to ${to}`
      try {
        out[name] = {
          from: a,
          to: b,
          runs: b.completed - a.completed,
          top: heapDiff(a.file, b.file, 25),
          ...(codeNames ? { code: heapDiff(a.file, b.file, 25, { codeNames, only: 'code' }) } : {}),
        }
      } catch (err) {
        out[name] = { error: err.message }
      }
    }
    return out
  }

  writeSummary(sum) {
    this.rewriteSampleFiles()
    writeFileSync(this.files.summaryJson, `${JSON.stringify(sum, null, 2)}\n`)
    const md = summaryMarkdown(sum)
    writeFileSync(this.files.summary, md)
    process.stdout.write(`\n${md}`)
  }

  cleanup() {
    if (this.o.keep) {
      this.log(`kept ${this.root}`)
      return
    }
    try {
      rmSync(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (err) {
      this.log(`could not delete ${this.root}: ${err.message}`)
    }
  }
}

// ---- the analysis -----------------------------------------------------------------------------------------------------

/** Anomaly kinds the other checks already judge. */
const JUDGED_ELSEWHERE = new Set([
  'orphan',
  'left-after-quit',
  'children-after-drain',
  'fake-error',
  'run-failed',
  'run-not-completed',
  'run-paused',
])

/**
 * The summary of a soak from its samples (live at the end of a run, or later with --summarize). A series' growth is
 * its least-squares slope after the warm-up divided by the runs completed an hour over the same samples: what each
 * run leaves behind. DOM counts are judged by their last third's median against their first third's.
 */
function analyze(d) {
  const T = TOLERANCE
  // Each phase's first warmupMin minutes are left out (the first phase's counted from the soak's start), and a
  // series' slope is fitted within each phase: a phase that starts after every run was removed starts lower.
  const warmupMs = (d.warmupMin ?? 0) * 60_000
  const run = d.samples.filter((s) => s.phase === 'run' && s.at >= (s.roundAt ?? d.t0) + warmupMs)
  const runsPerHour = slopePerHour(run.map((s) => [s.at, s.runs.completed, s.round ?? 1]))
  const trend = (name, fn, o = {}) => {
    const pts = run.map((s) => [s.at, fn(s), s.round ?? 1]).filter(([, y]) => Number.isFinite(y))
    const slope = slopePerHour(pts)
    const th = thirds(pts.map(([, y]) => y))
    const perRun =
      slope !== null && runsPerHour !== null && runsPerHour > 0
        ? (slope * (o.scale ?? 1)) / runsPerHour
        : null
    const ratio = th.first !== null && th.last !== null && th.first > 0 ? th.last / th.first : null
    let ok = null
    if (pts.length >= 3 && o.perRunMax !== undefined) ok = perRun !== null && perRun <= o.perRunMax
    if (pts.length >= 3 && o.ratioMax !== undefined) ok = ratio !== null && ratio <= o.ratioMax
    return {
      name,
      points: pts.length,
      first: round(th.first, 2),
      last: round(th.last, 2),
      slopePerHour: round(slope, 2),
      perRun: round(perRun, 2),
      perRunUnit: o.unit ?? null,
      lastOverFirst: round(ratio, 3),
      min: pts.length > 0 ? round(Math.min(...pts.map(([, y]) => y)), 2) : null,
      max: pts.length > 0 ? round(Math.max(...pts.map(([, y]) => y)), 2) : null,
      tolerance:
        o.perRunMax !== undefined
          ? `≤ ${o.perRunMax} ${o.unit} per run`
          : o.ratioMax !== undefined
            ? `last/first ≤ ${o.ratioMax}`
            : null,
      ok,
    }
  }
  const KB = { scale: 1024, unit: 'KB' }
  const trends = [
    trend('main JS heap after GC (MB)', (s) => s.main.heapUsedMb, { ...KB, perRunMax: T.mainHeapKbPerRun }),
    trend('main external memory, array buffers included (MB)', (s) => s.main.externalMb, {
      ...KB,
      perRunMax: T.externalKbPerRun,
    }),
    trend('main OS handles', (s) => s.procs?.mainHandles ?? NaN, {
      unit: 'handles',
      perRunMax: T.handlesPerRun,
    }),
    trend('main libuv resources', (s) => s.main.resourceCount, {
      unit: 'resources',
      perRunMax: T.handlesPerRun,
    }),
    trend('renderer JS heap after GC (MB)', (s) => s.renderer.heapUsedMb, {
      ...KB,
      perRunMax: T.rendererHeapKbPerRun,
    }),
    trend('renderer DOM nodes (Dashboard)', (s) => s.renderer.nodes, { ratioMax: T.domThirdsRatio }),
    trend('renderer event listeners (Dashboard)', (s) => s.renderer.listeners, {
      ratioMax: T.domThirdsRatio,
    }),
    trend('renderer OS handles', (s) => s.procs?.rendererHandles ?? NaN, {
      unit: 'handles',
      perRunMax: T.handlesPerRun,
    }),
  ]
  const info = [
    trend('main compiled code after GC (MB)', (s) => s.main.codeMb ?? NaN, KB),
    trend('main RSS (MB)', (s) => s.main.rssMb, KB),
    trend('main working set (MB)', (s) => s.main.wsMb, KB),
    trend('renderer working set (MB)', (s) => s.renderer.wsMb, KB),
    trend('all Electron processes, working set (MB)', (s) => s.app.wsMb, KB),
    trend('home folder (MB)', (s) => s.home.totalMb, KB),
    trend('run folders', (s) => s.home.runDirs, { unit: 'folders' }),
  ]
  const all = d.samples.filter((s) => s.phase === 'run')
  const loopP95 = all.map((s) => s.main.eventLoopP95Ms)
  const windowP95s =
    d.loopWindows.length > 0
      ? d.loopWindows.map((w) => w.p95Ms)
      : all.map((s) => s.logs.windowP95MaxMs).filter((x) => Number.isFinite(x))
  const idleStart = d.samples.find((s) => s.phase === 'idle-start')
  const idleEnd = d.samples.find((s) => s.phase === 'idle-end')
  // One cleared sample at the end, and with --phases one after each phase: the last is judged against the start, and
  // the first against the last says whether what main kept with every run removed levelled off.
  const clearedAll = d.samples.filter((s) => s.phase === 'cleared')
  const cleared = clearedAll.at(-1)
  const clearedFirst = clearedAll[0]
  const clearedRuns =
    cleared !== undefined && clearedFirst !== undefined
      ? cleared.runs.completed - clearedFirst.runs.completed
      : 0
  // The app's data on main's heap (compiled code left out: V8 optimizes functions as they turn hot, a few more each
  // phase, bounded by the code base, not by the runs); samples from before the split use the whole heap.
  const dataMb = (s) => (Number.isFinite(s.main.dataHeapMb) ? s.main.dataHeapMb : s.main.heapUsedMb)
  const clearedKbPerRun =
    clearedAll.length >= 2 && clearedRuns > 0
      ? ((dataMb(cleared) - dataMb(clearedFirst)) * 1024) / clearedRuns
      : null
  const clearedCodeKbPerRun =
    clearedAll.length >= 2 &&
    clearedRuns > 0 &&
    Number.isFinite(cleared.main.codeMb) &&
    Number.isFinite(clearedFirst.main.codeMb)
      ? ((cleared.main.codeMb - clearedFirst.main.codeMb) * 1024) / clearedRuns
      : null
  const orphanSamples = d.samples.filter((s) => (s.procs?.orphans ?? 0) > 0).length
  const kinds = {}
  for (const a of d.anomalies) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1
  const checks = {
    flatMemory: trends.every((t) => t.ok !== false),
    noOrphans:
      orphanSamples === 0 && d.leftAfterQuit.length === 0 && kinds['children-after-drain'] === undefined,
    eventLoopP95: loopP95.length > 0 && loopP95.every((x) => x < T.eventLoopP95Ms),
    noLogErrors: d.logErrorCount === 0,
    noFakeErrors: d.fakeErrorCount === 0,
    allRunsCompleted: d.counts.failed === 0 && d.counts.cancelled === 0 && d.counts.completed > 0,
    noPageErrors: d.pageErrorCount === 0,
    noOtherAnomalies: Object.keys(kinds).every((k) => JUDGED_ELSEWHERE.has(k)),
    // Idle before and after: the same handles (within TOLERANCE.idleHandles) and the same libuv resources.
    idleHandlesReturn:
      idleStart === undefined || idleEnd === undefined
        ? null
        : Math.abs((idleEnd.procs?.mainHandles ?? 0) - (idleStart.procs?.mainHandles ?? 0)) <=
            T.idleHandles &&
          Math.abs((idleEnd.procs?.rendererHandles ?? 0) - (idleStart.procs?.rendererHandles ?? 0)) <=
            T.idleHandles &&
          idleEnd.main.resourceCount <= idleStart.main.resourceCount + 2,
    // Every run removed: main's heap back within TOLERANCE.clearedMainHeapMb of where it was before the first run.
    clearedReturn:
      idleStart === undefined || cleared === undefined
        ? null
        : cleared.main.heapUsedMb - idleStart.main.heapUsedMb <= T.clearedMainHeapMb &&
          Math.abs((cleared.procs?.mainHandles ?? 0) - (idleStart.procs?.mainHandles ?? 0)) <= T.idleHandles,
    // --phases: from the first phase's clear to the last, main's data heap grew at most TOLERANCE.clearedKbPerRun per
    // run in between.
    clearedLevelsOff: clearedKbPerRun === null ? null : clearedKbPerRun <= T.clearedKbPerRun,
  }
  const hours = (d.endAt - d.t0) / HOUR_MS
  const growth = (end, start, fn) => round(fn(end) - fn(start), 2)
  return {
    pass: Object.values(checks).every((v) => v !== false),
    checks,
    tolerance: T,
    options: d.options,
    root: d.root,
    startedAt: new Date(d.t0).toISOString(),
    hours: round(hours, 2),
    warmupMin: d.warmupMin,
    counts: d.counts,
    throughputPerHour: round(d.counts.completed / Math.max(hours, 1e-9)),
    runsPerHourAfterWarmup: round(runsPerHour),
    trends,
    info,
    eventLoop: {
      sampleP95Max: loopP95.length > 0 ? round(Math.max(...loopP95)) : null,
      sampleP95Median: round(median(loopP95)),
      sampleMaxMax: all.length > 0 ? round(Math.max(...all.map((s) => s.main.eventLoopMaxMs))) : null,
      windows60s: d.loopWindows.length,
      window60sP95Max: windowP95s.length > 0 ? round(Math.max(...windowP95s)) : null,
      window60sOver100: windowP95s.filter((x) => x >= 100).length,
    },
    longTasks: {
      total: all.reduce((a, s) => a + s.renderer.longTasks, 0),
      perSampleMedian: median(all.map((s) => s.renderer.longTasks)),
      maxMs: Math.max(0, ...all.map((s) => s.renderer.longTaskMaxMs)),
    },
    idle: {
      start: idleStart !== undefined ? pickIdle(idleStart) : null,
      end: idleEnd !== undefined ? pickIdle(idleEnd) : null,
      // What the session's runs cost once idle (history kept, everything else released), per run folder left.
      growth:
        idleStart !== undefined && idleEnd !== undefined
          ? {
              mainHeapMb: growth(idleEnd, idleStart, (s) => s.main.heapUsedMb),
              rendererHeapMb: growth(idleEnd, idleStart, (s) => s.renderer.heapUsedMb),
              mainHandles: growth(idleEnd, idleStart, (s) => s.procs?.mainHandles ?? NaN),
              rendererHandles: growth(idleEnd, idleStart, (s) => s.procs?.rendererHandles ?? NaN),
              perRunKb: {
                main: round(
                  ((idleEnd.main.heapUsedMb - idleStart.main.heapUsedMb) * 1024) /
                    Math.max(1, idleEnd.home.runDirs),
                ),
                renderer: round(
                  ((idleEnd.renderer.heapUsedMb - idleStart.renderer.heapUsedMb) * 1024) /
                    Math.max(1, idleEnd.home.runDirs),
                ),
              },
            }
          : null,
      cleared: cleared !== undefined ? pickIdle(cleared) : null,
      clearedGrowth:
        idleStart !== undefined && cleared !== undefined
          ? {
              mainHeapMb: growth(cleared, idleStart, (s) => s.main.heapUsedMb),
              mainExternalMb: growth(cleared, idleStart, (s) => s.main.externalMb),
              mainHandles: growth(cleared, idleStart, (s) => s.procs?.mainHandles ?? NaN),
              mainResources: growth(cleared, idleStart, (s) => s.main.resourceCount),
            }
          : null,
      // Main's heap with every run removed, after each phase: what it kept since before the first run.
      clearedSeries: clearedAll.map((s) => ({
        phase: s.round ?? 1,
        atMin: s.min,
        runsCompleted: s.runs.completed,
        mainHeapMb: s.main.heapUsedMb,
        sinceStartMb: idleStart !== undefined ? growth(s, idleStart, (x) => x.main.heapUsedMb) : null,
        codeMb: s.main.codeMb ?? null,
        dataHeapMb: s.main.dataHeapMb ?? null,
        mainHandles: s.procs?.mainHandles ?? null,
      })),
      clearedKbPerRun: round(clearedKbPerRun, 2),
      clearedCodeKbPerRun: round(clearedCodeKbPerRun, 2),
      clearedRunsBetween: clearedRuns,
    },
    processes: {
      orphanSamples,
      leftAfterQuit: d.leftAfterQuit,
      maxChildren: Math.max(0, ...all.map((s) => s.procs?.children ?? 0)),
      maxLiveVendorProcs: Math.max(0, ...all.map((s) => s.runs.liveVendorProcs)),
    },
    logs: {
      errors: d.logErrors.slice(0, 50),
      errorCount: d.logErrorCount,
      warns: d.logWarns,
      warnKinds: d.logWarnKinds ?? {},
      stderr: d.stderr ?? null,
    },
    fakeErrors: d.fakeErrors.slice(0, 20),
    pageErrors: d.pageErrors.slice(0, 20),
    anomalyKinds: kinds,
    anomalies: d.anomalies.slice(0, 200),
    heapGrowth: d.heapGrowth ?? {},
    files: d.files,
  }
}

/** The summary as Markdown (written next to the samples, and printed). */
function summaryMarkdown(sum) {
  const yes = (b) => (b === null ? 'n/a' : b ? 'pass' : 'FAIL')
  const o = sum.options
  const lines = []
  lines.push(`# Dim Factory soak, ${sum.startedAt}`)
  lines.push('')
  lines.push(
    `${o.runs} folders, ${sum.hours} h (warm-up ${round(sum.warmupMin)} min), seed ${o.seed}. ` +
      `Result: **${sum.pass ? 'PASS' : 'FAIL'}**.`,
  )
  lines.push('')
  const c = sum.counts
  lines.push(
    `Runs: ${c.started} started, ${c.completed} completed, ${c.failed} failed, ${c.cancelled} cancelled ` +
      `(${sum.throughputPerHour} completed an hour; ${sum.runsPerHourAfterWarmup} after the warm-up)` +
      `${c.outcomes !== undefined ? `; outcomes ${JSON.stringify(c.outcomes)}` : ''}; ${c.asksAnswered} asks ` +
      `answered, ${c.cardsResolved} cards resolved` +
      `${c.retentionPasses !== undefined ? `, ${c.retentionPasses} retention passes, ${c.navigations} view changes` : ''}.`,
  )
  lines.push('')
  lines.push('## Checks')
  lines.push('')
  for (const [k, v] of Object.entries(sum.checks)) lines.push(`- ${k}: ${yes(v)}`)
  lines.push('')
  lines.push('## Trends after the warm-up')
  lines.push('')
  lines.push(
    '| Series | First third | Last third | Slope / h | Per run | Last / first | Min | Max | Tolerance | Check |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const t of [...sum.trends, ...sum.info])
    lines.push(
      `| ${t.name} | ${t.first} | ${t.last} | ${t.slopePerHour} | ` +
        `${t.perRun !== null ? `${t.perRun} ${t.perRunUnit ?? ''}`.trim() : '-'} | ${t.lastOverFirst ?? '-'} | ` +
        `${t.min} | ${t.max} | ${t.tolerance ?? '-'} | ${yes(t.ok)} |`,
    )
  lines.push('')
  lines.push('## Event loop, long tasks, processes')
  lines.push('')
  lines.push(`- Main event loop: ${JSON.stringify(sum.eventLoop)}`)
  lines.push(`- Renderer long tasks: ${JSON.stringify(sum.longTasks)}`)
  lines.push(`- Processes: ${JSON.stringify(sum.processes)}`)
  lines.push(`- Idle before the runs: ${JSON.stringify(sum.idle.start)}`)
  lines.push(`- Idle after the drain: ${JSON.stringify(sum.idle.end)}`)
  lines.push(`- Idle growth (end minus start): ${JSON.stringify(sum.idle.growth)}`)
  lines.push(`- Every run removed: ${JSON.stringify(sum.idle.cleared ?? null)}`)
  lines.push(
    `- Growth with every run removed (cleared minus start): ${JSON.stringify(sum.idle.clearedGrowth ?? null)}`,
  )
  const series = sum.idle.clearedSeries ?? []
  if (series.length > 1) {
    lines.push(
      `- Every run removed, after each phase (main heap, MB kept since before the first run): ` +
        series
          .map(
            (c) =>
              `phase ${c.phase}, ${c.runsCompleted} runs: ${c.mainHeapMb} MB (+${c.sinceStartMb}; code ` +
              `${c.codeMb ?? '-'}, data ${c.dataHeapMb ?? '-'})`,
          )
          .join('; ') +
        `. From the first to the last, the data heap: ${sum.idle.clearedKbPerRun} KB per run over ` +
        `${sum.idle.clearedRunsBetween} runs (tolerance ${sum.tolerance.clearedKbPerRun} KB); compiled code: ` +
        `${sum.idle.clearedCodeKbPerRun ?? '-'} KB per run (not judged).`,
    )
  }
  lines.push('')
  lines.push('## Logs and anomalies')
  lines.push('')
  lines.push(
    `- App log: ${sum.logs.errorCount} error lines, ${sum.logs.warns} warn lines ${JSON.stringify(sum.logs.warnKinds ?? {})}`,
  )
  for (const e of sum.logs.errors.slice(0, 15)) lines.push(`  - ${e.rec}`)
  const se = sum.logs.stderr
  if (se !== null && se !== undefined) {
    lines.push(
      `- App stderr: ${se.nodeWarnings.length} Node warnings, ${se.chromiumLines} Chromium log lines, ${se.otherLines} other lines`,
    )
    for (const w of se.nodeWarnings.slice(0, 10)) lines.push(`  - ${w.atMin} min: ${w.line}`)
    for (const l of se.sample.slice(0, 5)) lines.push(`  - sample: ${l}`)
  }
  lines.push(`- Fake CLI errors: ${sum.fakeErrors.length}`)
  for (const e of sum.fakeErrors.slice(0, 5)) lines.push(`  - ${e.rec}`)
  lines.push(`- Page errors: ${sum.pageErrors.length}`)
  for (const e of sum.pageErrors.slice(0, 5)) lines.push(`  - ${e.atMin} min: ${e.text}`)
  lines.push(`- Anomalies by kind: ${JSON.stringify(sum.anomalyKinds)}`)
  for (const a of sum.anomalies.slice(0, 40))
    lines.push(
      `  - ${a.atMin} min ${a.kind}: ${String(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail)).slice(0, 300)}`,
    )
  lines.push('')
  for (const [proc, g] of Object.entries(sum.heapGrowth ?? {})) {
    lines.push('')
    if (g.error !== undefined) {
      lines.push(`## Heap growth (${proc}): ${g.error}`)
      continue
    }
    lines.push(
      `## Heap growth by constructor (${proc}, ${g.from.atMin} to ${g.to.atMin} min, ${g.runs} runs)`,
    )
    lines.push('')
    lines.push('| Type and name | Objects | Self size (KB) | Per run (bytes) |')
    lines.push('|---|---|---|---|')
    for (const r of g.top)
      lines.push(
        `| ${r.key.replace(/\|/g, '/')} | ${r.count} | ${round(r.size / 1024)} | ${g.runs > 0 ? Math.round(r.size / g.runs) : '-'} |`,
      )
    if (g.code === undefined) continue
    lines.push('')
    lines.push(`Compiled code by name (${proc}):`)
    lines.push('')
    lines.push('| Name | Objects | Self size (KB) | Per run (bytes) |')
    lines.push('|---|---|---|---|')
    for (const r of g.code)
      lines.push(
        `| ${r.key.replace(/^code ?/, '').replace(/\|/g, '/') || '(no name)'} | ${r.count} | ${round(r.size / 1024)} | ${g.runs > 0 ? Math.round(r.size / g.runs) : '-'} |`,
      )
  }
  lines.push('')
  lines.push(`Files: ${Object.values(sum.files).join(', ')}`)
  return `${lines.join('\n')}\n`
}

/**
 * --summarize <soak-….samples.jsonl>: the summary again from a soak's samples (and the anomalies in its .log), with
 * this script's analysis; written as <base>.resummary.md / .json. Counts the samples do not carry (outcomes, the app
 * log's error lines themselves) are left out.
 */
function resummarize(file, o) {
  const samples = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
  if (samples.length === 0) throw new Error(`${file} has no samples`)
  const base = file.replace(/\.samples\.jsonl$/, '')
  const anomalies = []
  if (existsSync(`${base}.log`)) {
    for (const line of readFileSync(`${base}.log`, 'utf8').split('\n')) {
      const m = /\[soak\s+([\d.]+) min\] ANOMALY ([\w-]+): (.*)$/.exec(line)
      if (m !== null) anomalies.push({ atMin: Number(m[1]), kind: m[2], detail: m[3] })
    }
  }
  const last = samples.at(-1)
  const t0 = samples[0].at - samples[0].min * 60_000
  const counts = {
    started: last.runs.started,
    completed: last.runs.completed,
    failed: last.runs.failed,
    cancelled: last.runs.cancelled,
    asksAnswered: last.runs.asksAnswered,
    cardsResolved: last.runs.cardsResolved,
  }
  const sum = analyze({
    samples,
    t0,
    endAt: last.at,
    warmupMin: o.warmupMin,
    options: { runs: o.runs, seed: '(from the samples)', resummarized: file },
    root: null,
    counts,
    loopWindows: [],
    logErrors: [],
    logErrorCount: last.logs.errors,
    logWarns: last.logs.warns,
    fakeErrors: [],
    fakeErrorCount: last.fakeErrors,
    pageErrors: [],
    pageErrorCount: last.pageErrors,
    anomalies,
    leftAfterQuit: anomalies.filter((a) => a.kind === 'left-after-quit'),
    files: { samples: file, summary: `${base}.resummary.md`, summaryJson: `${base}.resummary.json` },
  })
  writeFileSync(`${base}.resummary.json`, `${JSON.stringify(sum, null, 2)}\n`)
  const md = summaryMarkdown(sum)
  writeFileSync(`${base}.resummary.md`, md)
  process.stdout.write(md)
  return sum
}

/**
 * A heap snapshot's self size and object count by (type, name); strings, code and hidden objects by type only, code by
 * name too with `codeNames`, and only the nodes of one type with `only`.
 */
function heapAggregate(file, { codeNames = false, only } = {}) {
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  const meta = snap.snapshot.meta
  const fields = meta.node_fields
  const types = meta.node_types[0]
  const n = fields.length
  const iType = fields.indexOf('type')
  const iName = fields.indexOf('name')
  const iSize = fields.indexOf('self_size')
  const out = new Map()
  for (let i = 0; i < snap.nodes.length; i += n) {
    const type = types[snap.nodes[i + iType]]
    if (only !== undefined && type !== only) continue
    let name = snap.strings[snap.nodes[i + iName]] ?? ''
    if (/string/.test(type) || (type === 'code' && !codeNames) || type === 'hidden' || type === 'number')
      name = ''
    const key = `${type} ${name.slice(0, 60)}`.trim()
    const e = out.get(key) ?? { count: 0, size: 0 }
    e.count++
    e.size += snap.nodes[i + iSize]
    out.set(key, e)
  }
  return out
}

/** The `top` groups whose self size grew most from snapshot `a` to `b` (`opts` as for heapAggregate). */
function heapDiff(a, b, top, opts = {}) {
  const A = heapAggregate(a, opts)
  const B = heapAggregate(b, opts)
  const rows = []
  for (const [key, e] of B) {
    const p = A.get(key) ?? { count: 0, size: 0 }
    rows.push({ key, count: e.count - p.count, size: e.size - p.size })
  }
  for (const [key, p] of A) if (!B.has(key)) rows.push({ key, count: -p.count, size: -p.size })
  return rows.sort((x, y) => y.size - x.size).slice(0, top)
}

function pickIdle(s) {
  return {
    mainHeapMb: s.main.heapUsedMb,
    mainExternalMb: s.main.externalMb,
    mainRssMb: s.main.rssMb,
    mainHandles: s.procs?.mainHandles ?? null,
    mainResources: s.main.resources,
    rendererHeapMb: s.renderer.heapUsedMb,
    rendererNodes: s.renderer.nodes,
    rendererListeners: s.renderer.listeners,
    rendererHandles: s.procs?.rendererHandles ?? null,
    children: s.procs?.byName ?? null,
    runDirs: s.home.runDirs,
    homeMb: s.home.totalMb,
  }
}

function describe(s) {
  const steps = s.steps.map(
    (x) => `${x.key}:${x.status}${x.failureCategory !== undefined ? `(${x.failureCategory})` : ''}`,
  )
  const failure = s.failure !== undefined ? ` failure ${s.failure.step}:${s.failure.category}` : ''
  return `#${s.displayNo} ${s.runId} ${s.profile} ${s.status}/${s.phase} outcome ${s.outcome ?? '-'}${failure} steps ${steps.join(' ')}`
}

async function countDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}

/** Kill one process this script started (a tree for the app). */
function killPid(pid, tree) {
  if (pid === undefined || pid === null) return
  if (IS_WIN) {
    spawnSync('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

// ---- main ---------------------------------------------------------------------------------------------------------

let soak
try {
  const o = parseArgs(process.argv.slice(2))
  if (o.summarize !== undefined) process.exit(resummarize(o.summarize, o).pass ? 0 : 1)
  soak = new Soak(o)
} catch (err) {
  process.stderr.write(`soak: ${err.message}\n`)
  process.exit(2)
}
let code
try {
  await soak.run()
  const sum = soak.summarize()
  soak.writeSummary(sum)
  code = sum.pass ? 0 : 1
} catch (err) {
  soak.log(`setup or run failed: ${err.stack ?? err.message}`)
  try {
    await soak.quit()
    if (soak.samples.length > 0) soak.writeSummary(soak.summarize())
  } catch (e) {
    soak.log(`could not finish: ${e.message}`)
  }
  code = 2
} finally {
  soak.cleanup()
}
process.exit(code)
