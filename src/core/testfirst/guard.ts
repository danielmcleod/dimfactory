// Test-first's guard: the tests the Tests step wrote, compared before Implement (T1) and after it (S1), with no model.
// A test file Implement deleted, or one that lost assertions or tests, or gained skips, is a `[must]` finding: the
// tests define the change, and making them pass by weakening them is not making them pass. Deterministic text counts
// over the common test frameworks (JavaScript/TypeScript, Python, Go, Rust, Java/Kotlin, C#, Swift, Ruby, PHP).
import { createHash } from 'node:crypto'
import type { FindingInput } from '../supervisor/types.ts'

/** A file of the Tests step: its text at T1 and at S1 (null: absent then). */
export interface GuardFile {
  path: string
  before: string | null
  after: string | null
}

/** Files larger than this are not compared (generated snapshots, fixtures): no finding either way. */
export const GUARD_FILE_MAX_BYTES = 512 * 1024

const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|(?:^|\/)[^/]*[._-](?:test|spec)s?\.[^/]+$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.(?:go|py|rb|exs?)$|(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift|scala|php)$/

/** A path that looks like a test file by its name or folder. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, '/'))
}

/** Assertions: `expect(`, `assert…`, `should`, `t.Error…`, `XCTAssert…`, `Assert.…`, `assert_eq!`, `$this->assert…`. */
const ASSERTION =
  /\bexpect\s*\(|\bassert(?:_\w+!?|\w*)\s*[(!.]|\bassert\s+[^=\s]|\.should\b|\bshould\.|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\bXCTAssert\w*\s*\(|\bAssert\.\w+\s*\(|\$this->assert\w+\s*\(|\brequire\.\w+\s*\(/g

/** Test declarations: `it(`, `test(`, `def test_`, `func Test…`, `#[test]`, `@Test`, `[Fact]`/`[Test]`/`[TestMethod]`. */
const TEST_DECL =
  /\b(?:x?it|x?test)(?:\.(?:each\s*\([^)]*\)|skip|only|todo|concurrent|fails))?\s*\(|\bdef\s+test_\w*|\bfunc\s+Test\w*\s*\(|#\[test\]|@Test\b|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b|\bfunc\s+test\w*\s*\(/g

/** Skips and pending markers: `.skip`, `xit`, `xdescribe`, `.todo`, `@pytest.mark.skip`, `t.Skip`, `#[ignore]`, … */
const SKIP =
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo)\b|\bx(?:it|test|describe|context)\s*\(|\b(?:it|test|describe)\.(?:fails|failing)\b|@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|expectedFailure)\w*|\bpytest\.skip\s*\(|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]|@(?:Disabled|Ignore)\b|\[(?:Ignore|Skip)\b|Skip\s*=\s*"|\bmarkTestSkipped\s*\(|\bpending\s*\(|\bskip\s*\(\s*["'`]/g

const count = (re: RegExp, text: string): number => (text.match(re) ?? []).length

/** Comments are not code: a commented-out assertion does not count. Line and block comments, best effort. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
    .replace(/^\s*#(?!\[)[^\n]*/gm, '')
}

export interface TestCounts {
  assertions: number
  tests: number
  skips: number
}

export function testCounts(text: string): TestCounts {
  const code = stripComments(text)
  return { assertions: count(ASSERTION, code), tests: count(TEST_DECL, code), skips: count(SKIP, code) }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function findingId(path: string, what: string): string {
  return createHash('sha1').update(`tests\n${path}\n${what}`, 'utf8').digest('hex').slice(0, 12)
}

/**
 * The `[must]` findings for the Tests step's files: only files that are tests (by path, or holding a test or an
 * assertion at T1) are compared; a file too large or not text at either end is left alone.
 */
export function weakenedTests(files: readonly GuardFile[]): FindingInput[] {
  const out: FindingInput[] = []
  for (const f of files) {
    if (f.before === null) continue
    if (Buffer.byteLength(f.before, 'utf8') > GUARD_FILE_MAX_BYTES) continue
    const before = testCounts(f.before)
    const looksLikeTest = isTestPath(f.path) || before.tests > 0 || before.assertions > 0
    if (!looksLikeTest) continue
    if (f.after === null) {
      out.push({
        id: findingId(f.path, 'deleted'),
        severity: 'must',
        title: `\`${f.path}\` was deleted after the Tests step wrote it`,
        body: 'Test-first: the tests written before Implement define the change. Restore the file and make its tests pass instead.',
      })
      continue
    }
    if (Buffer.byteLength(f.after, 'utf8') > GUARD_FILE_MAX_BYTES) continue
    const after = testCounts(f.after)
    const problems: string[] = []
    if (after.tests < before.tests) problems.push(`${plural(before.tests - after.tests, 'test')} removed`)
    if (after.assertions < before.assertions)
      problems.push(`${plural(before.assertions - after.assertions, 'assertion')} removed`)
    if (after.skips > before.skips) problems.push(`${plural(after.skips - before.skips, 'skip')} added`)
    if (problems.length === 0) continue
    out.push({
      id: findingId(f.path, problems.join(',')),
      severity: 'must',
      title: `\`${f.path}\` was weakened after the Tests step wrote it: ${problems.join(', ')}`,
      body: `Before Implement it had ${plural(before.tests, 'test')}, ${plural(before.assertions, 'assertion')} and ${plural(before.skips, 'skip')}; now ${after.tests}, ${after.assertions} and ${after.skips}. Restore the tests and make them pass instead of loosening them.`,
    })
  }
  return out
}
