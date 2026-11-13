// The grounding checks: what a pass said it did against what the run shows, with no model. Each check is a pure
// function over the facts the controller reads (the pass's final message, the plan, the pass's own diff, the files at
// its end, its tool evidence, the Verify round after it, the project's dependencies) and returns findings of source
// `grounding` (or notes). A claim the evidence contradicts is `[must]`; a weaker sign is `[should]`.
import { createHash } from 'node:crypto'
import type { Finding, FixReportStatus } from '../../shared/findings.ts'
import type { FindingInput } from '../supervisor/types.ts'
import { checkClaims, pathRefs } from './claims.ts'
import { commandKind, type GroundingTrack } from './evidence.ts'
import type { ImportFacts, ImportRef } from './imports.ts'
import { unresolvedImports } from './imports.ts'
import type { AddedDependency } from './packages.ts'

/** A stable id for a grounding finding (the same fact gives the same id in every run of the check). */
export function groundingId(key: string): string {
  return createHash('sha1').update(`grounding\n${key}`, 'utf8').digest('hex').slice(0, 12)
}

const g = (
  key: string,
  severity: 'must' | 'should',
  title: string,
  body: string,
  hallucination = false,
): FindingInput => ({
  id: groundingId(key),
  severity,
  title,
  body,
  source: 'grounding',
  flags: hallucination ? ['possible-hallucination'] : [],
})

/** A Verify command's result as the checks read it. */
export interface VerifyFact {
  name: string
  argv: readonly string[]
  status: 'pass' | 'fail' | 'env' | 'skipped' | 'skipped-untrusted'
}

export interface GroundingInput {
  step: 'implement' | 'fix'
  /** The pass's final message. */
  finalText: string
  /** The decided plan (Implement only). */
  plan?: string | null | undefined
  /** Paths the pass changed (its start snapshot to its end), relative to the run's folder. */
  changed: ReadonlySet<string>
  /** Every file of the project at the pass's end. */
  files: ReadonlySet<string>
  /** The pass's tool evidence (absent: not recorded, the evidence checks are skipped). */
  evidence?: GroundingTrack | undefined
  /** The Verify round after the pass (absent: it did not run). */
  verify?: readonly VerifyFact[] | undefined
  /** The lines the pass added, per file. */
  added: ReadonlyMap<string, readonly string[]>
  /** What the project has, for the import check (absent: imports are not checked). */
  imports?: ImportFacts | undefined
  /** Dependencies the pass added that are not installed (packages.ts notInstalled). */
  notInstalled?: readonly AddedDependency[] | undefined
  /** Dependencies the registry does not know (only with the online check on). */
  registryMissing?: readonly AddedDependency[] | undefined
}

