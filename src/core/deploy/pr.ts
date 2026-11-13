// "Create PR" for a run's committed branch (opt-in per project). Two ways, both explicit:
//   - copyable commands (`git push -u <remote> <branch>`, then `gh pr create …`), shown whatever the gh check says;
//   - Dim Factory runs them itself, but only after a confirmation card that names the repository and the branch, and
//     only when the confirmation still matches what is there now (a remote or branch that changed since refuses).
// The `gh` check is never blocking: a missing or signed-out gh comes with copyable fixes. Dim Factory never stores a
// token; gh and git use the user's own sign-in. Nothing is pushed without that confirmation.
import { DEPLOY_COMMANDS_CAVEAT } from '../../shared/deploy.ts'
import type { DeployStepView, GhStatus } from '../../shared/deploy.ts'
import type { ShellKind } from '../../shared/failure.ts'
import { envName } from '../../shared/brand.ts'
import { runGit, tryGit } from '../git/exec.ts'
import { resolvePathEnv, splitPathList } from '../proc/path-env.ts'
import { execCapture } from '../proc/spawn.ts'
import { sanitizeEnv } from '../proc/env.ts'
import { resolveCommand } from '../verify/resolve-cmd.ts'

/** How long one gh call may take (a push or a pull request over a slow link). */
export const GH_TIMEOUT_MS = 120_000

/** Strip credentials from a remote URL before it is shown or logged (`https://user:token@host/…` → `https://host/…`). */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
}

/** `owner/name` of a GitHub remote URL (https, ssh or scp form); null for any other host. */
export function githubRepoOf(url: string): string | null {
  const u = url.trim()
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
      u,
    )
  if (m === null) return null
  return `${m[1]}/${m[2]}`
}

