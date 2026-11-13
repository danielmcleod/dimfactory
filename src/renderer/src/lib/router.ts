// Hash router with deep links (e.g. `#/settings/vendors/codex?field=path`).
//   #/                     dashboard
//   #/runs                 runs history
//   #/runs/:id[/:tab]      run view, tab ∈ flow | diff | log | config (default flow)
//   #/plops                Plops (AI usage by vendor and model)
//   #/settings[/:section[/…]]
//   #/preview[?folder=…]   Run it (Run & Preview on demand for a folder)
//   #/deploy[?folder=…]    Deploy (the Deploy helper on demand for a folder)
//   #/queue                Queue (the factory's task queues, the daily report, project memory)
//   #/easy[/new|projects|settings]   Easy mode: home (the idea box), the confirm screen, the projects, its settings
//   #/easy/runs/:id        Easy mode's view of a run (milestones, then the Done screen)
//   #/easy/two/:id         Easy mode's view of two versions of one idea (a match): both builds, then keep one
// Every route may carry a query string after `?`.
import { useSyncExternalStore } from 'react'

export const RUN_TABS = ['flow', 'diff', 'log', 'config'] as const
export type RunTab = (typeof RUN_TABS)[number]

export type Query = Readonly<Record<string, string>>

/** Easy mode's pages. */
export const EASY_PAGES = ['home', 'new', 'projects', 'settings', 'existing', 'overnight'] as const
export type EasyPage = (typeof EASY_PAGES)[number]
const isEasyPage = (v: string): v is EasyPage => (EASY_PAGES as readonly string[]).includes(v)

export type Route =
  | { name: 'dashboard'; query: Query }
  | { name: 'runs'; query: Query }
  | { name: 'run'; runId: string; tab: RunTab; query: Query }
  /** A match: two runs of one task, side by side (#/matches/<matchId>). */
  | { name: 'match'; matchId: string; query: Query }
  /** Replay a run that ended against another builder (#/rematch/<runId>). */
  | { name: 'rematch'; runId: string; query: Query }
  | { name: 'plops'; query: Query }
  /** `subpath`: segments after the section, e.g. ['codex'] for #/settings/vendors/codex. */
  | { name: 'settings'; section?: string; subpath: string[]; query: Query }
  | { name: 'preview'; query: Query }
  | { name: 'deploy'; query: Query }
  | { name: 'queue'; query: Query }
  | { name: 'easy'; page: EasyPage; query: Query }
  | { name: 'easyRun'; runId: string; query: Query }
  /** Two versions of one idea, made side by side (#/easy/two/<matchId>). */
  | { name: 'easyTwo'; matchId: string; query: Query }
  | { name: 'notFound'; path: string; query: Query }

export type RouteName = Route['name']

/** What `href`/`navigate` accept: a route without its query, plus an optional query. */
export type RouteTarget =
  | { name: 'dashboard'; query?: Record<string, string> }
  | { name: 'runs'; query?: Record<string, string> }
  | { name: 'run'; runId: string; tab?: RunTab; query?: Record<string, string> }
  | { name: 'match'; matchId: string; query?: Record<string, string> }
  | { name: 'rematch'; runId: string; query?: Record<string, string> }
  | { name: 'plops'; query?: Record<string, string> }
  | { name: 'settings'; section?: string; subpath?: string[]; query?: Record<string, string> }
  | { name: 'preview'; query?: Record<string, string> }
  | { name: 'deploy'; query?: Record<string, string> }
  | { name: 'queue'; query?: Record<string, string> }
  | { name: 'easy'; page?: EasyPage; query?: Record<string, string> }
  | { name: 'easyRun'; runId: string; query?: Record<string, string> }
  | { name: 'easyTwo'; matchId: string; query?: Record<string, string> }

