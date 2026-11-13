// Commit message and pull request text (pure), and the pull request's helpers: the GitHub repository a remote names,
// credentials stripped from a remote URL, shell words for the copyable commands, and the gh fixes.
import { describe, expect, it } from 'vitest'
import { COMMIT_SUBJECT_MAX } from '@shared/deploy.ts'
import { commitMessage, commitSubject, prBody, wrap } from '@core/deploy/commit-message.ts'
import type { RunFacts } from '@core/deploy/commit-message.ts'
import {
  ghFixes,
  githubRepoOf,
  plainBranch,
  prCommands,
  redactRemoteUrl,
  shellWord,
} from '@core/deploy/pr.ts'

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
  displayNo: 12,
  title: 'add a --version flag to the CLI.',
  task: 'add a --version flag to the CLI.\n\nIt should print the package version and exit 0.',
  outcome: 'fixed',
  findings: { must: 2, should: 1 },
  steps: [
    { key: 'plan', status: 'done', vendor: 'claude', model: 'opus' },
    { key: 'implement', status: 'done', vendor: 'codex', model: null },
    { key: 'review', status: 'done', vendor: 'claude', model: 'sonnet' },
    { key: 'critic', status: 'skipped' },
    { key: 'fix', status: 'done', vendor: 'codex' },
  ],
  files: 4,
  ...over,
})

describe('commit subject', () => {
  it('tidies the title: one line, capitalized, no trailing period', () => {
    expect(commitSubject('add a --version flag.', 3)).toBe('Add a --version flag')
    expect(commitSubject('  fix   the   build \nmore lines', 3)).toBe('Fix the build')
  })

  it('cuts at a word to at most 72 characters', () => {
    const long =
      'make the dashboard faster by caching the run summaries and reading the index only once per minute'
    const s = commitSubject(long, 3)
    expect(s.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX)
    expect(long.toLowerCase().startsWith(s.toLowerCase())).toBe(true)
    expect(s.endsWith(' ')).toBe(false)
    expect(commitSubject('x'.repeat(100), 3)).toHaveLength(COMMIT_SUBJECT_MAX)
  })

  it('an empty title names the run', () => {
    expect(commitSubject('   ', 9)).toBe('Dim Factory run #9')
  })
})

describe('commit message', () => {
  it('subject, blank line, the task, then what the run did (wrapped at 72)', () => {
    const m = commitMessage(facts())
    const lines = m.split('\n')
    expect(lines[0]).toBe('Add a --version flag to the CLI')
    expect(lines[1]).toBe('')
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(72)
    // The facts as prose (wrapping puts line breaks where spaces were).
    const flat = m.replace(/\s+/g, ' ')
    expect(flat).toContain('Made by Dim Factory run #12 (fixed what the reviewers found).')
    expect(flat).toContain(
      'Passes: Plan (claude opus), Implement (codex), Review (claude sonnet), Fix (codex).',
    )
    expect(flat).toContain('Findings: 2 must, 1 should.')
    expect(flat).toContain('Files changed: 4.')
    expect(m).not.toMatch(/—/)
    expect(m.endsWith('\n')).toBe(true)
  })

  it("names the Deploy step's config files and the last checks", () => {
    const m = commitMessage(
      facts({
        deploy: { target: 'Fly.io', written: ['Dockerfile', 'fly.toml'] },
        verify: [{ name: 'test', status: 'pass' }],
      }),
    )
    expect(m).toContain('Deploy config for Fly.io: Dockerfile, fly.toml.')
    expect(m).toContain('Checks: test pass.')
  })

  it('wraps prose and keeps paragraphs', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
    expect(wrap('one\n\ntwo', 72)).toEqual(['one', '', 'two'])
  })

  it('the pull request body says to review it, and claims nothing beyond the checks', () => {
    const b = prBody(facts())
    expect(b).toContain('## What was asked')
    expect(b).toContain('## How it was made')
    expect(b).toContain('Review the changes before merging')
    expect(b).not.toMatch(/\b(?:safe|secure|guaranteed)\b/i)
  })
})

describe('pull request helpers', () => {
  it('reads owner/name from a GitHub remote in any form; other hosts are null', () => {
    expect(githubRepoOf('https://github.com/acme/shop.git')).toBe('acme/shop')
    expect(githubRepoOf('https://user:tok@github.com/acme/shop')).toBe('acme/shop')
    expect(githubRepoOf('git@github.com:acme/shop.git')).toBe('acme/shop')
    expect(githubRepoOf('ssh://git@github.com/acme/shop.git')).toBe('acme/shop')
    expect(githubRepoOf('https://gitlab.com/acme/shop.git')).toBeNull()
    expect(githubRepoOf('C:/repos/shop.git')).toBeNull()
  })

  it('strips credentials from a remote URL', () => {
    expect(redactRemoteUrl('https://user:secret@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
  })

  it('quotes a word for the shell only when it needs it', () => {
    expect(shellWord('dim/20261024-x', 'sh')).toBe('dim/20261024-x')
    expect(shellWord("it's done", 'sh')).toBe("'it'\\''s done'")
    expect(shellWord("it's done", 'powershell')).toBe("'it''s done'")
    expect(shellWord('a; rm -rf /', 'sh')).toBe("'a; rm -rf /'")
  })

  it('only plain branch names are pushed', () => {
    expect(plainBranch('dim/20261024-add-login')).toBe(true)
    expect(plainBranch('-x')).toBe(false)
    expect(plainBranch('a..b')).toBe(false)
    expect(plainBranch('a b')).toBe(false)
  })

  it('the copyable commands: push the branch, then gh pr create with the body file', () => {
    const c = prCommands({
      remote: 'origin',
      branch: 'dim/x',
      base: 'main',
      title: "Add the user's page",
      bodyFile: 'C:\\home\\runs\\r1\\pr-body.md',
      shell: 'powershell',
    })
    expect(c.map((x) => x.command)).toEqual([
      'git push -u origin dim/x',
      "gh pr create --base main --head dim/x --title 'Add the user''s page' --body-file 'C:\\home\\runs\\r1\\pr-body.md'",
    ])
    expect(
      prCommands({ remote: 'origin', branch: 'b', base: null, title: 't', bodyFile: 'f', shell: 'sh' })[1]
        ?.command,
    ).toBe('gh pr create --head b --title t --body-file f')
  })

  it('gh fixes: install per platform and sign in, copyable only', () => {
    expect(
      ghFixes({ installed: false, shell: 'powershell', platform: 'win32' }).map((f) => f.command),
    ).toEqual(['winget install --id GitHub.cli -e', 'gh auth login'])
    expect(ghFixes({ installed: false, shell: 'sh', platform: 'darwin' })[0]?.command).toBe('brew install gh')
    const linux = ghFixes({ installed: false, shell: 'sh', platform: 'linux' })
    expect(linux[0]?.command).toBeUndefined()
    expect(ghFixes({ installed: true, shell: 'sh', platform: 'linux' }).map((f) => f.command)).toEqual([
      'gh auth login',
    ])
  })
})
