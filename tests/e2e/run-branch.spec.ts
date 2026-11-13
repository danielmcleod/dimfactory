// The run branch (branch prep: `isolation.branch: runBranch`, created at the pre-Implement boundary
// with create-only update-ref + symbolic-ref; a dirty working tree is preserved byte-identically; Dim Factory never
// commits; End of run: [Return to <prev>] only if <prev> still points at HEAD, [Delete run branch] only if the branch
// isn't checked out and its tip still equals base, otherwise copyable commands). New run branch on, a dirty tree
// (a modified tracked file with CRLF, a staged change, an untracked CRLF file) → the branch is made at Implement and
// every one of those files, the user's index and its staged list stay byte-identical → the run completes → the header
// says "On dim/… (from <prev>)" → After the run: [Delete run branch] is refused while checked out (why, and
// the commands to copy) → [Return to <prev>] puts HEAD back (files untouched) → [Delete run branch] deletes it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { composeRun } from './session-helpers.ts'
import {
  auditBothSizes,
  expectSteadyWidth,
  fingerprint,
  gitOut,
  gitTry,
  sha256,
  trackWidth,
} from './git-helpers.ts'
import { CLEAN_FLOW, VERSION_WRITE } from './scenarios.ts'

const DIRTY = ['src/index.ts', 'package.json', 'scratch.txt', 'src/cli.ts'] as const

test('a run branch on a dirty tree: made at Implement, then Return and Delete with their guards', async ({
  e2e,
}) => {
  const page = await e2e.start({ scenario: CLEAN_FLOW })
  const f = e2e.sandbox
  const prev = gitOut(f, 'symbolic-ref', 'HEAD')
  const prevName = prev.replace(/^refs\/heads\//, '')
  const base = gitOut(f, 'rev-parse', 'HEAD')
  // The dirty tree: a modified tracked file (CRLF bytes), a staged change, an untracked CRLF file.
  writeFileSync(join(f, 'src/index.ts'), `${readFileSync(join(f, 'src/index.ts'), 'utf8')}// local edit\r\n`)
  writeFileSync(join(f, 'package.json'), `${readFileSync(join(f, 'package.json'), 'utf8')}\n`)
  gitOut(f, 'add', 'package.json')
  writeFileSync(join(f, 'scratch.txt'), 'notes\r\nmore\r\n')
  const before = fingerprint(f, DIRTY)
  const index = sha256(join(f, '.git', 'index'))
  const staged = gitOut(f, 'diff', '--cached', '--name-only')
  expect(staged).toBe('package.json')

  const run = await composeRun(e2e, 'add a --version flag', async (p) => {
    await p.getByTestId('composer-passes-toggle').click()
    await p.getByTestId('run-branch').click()
    await expect(p.getByTestId('run-branch')).toHaveAttribute('aria-checked', 'true')
    await expect(p.getByTestId('run-branch-provenance')).toHaveAttribute('data-source', 'run')
  })
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // ---- the branch: at base, checked out, recorded; the dirty tree byte-identical; Implement's file written ----
  const snap = await e2e.snapshot(run.runId)
  const branch = snap.branch
  expect(branch?.name).toMatch(/^dim\/\d{8}-add-a-version-flag$/)
  expect(branch).toEqual({ name: branch?.name, base, previous: prev })
  const name = branch?.name ?? ''
  expect(gitOut(f, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${name}`)
  expect(gitOut(f, 'rev-parse', `refs/heads/${name}`)).toBe(base)
  expect(gitOut(f, 'rev-parse', prev)).toBe(base)
  expect(fingerprint(f, DIRTY)).toEqual(before)
  expect(sha256(join(f, '.git', 'index'))).toBe(index)
  expect(gitOut(f, 'diff', '--cached', '--name-only')).toBe(staged)
  expect(readFileSync(join(f, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  // Dim Factory never commits: the branch and the previous one still point at base (checked above), and HEAD's
  // history has the one commit the sandbox started with.
  expect(gitOut(f, 'rev-list', '--count', 'HEAD')).toBe('1')

  // ---- the header names the branch (the full header's facts line, or the compact row's icon) ----
  const line = `On ${name} (from ${prevName})`
  const fact = page.getByTestId('run-header').getByTestId('run-branch')
  await expect
    .poll(() => fact.evaluate((el) => el.getAttribute('title') ?? el.getAttribute('aria-label')))
    .toBe(line)

  // ---- After the run: Delete refused while checked out, Return, then Delete ----
  const end = page.getByTestId('run-end-branch')
  await expect(end).toBeVisible()
  await expect(end).toContainText(`The run worked on its own branch ${name}, made from ${prevName}.`)
  const ret = end.getByTestId('branch-return')
  const del = end.getByTestId('branch-delete')
  await expect(ret).toHaveText(`Return to ${prevName}`)
  await expect(del).toHaveText('Delete run branch')

  await trackWidth(page, 'delete', '[data-testid="branch-delete"]')
  await trackWidth(page, 'return', '[data-testid="branch-return"]')
  await del.click()
  const refused = end.getByTestId('branch-delete-refused')
  await expect(refused).toContainText(`${name} is checked out. Go back to ${prevName} first.`)
  const commands = refused.getByTestId('branch-delete-commands-command')
  await expect(commands).toHaveCount(2)
  await expect(commands.nth(0)).toContainText(`git checkout ${prevName}`)
  await expect(commands.nth(1)).toContainText('git branch -d')
  expect(gitTry(f, 'rev-parse', '--verify', '-q', `refs/heads/${name}`).ok).toBe(true)
  await auditBothSizes(e2e, page, 'After the run with the refused delete')

  await ret.click()
  await expect(end.getByTestId('branch-return-done')).toHaveText(`Back on ${prevName}.`)
  expect(gitOut(f, 'symbolic-ref', 'HEAD')).toBe(prev)
  expect(fingerprint(f, DIRTY)).toEqual(before)
  expect(sha256(join(f, '.git', 'index'))).toBe(index)

  await del.click()
  await expect(end.getByTestId('branch-delete-done')).toHaveText(`Deleted ${name}.`)
  expect(gitTry(f, 'rev-parse', '--verify', '-q', `refs/heads/${name}`).ok).toBe(false)
  expect(gitOut(f, 'for-each-ref', '--format=%(refname)', 'refs/heads/dim/')).toBe('')
  expect(gitOut(f, 'symbolic-ref', 'HEAD')).toBe(prev)
  // Both actions are settled: disabled with what core answered.
  await expect(ret).toBeDisabled()
  await expect(del).toBeDisabled()
  await expectSteadyWidth(page, 'delete', 'Delete run branch')
  await expectSteadyWidth(page, 'return', `Return to ${prevName}`)
  await auditBothSizes(e2e, page, 'After the run with the branch returned and deleted')

  expect(e2e.pageErrors).toEqual([])
})
