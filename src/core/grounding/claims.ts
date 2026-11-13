// What a pass's final message (or the plan) says, read for the grounding checks: the file paths it names, whether it
// says it changed each one (a claim) or only names it (a mention), and its claims about checks it ran ("tests pass",
// "the build succeeds", "I ran ..."). Plain text heuristics, no model; a negated or future sentence is not a claim.
import { commandKind, normPath } from './evidence.ts'

/** File extensions a named path must end in (a version number or a domain name is not a path). */
const EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs mts cts json jsonc md mdx txt yml yaml toml ini cfg conf env lock html htm css scss sass less ' +
    'vue svelte astro py pyi ipynb go mod sum rs rb php java kt kts scala swift m mm c h cc cpp hpp cs fs sql sh ps1 bat ' +
    'cmd xml gradle properties dockerfile graphql gql proto csv tsv svg lua dart ex exs erl zig nim r jl pl'
  ).split(' '),
)

/** Words that make a line a claim of change about the paths on it. */
const CHANGE_VERB =
  /\b(?:updated?|updating|created?|creating|added|adds?|adding|modif(?:y|ied|ies)|changed?|changing|edited|editing|wrote|written|writes?|rewrote|rewritten|implemented|refactored|renamed|moved|deleted|removed|fixed|introduced|extended|replaced)\b/i
const DELETE_VERB = /\b(?:deleted|removed)\b/i
/** A line that says something did not or will not happen is not a claim. */
const NEGATED =
  /\b(?:not|never|no longer|didn't|did not|don't|do not|doesn't|does not|haven't|have not|hasn't|wasn't|weren't|won't|cannot|can't|couldn't|unable|failed to|should|could|would|will|need(?:s)? to|todo|next step|you can|you may|consider|if you)\b/i

/** Where one sentence ends and the next begins on a line (a dot inside `a.ts` is not followed by a space). */
const SENTENCE_END = /(?<=[.!?])\s+/

export interface PathRef {
  path: string
  /** The line says it changed (created, updated, deleted…) the path. */
  claim: boolean
  /** The line says it was deleted or removed. */
  deleted: boolean
  /** The line, trimmed (for the finding's body). */
  line: string
}

const PATH_TOKEN =
  /(?:`([^`\n]+)`|(?<![\w/.@:-])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?![\w/-]))/g

function looksLikePath(raw: string): string | undefined {
  let p = normPath(raw.replace(/:\d+(?::\d+)?$/, '').replace(/[.,;:!?)]+$/, ''))
  if (p === '' || /\s/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.includes('*') || p.startsWith('-'))
    return undefined
  if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) return undefined // absolute: outside what the diff names
  p = p.replace(/^\.\//, '')
  const base = p.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 && !/^\.[\w-]+$/.test(base) && base.toLowerCase() !== 'dockerfile') return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  if (dot > 0 && !EXTENSIONS.has(ext)) return undefined
  // `1.2.3`, `v2.0` and `e.g.` are not files.
  if (/^v?\d+(?:\.\d+)+$/.test(base)) return undefined
  return p
}

/** The paths a text names, line by line, each with whether its line claims a change. First occurrence wins. */
export function pathRefs(text: string): PathRef[] {
  const out = new Map<string, PathRef>()
  let inFence = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = raw.trim()
    if (line === '') continue
    // By sentence: "I fixed the bug. `sample.json` now comes out right." says nothing changed in sample.json.
    for (const sentence of line.split(SENTENCE_END)) {
      const claim = CHANGE_VERB.test(sentence) && !NEGATED.test(sentence)
      for (const m of sentence.matchAll(PATH_TOKEN)) {
        const p = looksLikePath(m[1] ?? m[2] ?? '')
        if (p === undefined) continue
        const prev = out.get(p)
        if (prev !== undefined) {
          if (claim && !prev.claim) out.set(p, { path: p, claim, deleted: DELETE_VERB.test(sentence), line })
          continue
        }
        out.set(p, { path: p, claim, deleted: claim && DELETE_VERB.test(sentence), line: line.slice(0, 300) })
      }
    }
  }
  return [...out.values()]
}

/** A claim about a check the pass ran. */
export interface CheckClaim {
  kind: 'tests' | 'build' | 'ran'
  line: string
}

const TESTS_PASS =
  /\b(?:(?:all|the|every|unit|integration|e2e|existing|new)\s+)*tests?(?:\s+suites?)?\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed)?|are passing|is passing|succeed(?:s|ed)?|(?:are|is|went|came back)\s+green)\b|\b(?:test suite|tests)\s+(?:is|are)\s+(?:green|passing)\b|\b\d+\s+(?:tests?\s+)?passed\b|\b(?:ran|run|running)\s+(?:the\s+|all\s+(?:the\s+)?)?tests?\b|\bverified\s+(?:with|by)\s+(?:the\s+)?tests?\b/i
const BUILD_OK =
  /\b(?:the\s+)?(?:build|compil(?:e|ation)|type[-\s]?check(?:ing)?|typecheck|tsc|lint(?:ing|er)?)\s+(?:now\s+|still\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|is clean|are clean|is green|completes?|completed|works?|reports? no errors?)\b|\b(?:builds|compiles)\s+(?:cleanly|successfully|without errors?)\b|\bno (?:type|build|compile|lint) errors\b/i
const I_RAN = /\bI\s+(?:ran|have run|executed|have executed|re-?ran)\s+(?!into\b)([^.\n]{2,80})/i

/** The claims a final message makes about checks it ran. */
export function checkClaims(text: string): CheckClaim[] {
  const out: CheckClaim[] = []
  const seen = new Set<string>()
  let inFence = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = raw.trim()
    if (line === '' || NEGATED.test(line)) continue
    const add = (kind: CheckClaim['kind']): void => {
      if (seen.has(kind)) return
      seen.add(kind)
      out.push({ kind, line: line.slice(0, 300) })
    }
    if (TESTS_PASS.test(line)) add('tests')
    if (BUILD_OK.test(line)) add('build')
    const ran = I_RAN.exec(line)
    if (ran !== null && !TESTS_PASS.test(line) && !BUILD_OK.test(line)) {
      // "I ran `npm test`" claims the tests; "I ran `tsc`" a build; anything else a command.
      const kind = commandKind((ran[1] ?? '').replace(/`/g, ' '))
      add(kind === 'test' ? 'tests' : kind === 'build' ? 'build' : 'ran')
    }
  }
  return out
}