export interface GroundingOutcome {
  findings: FindingInput[]
  notes: string[]
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``
const passName = (step: GroundingInput['step']): string => (step === 'fix' ? 'Fix' : 'Implement')

/** A path the text names, matched against a set of project paths (a bare file name matches by its last part). */
function matchIn(set: ReadonlySet<string>, p: string): boolean {
  if (set.has(p)) return true
  if (p.includes('/')) return false
  for (const x of set) if (x === p || x.endsWith(`/${p}`)) return true
  return false
}

/** Check 1: paths the final message says it changed (a claim) or names (a mention) that are not what it says. */
export function ghostPaths(i: GroundingInput): FindingInput[] {
  const out: FindingInput[] = []
  for (const ref of pathRefs(i.finalText)) {
    const inDiff = matchIn(i.changed, ref.path)
    const exists = matchIn(i.files, ref.path)
    // A bare name we cannot place (not changed, not at the root) is not judged.
    const placeable = ref.path.includes('/') || exists || inDiff
    if (ref.claim) {
      if (inDiff) continue
      if (ref.deleted) {
        if (exists)
          out.push(
            g(
              `deleted\n${ref.path}`,
              'must',
              `The AI said it deleted ${code(ref.path)}, but it is still there.`,
              ref.line,
            ),
          )
        continue
      }
      if (!placeable && !exists) {
        out.push(
          g(
            `claim-missing\n${ref.path}`,
            'must',
            `The AI said it changed ${code(ref.path)}, but there is no such file.`,
            ref.line,
            true,
          ),
        )
        continue
      }
      out.push(
        exists
          ? g(
              `claim-unchanged\n${ref.path}`,
              'must',
              `The AI said it changed ${code(ref.path)}, but ${passName(i.step)} did not change it.`,
              ref.line,
            )
          : g(
              `claim-missing\n${ref.path}`,
              'must',
              `The AI said it changed ${code(ref.path)}, but there is no such file.`,
              ref.line,
              true,
            ),
      )
      continue
    }
    if (!inDiff && !exists && placeable)
      out.push(
        g(
          `mention-missing\n${ref.path}`,
          'should',
          `The AI mentions ${code(ref.path)}, but there is no such file.`,
          ref.line,
        ),
      )
  }
  return out
}

/** The verify command a claim is about, by what it runs (else its name). */
function verifyKind(v: VerifyFact): 'test' | 'build' | 'other' {
  const k = commandKind(v.argv.join(' '))
  if (k !== 'other') return k
  if (/test|spec/i.test(v.name)) return 'test'
  if (/build|type|tsc|compile|lint|check/i.test(v.name)) return 'build'
  return 'other'
}

/** Check 2: "tests pass", "the build succeeds", "I ran ..." with no such command in the pass, or Verify disagreeing. */
export function claimsVsEvidence(i: GroundingInput): FindingInput[] {
  const out: FindingInput[] = []
  const ev = i.evidence
  const failing = (i.verify ?? []).filter((v) => v.status === 'fail')
  for (const c of checkClaims(i.finalText)) {
    if (c.kind === 'tests') {
      const failed = failing.find((v) => verifyKind(v) === 'test')
      if (failed !== undefined) {
        out.push(
          g(
            `tests-contradicted\n${failed.name}`,
            'must',
            `The AI said the tests pass, but Verify's ${code(failed.name)} failed.`,
            c.line,
          ),
        )
      } else if (ev !== undefined && ev.tests === 0) {
        out.push(g('tests-not-run', 'must', 'The AI said it ran the tests, but none ran.', c.line))
      }
    } else if (c.kind === 'build') {
      const failed = failing.find((v) => verifyKind(v) === 'build')
      if (failed !== undefined) {
        out.push(
          g(
            `build-contradicted\n${failed.name}`,
            'must',
            `The AI said the build succeeds, but Verify's ${code(failed.name)} failed.`,
            c.line,
          ),
        )
      } else if (ev !== undefined && ev.builds === 0 && ev.tests === 0) {
        out.push(
          g('build-not-run', 'must', 'The AI said the build succeeds, but it never ran a build.', c.line),
        )
      }
    } else if (ev !== undefined && ev.shells === 0) {
      out.push(g('ran-nothing', 'must', 'The AI said it ran a command, but it ran none.', c.line))
    }
  }
  return out
}

function importTitle(r: ImportRef): string {
  if (r.relative) return `${code(r.file)} imports ${code(r.spec)}, but there is no such file.`
  const where =
    r.lang === 'js'
      ? 'package.json, the lockfile or node_modules'
      : r.lang === 'python'
        ? "the project's requirements or the standard library"
        : r.lang === 'go'
          ? 'go.mod or the standard library'
          : 'Cargo.toml or the crate itself'
  return `${code(r.file)} imports ${code(r.spec)}, which the project does not have (not in ${where}).`
}

/** Check 3: imports in the added lines that resolve to nothing the project has. */
export function importFindings(i: GroundingInput): FindingInput[] {
  if (i.imports === undefined) return []
  return unresolvedImports(i.added, i.imports).map((r) =>
    g(
      `import\n${r.file}\n${r.spec}`,
      r.relative ? 'must' : 'should',
      importTitle(r),
      r.relative
        ? 'Create the file or fix the import.'
        : 'Add the dependency (and install it) if it is real, or use one the project already has.',
      true,
    ),
  )
}

/** Failed edits of one file from this many on are "repeated". */
export const FAILED_EDITS_REPEATED = 2

/** Check 4: repeated failed edits of one file (its content was guessed), and edits to files never read. */
export function editFindings(i: GroundingInput): FindingInput[] {
  const ev = i.evidence
  if (ev === undefined) return []
  const out: FindingInput[] = []
  for (const [path, n] of Object.entries(ev.failedEdits)) {
    if (n < FAILED_EDITS_REPEATED) continue
    out.push(
      g(
        `failed-edits\n${path}`,
        'should',
        `Edits to ${code(path)} failed ${n} times: the AI may have guessed what the file says.`,
        'Check the change to this file closely.',
        true,
      ),
    )
  }
  for (const path of ev.unreadEdits.slice(0, 10)) {
    out.push(
      g(
        `unread-edit\n${path}`,
        'should',
        `The AI changed ${code(path)} without reading it first.`,
        'Check the change to this file closely.',
      ),
    )
  }
  return out
}

const REGISTRY: Readonly<Record<AddedDependency['ecosystem'], string>> = {
  npm: 'npm',
  pip: 'PyPI',
  cargo: 'crates.io',
  go: 'the Go module proxy',
}

/** Check 6: dependencies added to a manifest that were never installed, or that the registry does not know. */
export function packageFindings(i: GroundingInput): FindingInput[] {
  const out: FindingInput[] = []
  const missing = new Set((i.registryMissing ?? []).map((d) => `${d.ecosystem}:${d.name}`))
  for (const d of i.registryMissing ?? []) {
    out.push(
      g(
        `registry\n${d.ecosystem}\n${d.name}`,
        'must',
        `${code(d.name)} is not on ${REGISTRY[d.ecosystem]}: the AI may have made up this package.`,
        `It was added to ${d.manifest}. Remove it or replace it with a real package.`,
        true,
      ),
    )
  }
  for (const d of i.notInstalled ?? []) {
    if (missing.has(`${d.ecosystem}:${d.name}`)) continue
    out.push(
      g(
        `not-installed\n${d.manifest}\n${d.name}`,
        'should',
        `${code(d.name)} was added to ${d.manifest} but is not installed (no lockfile entry).`,
        'Install the dependencies so the lockfile names it, or remove it if it is not needed.',
      ),
    )
  }
  return out
}

/** Check 8 (notes only): what the plan names that the run did not touch, and how much it changed beyond the plan. */
export function driftNotes(i: GroundingInput): string[] {
  const plan = i.plan ?? ''
  if (plan.trim() === '' || i.changed.size === 0) return []
  const named = pathRefs(plan).map((r) => r.path)
  if (named.length === 0) return []
  const untouched = named.filter((p) => !matchIn(i.changed, p))
  const extra = [...i.changed].filter(
    (c) => !named.some((p) => c === p || c.endsWith(`/${p}`) || (p.endsWith('/') && c.startsWith(p))),
  )
  const notes: string[] = []
  if (untouched.length > 0 && untouched.length < named.length) {
    const list = untouched.slice(0, 5).join(', ')
    notes.push(
      `The plan names ${untouched.length === 1 ? 'a file' : `${untouched.length} files`} the run did not change: ${list}${untouched.length > 5 ? ' and more' : ''}.`,
    )
  }
  if (extra.length > named.length * 2 && extra.length >= 5) {
    notes.push(`The run changed ${extra.length} files the plan does not name.`)
  }
  return notes
}

/** Every check over one pass (findings must first, ids unique). */
export function runGroundingChecks(i: GroundingInput): GroundingOutcome {
  const all = [
    ...ghostPaths(i),
    ...claimsVsEvidence(i),
    ...importFindings(i),
    ...editFindings(i),
    ...packageFindings(i),
  ]
  const seen = new Set<string>()
  const findings = all.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
  findings.sort((a, b) => Number(b.severity === 'must') - Number(a.severity === 'must'))
  return { findings, notes: i.step === 'implement' ? driftNotes(i) : [] }
}

/**
 * Check 7: Fix said a finding was fixed, but the next check (the re-check, or verify:2 with the same stable id) still
 * finds it: a `[must]` contradiction.
 */
export function fixContradictions(
  given: readonly Finding[],
  report: Readonly<Record<string, FixReportStatus>>,
  stillOpen: ReadonlySet<string>,
): FindingInput[] {
  const out: FindingInput[] = []
  for (const f of given) {
    if (report[f.id] !== 'fixed' || !stillOpen.has(f.id)) continue
    out.push(
      g(
        `contradiction\n${f.id}`,
        'must',
        `Fix said F${f.n} was fixed, but the next check still finds it: ${f.title}`,
        'The AI reported this finding as fixed, but it is still open.',
      ),
    )
  }
  return out
}
