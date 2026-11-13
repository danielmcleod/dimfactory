// Settings → Diagnostics, Copy diagnostics with raw lines opt-in (IPC diagnostics.build /
// copy / save): a plain-text bundle of versions, paths, platform, vendor probe summaries, config validity, storage
// sizes, recent runs and recent log lines, redacted with shared/redact.ts (counts per rule in `redactions`). Raw
// vendor lines only when the request opts in. Never credentials, account details or environment values: vendors
// show their health, version, route and check titles; config shows its issues, not its text. Electron-free: the
// clipboard, the save dialog and the file write are injected (index.ts passes Electron's).
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Core } from '@core/app-core.ts'
import type {
  AppInfo,
  ConfigReadResult,
  DiagnosticsBundle,
  DiagnosticsRequest,
  StorageUsage,
} from '@shared/ipc.ts'
import { redactJsonValue, redactText } from '@shared/redact.ts'
import type { RedactOptions } from '@shared/redact.ts'
import type { RunSnapshot, RunSummary } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'

/** Recent lines of `logs/main.log` in every bundle. */
export const DIAGNOSTICS_LOG_LINES = 100
/** Raw vendor lines per file when the request opts in. */
export const DIAGNOSTICS_RAW_LINES = 50
/** Bytes read from the end of a log or raw file. */
const TAIL_BYTES = 256 * 1024
const RECENT_RUNS = 5

export interface DiagnosticsSources {
  core: Pick<Core, 'invoke' | 'paths'>
  appInfo(): Promise<AppInfo>
  now(): number
  /** The machine facts to redact (OS home, user and host names). */
  redact: Omit<RedactOptions, 'mode'>
}

export interface DiagnosticsDeps extends DiagnosticsSources {
  /** Electron `clipboard.writeText` (a promise since Electron 44). */
  writeClipboard(text: string): Promise<void> | void
  /** The native save dialog: the chosen path, or null when cancelled. */
  chooseSavePath(defaultName: string): Promise<string | null>
  /** DIM_FACTORY_E2E_DIAGNOSTICS_PATH under DIM_FACTORY_E2E=1: save here without a dialog. */
  e2eSavePath?: string
  writeFile?: (path: string, text: string) => Promise<void>
}

export interface Diagnostics {
  build(req: DiagnosticsRequest): Promise<DiagnosticsBundle>
  copy(req: DiagnosticsRequest): Promise<void>
  save(req: DiagnosticsRequest): Promise<{ path: string } | null>
}

/** This machine's home folder, user and host names: what a bundle replaces with `~`, `<user>` and `<host>`. */
export function machineFacts(): Omit<RedactOptions, 'mode'> {
  const out: Omit<RedactOptions, 'mode'> = {}
  try {
    out.home = homedir()
  } catch {
    // unknown home
  }
  try {
    out.username = userInfo().username
  } catch {
    // no passwd entry
  }
  try {
    out.hostname = hostname()
  } catch {
    // unknown host
  }
  return out
}

/** Keys whose values are an environment (a vendor's `env`, a spawn's environment): never in a bundle. */
const ENV_KEY = /^(env|environment|extraEnv|processEnv)$/i

function bump(counts: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) counts[k] = (counts[k] ?? 0) + v
}

/** Environment objects replaced by a marker (counted as `env`). */
function withoutEnv(v: unknown, counts: Record<string, number>): unknown {
  if (Array.isArray(v)) return v.map((x) => withoutEnv(x, counts))
  if (v === null || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if (ENV_KEY.test(k) && child !== null && typeof child === 'object') {
      counts['env'] = (counts['env'] ?? 0) + 1
      out[k] = '[env omitted]'
    } else out[k] = withoutEnv(child, counts)
  }
  return out
}

/** One log or vendor line, redacted: JSON goes through the key rules (secrets, accounts, env), text through the rest. */
export function redactDiagnosticLine(
  line: string,
  opts: Omit<RedactOptions, 'mode'>,
  counts: Record<string, number>,
): string {
  const t = line.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(t)
      const r = redactJsonValue(withoutEnv(parsed, counts), { ...opts, mode: 'diagnostics' })
      bump(counts, r.counts)
      return JSON.stringify(r.value)
    } catch {
      // not JSON
    }
  }
  const r = redactText(line, { ...opts, mode: 'diagnostics' })
  bump(counts, r.counts)
  return r.text
}

/** The last `n` non-empty lines of a file (its last TAIL_BYTES); [] when it cannot be read. */
export async function tailLines(file: string, n: number): Promise<string[]> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (len < size) lines.shift()
    return lines.filter((l) => l.trim() !== '').slice(-n)
  } catch {
    return []
  } finally {
    await fh.close()
  }
}

