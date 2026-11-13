// A fake GitHub CLI for tests: never touches the network. Each call appends {argv, cwd} to FAKE_GH_LOG (JSON lines).
//   gh --version                 prints a version
//   gh auth status ...           exit 0, or exit 1 when FAKE_GH_AUTH=out
//   gh pr create ...             prints a pull request address (FAKE_GH_PR_URL, default a github.com one)
//   gh issue list ... --json ... prints FAKE_GH_ISSUES (a JSON array), default two open issues
// Anything else exits 2.
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const log = process.env.FAKE_GH_LOG
if (log) appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`)

if (argv[0] === '--version') {
  process.stdout.write('gh version 2.99.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.99.0\n')
  process.exit(0)
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (process.env.FAKE_GH_AUTH === 'out') {
    process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n')
    process.exit(1)
  }
  process.stdout.write('github.com\n  Logged in to github.com account test (keyring)\n')
  process.exit(0)
}
if (argv[0] === 'pr' && argv[1] === 'create') {
  process.stdout.write(`${process.env.FAKE_GH_PR_URL ?? 'https://github.com/acme/shop/pull/7'}\n`)
  process.exit(0)
}
if (argv[0] === 'issue' && argv[1] === 'list' && argv.includes('--json')) {
  const issues =
    process.env.FAKE_GH_ISSUES ??
    JSON.stringify([
      {
        number: 12,
        title: 'Add a --version flag',
        body: 'The CLI should print its version.',
        url: 'https://github.com/acme/shop/issues/12',
      },
      { number: 9, title: 'Fix the help text', body: '', url: 'https://github.com/acme/shop/issues/9' },
    ])
  process.stdout.write(`${issues}\n`)
  process.exit(0)
}
process.stderr.write(`fake gh: unsupported ${argv.join(' ')}\n`)
process.exit(2)