const isRunTab = (v: string): v is RunTab => (RUN_TABS as readonly string[]).includes(v)

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** Parse a location hash (`#/runs/r1/diff?x=1`, with or without the leading `#`). */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const query: Record<string, string> = {}
  if (q !== -1) for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) query[k] = v
  const segs = path
    .split('/')
    .filter((s) => s !== '')
    .map(decode)
  const [head, a, b, ...rest] = segs
  if (head === undefined) return { name: 'dashboard', query }
  if (head === 'runs') {
    if (a === undefined) return { name: 'runs', query }
    if (b === undefined) return { name: 'run', runId: a, tab: 'flow', query }
    if (isRunTab(b) && rest.length === 0) return { name: 'run', runId: a, tab: b, query }
    return { name: 'notFound', path, query }
  }
  if (head === 'matches' && a !== undefined && b === undefined) return { name: 'match', matchId: a, query }
  if (head === 'rematch' && a !== undefined && b === undefined) return { name: 'rematch', runId: a, query }
  if (head === 'plops' && a === undefined) return { name: 'plops', query }
  if (head === 'preview' && a === undefined) return { name: 'preview', query }
  if (head === 'deploy' && a === undefined) return { name: 'deploy', query }
  if (head === 'queue' && a === undefined) return { name: 'queue', query }
  if (head === 'easy') {
    if (a === undefined) return { name: 'easy', page: 'home', query }
    if (b === undefined && isEasyPage(a)) return { name: 'easy', page: a, query }
    if (a === 'runs' && b !== undefined && rest.length === 0) return { name: 'easyRun', runId: b, query }
    if (a === 'two' && b !== undefined && rest.length === 0) return { name: 'easyTwo', matchId: b, query }
    return { name: 'notFound', path, query }
  }
  if (head === 'settings') {
    const subpath = b === undefined ? [] : [b, ...rest]
    return a === undefined
      ? { name: 'settings', subpath, query }
      : { name: 'settings', section: a, subpath, query }
  }
  return { name: 'notFound', path, query }
}

function queryString(query: Record<string, string> | undefined): string {
  if (query === undefined) return ''
  const s = new URLSearchParams(query).toString()
  return s === '' ? '' : `?${s}`
}

/** The `#/…` href of a route, for <a href> and navigate(). */
export function href(to: RouteTarget): string {
  const enc = encodeURIComponent
  switch (to.name) {
    case 'dashboard':
      return `#/${queryString(to.query)}`
    case 'runs':
      return `#/runs${queryString(to.query)}`
    case 'run': {
      const tab = to.tab === undefined || to.tab === 'flow' ? '' : `/${to.tab}`
      return `#/runs/${enc(to.runId)}${tab}${queryString(to.query)}`
    }
    case 'match':
      return `#/matches/${enc(to.matchId)}${queryString(to.query)}`
    case 'rematch':
      return `#/rematch/${enc(to.runId)}${queryString(to.query)}`
    case 'plops':
      return `#/plops${queryString(to.query)}`
    case 'preview':
      return `#/preview${queryString(to.query)}`
    case 'deploy':
      return `#/deploy${queryString(to.query)}`
    case 'queue':
      return `#/queue${queryString(to.query)}`
    case 'easy': {
      const page = to.page === undefined || to.page === 'home' ? '' : `/${to.page}`
      return `#/easy${page}${queryString(to.query)}`
    }
    case 'easyRun':
      return `#/easy/runs/${enc(to.runId)}${queryString(to.query)}`
    case 'easyTwo':
      return `#/easy/two/${enc(to.matchId)}${queryString(to.query)}`
    case 'settings': {
      const parts = [to.section, ...(to.subpath ?? [])].filter(
        (p): p is string => p !== undefined && p !== '',
      )
      const path = parts.map(enc).join('/')
      return `#/settings${path === '' ? '' : `/${path}`}${queryString(to.query)}`
    }
  }
}

/** Go to a route (`#/…` string or target). `replace` swaps the history entry instead of pushing one. */
export function navigate(to: RouteTarget | string, opts: { replace?: boolean } = {}): void {
  const target = typeof to === 'string' ? (to.startsWith('#') ? to : `#${to}`) : href(to)
  if (opts.replace === true) {
    const url = new URL(window.location.href)
    url.hash = target
    window.history.replaceState(window.history.state, '', url)
    // replaceState does not fire hashchange; subscribers still need to hear about it.
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    return
  }
  if (window.location.hash === target) return
  window.location.hash = target
}

let cachedHash: string | null = null
let cachedRoute: Route = { name: 'dashboard', query: {} }

/** The current route (cached per hash, so it is a stable useSyncExternalStore snapshot). */
export function currentRoute(): Route {
  const h = window.location.hash
  if (h !== cachedHash) {
    cachedHash = h
    cachedRoute = parseHash(h)
  }
  return cachedRoute
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute)
}

/** Current hash path for `app.ready({route})` and logs (`#/` when empty). */
export function currentHash(): string {
  return window.location.hash === '' ? '#/' : window.location.hash
}