export function formatBytes(n: number | null): string {
  if (n === null) return 'unknown'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(1)} ${units[u]}`
}

type Invoke = Core['invoke']

async function tryInvoke<T>(p: ReturnType<Invoke>): Promise<T | string> {
  const r = await p
  return r.ok ? (r.value as T) : `unavailable (${r.error.code}: ${r.error.message})`
}

function vendorLines(vendors: ProbeView[] | string): string[] {
  if (typeof vendors === 'string') return [`  ${vendors}`]
  const out: string[] = []
  for (const v of vendors) {
    const facts = [v.healthDetail]
    if (v.probe?.version !== undefined) facts.push(`version ${v.probe.version}`)
    if (v.probe?.route !== undefined) facts.push(`route ${v.probe.route}`)
    if (v.versionFloor !== null) facts.push(`floor ${v.versionFloor}`)
    if (v.testedUpTo !== null) facts.push(`tested up to ${v.testedUpTo}`)
    out.push(`  ${v.vendor} (${v.displayName}): ${v.health} · ${facts.join(' · ')}`)
    for (const c of v.probe?.checks ?? []) out.push(`    ${c.status} ${c.id}: ${c.title}`)
  }
  return out
}

function configLines(label: string, read: ConfigReadResult | string): string[] {
  if (typeof read === 'string') return [`  ${label}: ${read}`]
  const errors = read.issues.filter((i) => i.severity === 'error').length
  const state = !read.exists
    ? 'no file (defaults)'
    : errors === 0
      ? 'valid'
      : `${errors} error${errors === 1 ? '' : 's'}`
  const out = [
    `  ${label} ${read.path}: ${state} · ${read.backups.length} backup${read.backups.length === 1 ? '' : 's'}`,
  ]
  for (const i of read.issues) out.push(`    ${i.severity} ${i.file}:${i.line}:${i.col} ${i.message}`)
  return out
}

function storageLines(u: StorageUsage | string): string[] {
  if (typeof u === 'string') return [`  ${u}`]
  const out = [
    `  Total ${formatBytes(u.totalBytes)} · free on disk ${formatBytes(u.freeBytes)}`,
    `  Runs: ${u.runs.count} (${formatBytes(u.runs.bytes)}) · Snapshots: ${u.shadows.length} folders (${formatBytes(
      u.shadows.reduce((n, s) => n + s.bytes, 0),
    )}) · Worktrees: ${u.worktrees.count} (${formatBytes(u.worktrees.bytes)})`,
    `  Catalog ${formatBytes(u.catalogBytes)} · Logs ${formatBytes(u.logsBytes)}`,
  ]
  for (const s of u.shadows) {
    out.push(`  Snapshots ${s.folderKey}: ${s.path ?? 'folder unknown'} (${formatBytes(s.bytes)})`)
  }
  return out
}

function runLine(s: RunSummary): string {
  const steps = s.steps
    .map(
      (st) => `${st.key} ${st.status}${st.failureCategory !== undefined ? ` (${st.failureCategory})` : ''}`,
    )
    .join(', ')
  const outcome = s.outcome !== undefined ? ` · ${s.outcome}` : ''
  const failure = s.failure !== undefined ? ` · failed at ${s.failure.step}: ${s.failure.category}` : ''
  return `  #${s.displayNo} ${s.runId} · ${s.status} · ${s.phase}${outcome}${failure} · profile ${s.profile}${s.auto ? ' · auto' : ''} · ${steps}`
}

/** The redacted raw vendor lines of a run (opt-in): the last lines of each `raw/*.ndjson`. */
async function rawLines(
  runDir: string,
  opts: Omit<RedactOptions, 'mode'>,
  counts: Record<string, number>,
): Promise<string[]> {
  const rawDir = join(runDir, 'raw')
  const names = (await readdir(rawDir).catch(() => [] as string[]))
    .filter((n) => n.endsWith('.ndjson'))
    .sort()
  const out: string[] = []
  for (const name of names) {
    out.push(`  ${name}`)
    for (const l of await tailLines(join(rawDir, name), DIAGNOSTICS_RAW_LINES)) {
      // A raw record is {t, dir, line}: the vendor's own line is redacted as what it is (JSON keys included).
      let rec: { dir?: unknown; line?: unknown } | undefined
      try {
        rec = JSON.parse(l) as { dir?: unknown; line?: unknown }
      } catch {
        rec = undefined
      }
      if (rec !== undefined && typeof rec.line === 'string') {
        const dir = typeof rec.dir === 'string' ? rec.dir : '?'
        out.push(`    ${dir} ${redactDiagnosticLine(rec.line, opts, counts)}`)
      } else out.push(`    ${redactDiagnosticLine(l, opts, counts)}`)
    }
  }
  if (names.length === 0) out.push('  No raw vendor lines were recorded for this run.')
  return out
}

