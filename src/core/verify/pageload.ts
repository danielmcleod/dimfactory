// Dim Factory's own "page loads without console errors" check as a Verify command (`dimf:pageload <page>`, see
// shared/pageload.ts). Like the play-test it is never spawned and needs no trust grant: the page's folder is served on
// a private read-only loopback server and the app opens the page in its hidden, sandboxed preview (no Node, no
// internet, no permissions). It fails when the page is not there, does not load, logs a console error or fails to
// load one of its own files; requests to other computers are blocked and only noted in the log. Without the app (the
// command-line tool) it reports "not checked here", which is not a finding.
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { PageloadReport } from '../../shared/pageload.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'

/** What the round asks the app to do: open `page` in `folder` (served read-only) and say what it saw. */
export interface PageloadRequest {
  /** The folder served (the page's own folder: dist/ for a built site). */
  folder: string
  /** The page's file name in it. */
  page: string
  signal: AbortSignal
}

export type PageloadOutcome = { kind: 'report'; report: PageloadReport } | { kind: 'skipped'; reason: string }

export type PageChecker = (r: PageloadRequest) => Promise<PageloadOutcome>

/** The longest the whole check may take. */
export const PAGELOAD_TIMEOUT_MS = 60_000

export const PAGELOAD_NOT_HERE =
  'Not checked here: the page-load check needs the Dim Factory app, which opens the page in its sandboxed preview'

const MESSAGE_MAX = 300
const cut = (s: string): string => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}…` : s)

/** The page an argv names, inside `cwd` (null: none, or one outside the folder). */
export function pageOf(argv: readonly string[], cwd: string): { abs: string; rel: string } | null {
  const rel = (argv[1] ?? 'index.html').replace(/\\/g, '/')
  if (rel === '' || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) return null
  const abs = resolve(cwd, ...rel.split('/'))
  const back = relative(resolve(cwd), abs)
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return null
  return { abs, rel }
}

/** Why a page that is not there is missing, in plain words (a build folder's page: the build did not make it). */
export function missingPageReason(rel: string): string {
  const top = rel.split('/')[0] ?? ''
  if (rel.includes('/') && ['dist', 'build', 'out'].includes(top))
    return `There is no ${rel}: the build did not make the page (run the build first)`
  return `There is no ${rel} to open`
}

/** The check's log: whether it loaded, then each console error, failed load and blocked request. */
export function pageloadLogLines(rel: string, r: PageloadReport): string[] {
  const out: string[] = []
  if (r.error !== undefined) out.push(`The page could not be checked: ${cut(r.error)}`)
  out.push(r.loaded ? `loaded ${rel}` : `${rel} did not load`)
  for (const e of r.consoleErrors.slice(0, 10))
    out.push(
      `console error: ${cut(e.message)}${e.source !== undefined ? ` (${e.source}${e.line !== undefined ? `:${e.line}` : ''})` : ''}`,
    )
  for (const f of r.failedLoads.slice(0, 10)) out.push(`failed load: ${cut(f.url)} (${f.error})`)
  for (const b of r.blocked.slice(0, 10)) out.push(`blocked (no internet for checks): ${cut(b.url)}`)
  return out
}

/** Pass, or fail with the reason: it did not load, or it logged console errors or failed to load its own files. */
export function pageloadVerdict(r: PageloadReport): { status: 'pass' | 'fail'; reason?: string } {
  if (!r.loaded) return { status: 'fail', reason: r.error ?? 'The page did not load' }
  const e = r.consoleErrors.length
  const f = r.failedLoads.length
  if (e + f === 0) return { status: 'pass' }
  const parts = [
    ...(e > 0 ? [`${e} console error${e === 1 ? '' : 's'}`] : []),
    ...(f > 0 ? [`${f} file${f === 1 ? '' : 's'} that did not load`] : []),
  ]
  return { status: 'fail', reason: `The page loaded with ${parts.join(' and ')}` }
}

export interface RunPageloadOptions {
  name: string
  argv: string[]
  /** The command's folder. */
  cwd: string
  /** The command's log, already holding its header line. */
  write: (text: string) => void
  checker: PageChecker | undefined
  signal: AbortSignal | undefined
  now?: () => number
}

/** Run the built-in page-load check (see the header). Never throws. */
export async function runPageload(o: RunPageloadOptions): Promise<VerifyCommandResult> {
  const now = o.now ?? Date.now
  const started = now()
  const base = { name: o.name, argv: [...o.argv], exitCode: null, logPath: '' }
  const result = (
    status: VerifyCommandResult['status'],
    extra: Partial<VerifyCommandResult> = {},
  ): VerifyCommandResult => ({ ...base, status, durationMs: now() - started, excerpt: '', ...extra })
  if (o.checker === undefined) return result('skipped', { reason: PAGELOAD_NOT_HERE })
  const page = pageOf(o.argv, o.cwd)
  if (page === null) {
    o.write('The page must be a file inside the project.\n')
    return result('fail', { reason: 'The page must be a file inside the project' })
  }
  const isFile = await stat(page.abs).then(
    (s) => s.isFile(),
    () => false,
  )
  if (!isFile) {
    const reason = missingPageReason(page.rel)
    o.write(`${reason}\n`)
    return result('fail', { reason, excerpt: reason })
  }
  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  if (o.signal?.aborted === true) ac.abort()
  const timer = setTimeout(() => ac.abort(), PAGELOAD_TIMEOUT_MS)
  let outcome: PageloadOutcome
  try {
    outcome = await o.checker({ folder: dirname(page.abs), page: basename(page.abs), signal: ac.signal })
  } catch (err) {
    outcome = {
      kind: 'report',
      report: {
        url: '',
        loaded: false,
        consoleErrors: [],
        failedLoads: [],
        blocked: [],
        durationMs: now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
    }
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
  if (o.signal?.aborted === true) return result('skipped', { reason: 'Stopped before it finished' })
  if (outcome.kind === 'skipped') return result('skipped', { reason: outcome.reason })
  const lines = pageloadLogLines(page.rel, outcome.report)
  o.write(lines.map((l) => `${l}\n`).join(''))
  const verdict = pageloadVerdict(outcome.report)
  if (verdict.status === 'pass') return result('pass')
  const excerpt = lines.filter((l) => !l.startsWith('loaded ')).join('\n')
  return result('fail', {
    excerpt: excerpt.length > 4000 ? `${excerpt.slice(0, 4000)}…` : excerpt,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
  })
}