/** One shell word (bare when plain; else single-quoted for the shell: POSIX `'\''`, PowerShell `''`). */
export function shellWord(s: string, shell: ShellKind): string {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(s)) return s
  return shell === 'powershell' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`
}

/** A branch name git accepts and a copyable command can carry. */
export function plainBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(name) && !name.startsWith('-') && !name.includes('..')
}

/** The copyable steps: push the branch, then open the pull request with its body file. */
export function prCommands(o: {
  remote: string
  branch: string
  base: string | null
  title: string
  bodyFile: string
  shell: ShellKind
}): DeployStepView[] {
  const w = (s: string): string => shellWord(s, o.shell)
  const pr = [
    'gh',
    'pr',
    'create',
    '--head',
    w(o.branch),
    '--title',
    w(o.title),
    '--body-file',
    w(o.bodyFile),
  ]
  if (o.base !== null) pr.splice(3, 0, '--base', w(o.base))
  return [
    {
      id: 'pr:push',
      label: `Push ${o.branch} to ${o.remote}`,
      command: `git push -u ${w(o.remote)} ${w(o.branch)}`,
      shell: o.shell,
    },
    {
      id: 'pr:create',
      label: 'Open the pull request',
      command: pr.join(' '),
      shell: o.shell,
      note: DEPLOY_COMMANDS_CAVEAT,
    },
  ]
}

/** How Dim Factory starts gh: the program and the arguments before gh's own (tests use a fake gh). */
export interface GhCommand {
  file: string
  args: string[]
}

/**
 * How to start gh here: the `gh` executable on the resolved PATH (a batch-file shim is not run: no shell ever starts
 * gh), or null when there is none. Test seam: `<prefix>TEST_GH` names a fake gh (a `.mjs`/`.js` file runs with this
 * process's Node), or `none` (gh reads as not installed). Under DIM_FACTORY_E2E=1 the real gh is never used.
 */
export async function ghCommandFor(
  env: Readonly<Record<string, string | undefined>>,
): Promise<GhCommand | null> {
  const test = env[envName('TEST_GH')]
  if (test !== undefined && test.trim() !== '') {
    if (test === 'none') return null
    return /\.(?:c|m)?js$/i.test(test) ? { file: process.execPath, args: [test] } : { file: test, args: [] }
  }
  if (env[envName('E2E')] === '1') return null
  try {
    const pe = await resolvePathEnv({ env })
    const r = resolveCommand('gh', { cwd: process.cwd(), pathEntries: splitPathList(pe.path), env })
    return r === null || r.batch ? null : { file: r.path, args: [] }
  } catch {
    return null
  }
}

/** The fixes for a missing or signed-out gh (copyable; never run). */
export function ghFixes(o: {
  installed: boolean
  shell: ShellKind
  platform: NodeJS.Platform
}): DeployStepView[] {
  const out: DeployStepView[] = []
  if (!o.installed) {
    if (o.platform === 'win32')
      out.push({
        id: 'gh:install',
        label: 'Install the GitHub CLI',
        command: 'winget install --id GitHub.cli -e',
        shell: o.shell,
      })
    else if (o.platform === 'darwin')
      out.push({
        id: 'gh:install',
        label: 'Install the GitHub CLI',
        command: 'brew install gh',
        shell: o.shell,
      })
    else
      out.push({
        id: 'gh:install',
        label: 'Install the GitHub CLI with your package manager (see cli.github.com)',
        shell: o.shell,
      })
  }
  out.push({
    id: 'gh:login',
    label: 'Sign in to GitHub in a terminal',
    command: 'gh auth login',
    shell: o.shell,
  })
  return out
}

export async function runGh(
  gh: GhCommand,
  args: readonly string[],
  o: { cwd: string; env?: Readonly<Record<string, string | undefined>> },
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
  // gh must never prompt: no terminal is attached, and a prompt would hang until the timeout.
  const env = sanitizeEnv(o.env ?? process.env, {
    purpose: 'vendor',
    extra: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  const r = await execCapture(gh.file, [...gh.args, ...args], {
    cwd: o.cwd,
    env,
    timeoutMs: GH_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
    killTree: true,
  })
  const missing =
    r.error !== undefined &&
    (r.error.code === 'ENOENT' || r.error.code === 'EACCES' || r.error.code === 'EINVAL')
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, missing }
}

/** The gh check (never blocking). */
export async function ghStatus(
  gh: GhCommand | null,
  o: {
    cwd: string
    shell: ShellKind
    platform: NodeJS.Platform
    env?: Readonly<Record<string, string | undefined>>
  },
): Promise<GhStatus> {
  if (gh === null) {
    return {
      installed: false,
      authenticated: false,
      problem:
        'The GitHub CLI (gh) is not installed. Install it, or copy the commands and open the pull request yourself.',
      fixes: ghFixes({ installed: false, shell: o.shell, platform: o.platform }),
    }
  }
  const v = await runGh(gh, ['--version'], o)
  if (v.missing || v.code !== 0) {
    return {
      installed: false,
      authenticated: false,
      problem:
        'The GitHub CLI (gh) did not run. Install it, or copy the commands and open the pull request yourself.',
      fixes: ghFixes({ installed: false, shell: o.shell, platform: o.platform }),
    }
  }
  const version = /gh version (\S+)/.exec(v.stdout)?.[1]
  const auth = await runGh(gh, ['auth', 'status', '--hostname', 'github.com'], o)
  if (auth.code !== 0) {
    return {
      installed: true,
      ...(version !== undefined ? { version } : {}),
      authenticated: false,
      problem:
        'gh is not signed in to GitHub. Sign in in a terminal (Dim Factory never asks for or stores a token).',
      fixes: ghFixes({ installed: true, shell: o.shell, platform: o.platform }),
    }
  }
  return { installed: true, ...(version !== undefined ? { version } : {}), authenticated: true, fixes: [] }
}

/** The remote's URL (credentials stripped), or null when there is no such remote. */
export async function remoteUrl(root: string, remote: string): Promise<string | null> {
  const r = await tryGit(['remote', 'get-url', remote], {
    cwd: root,
    noOptionalLocks: true,
    category: 'git_state',
  })
  return r.ok ? redactRemoteUrl(r.result.stdout.trim()) : null
}

/** The remote's default branch (`refs/remotes/<remote>/HEAD`), or null when git does not know it. */
export async function remoteDefaultBranch(root: string, remote: string): Promise<string | null> {
  const r = await tryGit(['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`], {
    cwd: root,
    noOptionalLocks: true,
    category: 'git_state',
  })
  if (!r.ok) return null
  const v = r.result.stdout.trim()
  return v.startsWith(`${remote}/`) ? v.slice(remote.length + 1) : null
}

export interface CreatePrOptions {
  root: string
  remote: string
  branch: string
  base: string | null
  title: string
  bodyFile: string
  gh: GhCommand
  env?: Readonly<Record<string, string | undefined>>
}

/** Push the branch, then `gh pr create` (argv; no shell). Throws an Error with the tool's message on failure. */
export async function createPr(o: CreatePrOptions): Promise<{ url: string; notes: string[] }> {
  if (!plainBranch(o.branch)) throw new Error(`Dim Factory will not push the branch name ${o.branch}.`)
  await runGit(['push', '-u', o.remote, `refs/heads/${o.branch}:refs/heads/${o.branch}`], {
    cwd: o.root,
    timeoutMs: GH_TIMEOUT_MS,
    category: 'network',
  })
  const args = ['pr', 'create', '--head', o.branch, '--title', o.title, '--body-file', o.bodyFile]
  if (o.base !== null) args.splice(2, 0, '--base', o.base)
  const r = await runGh(o.gh, args, { cwd: o.root, ...(o.env !== undefined ? { env: o.env } : {}) })
  if (r.missing) throw new Error('The GitHub CLI (gh) is not installed.')
  if (r.code !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(0, 3).join(' ')
    throw new Error(`gh could not open the pull request${why !== '' ? `: ${why}` : '.'}`)
  }
  const url = /https?:\/\/\S+/.exec(r.stdout)?.[0]
  if (url === undefined) throw new Error('gh did not print the pull request address.')
  return { url, notes: [`Pushed ${o.branch} to ${o.remote}.`] }
}