/** `diagnostics.build`: the bundle text and what redaction replaced. */
export async function buildDiagnostics(
  src: DiagnosticsSources,
  req: DiagnosticsRequest = {},
): Promise<DiagnosticsBundle> {
  const invoke: Invoke = src.core.invoke.bind(src.core)
  const counts: Record<string, number> = {}
  const [info, vendors, userConfig, usage, recent] = await Promise.all([
    src.appInfo(),
    tryInvoke<ProbeView[]>(invoke('vendors.list')),
    tryInvoke<ConfigReadResult>(invoke('config.read', { scope: 'user' })),
    tryInvoke<StorageUsage>(invoke('storage.usage')),
    tryInvoke<{ items: RunSummary[] }>(invoke('runs.list', { limit: RECENT_RUNS })),
  ])
  const runId = req.runId ?? (typeof recent === 'string' ? undefined : recent.items[0]?.runId)
  const run =
    req.runId !== undefined
      ? await tryInvoke<RunSnapshot>(invoke('runs.get', { runId: req.runId }))
      : undefined
  const projectConfig =
    run !== undefined && typeof run !== 'string'
      ? await tryInvoke<ConfigReadResult>(
          invoke('config.read', { scope: 'project', folder: run.summary.folder }),
        )
      : undefined

  const lines: string[] = [
    'Dim Factory diagnostics',
    `Created ${new Date(src.now()).toISOString()}`,
    '',
    'Versions',
    `  ${info.name} ${info.version} · packaged: ${info.packaged ? 'yes' : 'no'}${info.e2e ? ' · E2E' : ''}`,
    `  Electron ${info.versions.electron ?? 'none'} · Chrome ${info.versions.chrome ?? 'none'} · Node ${info.versions.node}`,
    `  git ${info.git !== null ? `${info.git.version} (${info.git.path})` : 'not found'}`,
    `  Platform ${info.platform} ${info.arch} · IPC protocol ${info.ipcProtocol}`,
    ...(info.notifications !== null
      ? [
          `  Windows notifications: AUMID ${info.notifications.aumid ? 'set' : 'missing'} · CLSID ${info.notifications.clsid ? 'set' : 'missing'}`,
        ]
      : []),
    '',
    'Paths',
    `  Home: ${info.home}`,
    `  Logs: ${info.logsDir}`,
    '',
    'Vendors',
    ...vendorLines(vendors),
    '',
    'Config',
    ...configLines('User file', userConfig),
    ...(projectConfig !== undefined ? configLines("The run's project file", projectConfig) : []),
    '',
    'Storage',
    ...storageLines(usage),
    '',
    'Recent runs',
    ...(typeof recent === 'string'
      ? [`  ${recent}`]
      : recent.items.length === 0
        ? ['  None']
        : recent.items.map(runLine)),
  ]
  if (run !== undefined) {
    lines.push('', `Run ${req.runId ?? ''}`)
    if (typeof run === 'string') lines.push(`  ${run}`)
    else {
      lines.push(runLine(run.summary))
      for (const note of run.notes) lines.push(`  Note: ${note}`)
    }
  }
  lines.push('', `Recent log lines (main.log, last ${DIAGNOSTICS_LOG_LINES})`)
  const logs = await tailLines(src.core.paths.log('main'), DIAGNOSTICS_LOG_LINES)
  if (logs.length === 0) lines.push('  None')
  for (const l of logs) lines.push(`  ${redactDiagnosticLine(l, src.redact, counts)}`)
  if (req.includeRaw === true) {
    lines.push('', 'Raw vendor lines (included on request)')
    if (runId === undefined) lines.push('  No run to read them from.')
    else {
      lines.push(`  Run ${runId}`)
      lines.push(...(await rawLines(src.core.paths.run(runId).dir, src.redact, counts)))
    }
  }
  // Everything else (paths, notes, issues) goes through the text rules once more, as one text.
  const r = redactText(`${lines.join('\n')}\n`, { ...src.redact, mode: 'diagnostics' })
  bump(counts, r.counts)
  return { text: r.text, redactions: counts }
}

const fileStamp = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, '-')

/** diagnostics.build / copy / save over the host's clipboard and save dialog. */
export function createDiagnostics(d: DiagnosticsDeps): Diagnostics {
  const write = d.writeFile ?? ((p: string, text: string) => writeFile(p, text, { encoding: 'utf8' }))
  return {
    build: (req) => buildDiagnostics(d, req),
    copy: async (req) => {
      const b = await buildDiagnostics(d, req)
      await d.writeClipboard(b.text)
    },
    save: async (req) => {
      const b = await buildDiagnostics(d, req)
      const target =
        d.e2eSavePath ?? (await d.chooseSavePath(`dim-factory-diagnostics-${fileStamp(d.now())}.txt`))
      if (target === null) return null
      await write(target, b.text)
      return { path: target }
    },
  }
}

/** True when `p` is an existing file (tests). */
export async function isFile(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  )
}

/** Read a saved bundle (tests). */
export function readBundle(p: string): Promise<string> {
  return readFile(p, 'utf8')
}
