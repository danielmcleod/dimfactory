// Heal shell suggestions (the shell denylist, pipe-to-shell refused except the official installers; shell_copy:
// copied, never executed). A suggestion is a command the
// user pastes into a terminal on Dim Factory's word, so it passes two gates:
//  1. the shell denylist over the command as a shell reads it: quotes and escapes removed (`r''m`, `\rm`, `b\ash`, cmd's
//     `^`), a program named by its path reduced to its name (`/bin/rm`, `C:\…\reg.exe`), switch clusters split
//     (`/s/q`), any rm flag cluster holding r/R or a PowerShell `-Recurse` prefix counted as recursive; pipes into a
//     shell, a variable or a path, downloads, and code run from strings refused;
//  2. an allowlist of the command families a heal fixes things with (the vendor CLIs' login/update/doctor commands,
//     global npm installs of the vendor packages, installing git or Node.js, safe git repairs, removing a git lock file,
//     unsetting an environment variable, and looking a program up).
// Invisible (format) characters and look-alike dashes or quotes are refused outright: what the card shows must be what
// the clipboard gets, and PowerShell reads an en dash as `-`.
import { VENDOR_NPM_PACKAGES, isOfficialInstaller } from './commands.ts'

/** Shell denylist: longer commands are refused. */
export const HEAL_SHELL_MAX = 300

/** Format characters: bidi overrides and isolates, zero-width characters, the soft hyphen, tag characters. */
const FORMAT_CHARS = /\p{Cf}/u
/** Dashes and quotes PowerShell reads as `-`, `'` and `"` (and their look-alikes): a command spells them in ASCII. */
const LOOKALIKE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u2018-\u201F\u00AB\u00BB\u2039\u203A\uFF02\uFF07]/

/** Commands split into segments at `;`, `&&`, `||`, `|` and `&`; each segment is checked word by word. */
const SEGMENT_SPLIT = /\|\||&&|[;|&]/
/** Redirections that cannot destroy anything (stream merges and the null device). */
const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*(\/dev\/null|\$null|nul\b)/gi

const DELETE_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'ri',
  'remove-item',
])
const DESTRUCTIVE =
  /^(format|mkfs(\.[a-z0-9]+)?|newfs(_[a-z0-9]+)?|dd|diskpart|diskutil|format-volume|clear-disk|initialize-disk|remove-partition|cipher|fdisk|sfdisk|parted|wipefs|shred|srm|remove-itemproperty|clear-content|set-content|out-file|truncate|vssadmin|wbadmin|bcdedit)$/
/** Shells and interpreters: never suggested with arguments (a nested command or script), never piped into. */
const SHELLS =
  /^(sh|bash|zsh|dash|ksh|csh|tcsh|fish|ash|busybox|pwsh|powershell|powershell_ise|cmd|python[0-9.]*|py|node|deno|bun|perl|ruby|php|lua|osascript|wscript|cscript|mshta|rundll32|regsvr32|msiexec)$/
/** Tools that fetch a file to disk (a download that a later command could run). */
const DOWNLOADERS: ReadonlySet<string> = new Set([
  'wget',
  'certutil',
  'bitsadmin',
  'start-bitstransfer',
  'aria2c',
])
const FETCHERS: ReadonlySet<string> = new Set([
  'curl',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
  'wget',
])
/** Wrappers that run the next word as the command (stripped before the denylist looks at the command). */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'call',
  'start',
  'command',
  'exec',
  'nohup',
  'time',
  'env',
  'xargs',
  'nice',
  'timeout',
  '.',
])

// ---- reading words as a shell does ----------------------------------------------------------------------------------

/** Whitespace-separated words (quotes ignored: the denylist splits more, never less). */
function tokens(segment: string): string[] {
  return segment
    .replace(HARMLESS_REDIRECT, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
}

/** Words as a shell groups them: whitespace inside '…' or "…" does not split (`"C:/My Work/repo"` is one word). */
function shellWords(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of text) {
    if (quote !== null) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      cur += ch
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur !== '') out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/** A word without quotes (`r''m` → `rm`), cmd's `^` escapes and grouping parentheses. */
const unquote = (w: string): string => w.replace(/["'^]/g, '').replace(/^\(+|\)+$/g, '')

/** The program a command word names, under both readings of a backslash (sh escape, Windows path separator). */
function programNames(word: string): string[] {
  const plain = unquote(word)
  const readings = [plain.replace(/\\(.)/g, '$1'), plain]
  return [
    ...new Set(
      readings.map((r) =>
        (r.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|com|cmd|bat|ps1)$/, ''),
      ),
    ),
  ]
}

/** The word names a program by a path (`/bin/rm`, `.\x.exe`, `\rm`), a variable or a call, not by its name. */
const notAPlainName = (word: string): boolean =>
  /[\\/$%(){}[\]&@]/.test(unquote(word)) || word.startsWith('.')

/** `-rf`, `-dfrvR`, `-r` / `-Rec` / `-Recurse`, `--recursive`, cmd's `/s` alone or in `/s/q`. */
export function isRecursiveFlag(arg: string): boolean {
  const a = unquote(arg)
  if (/^--?recur/i.test(a)) return true
  if (/^-r(e(c(u(r(s(e)?)?)?)?)?)?(:\S*)?$/i.test(a)) return true
  if (/^-[fiIrRdvPWx]+$/.test(a) && /[rR]/.test(a)) return true
  return a.split(/(?=\/)/).some((s) => /^\/s$/i.test(s))
}

/** git subcommands (and their options) that throw work away. `args` keep their case (`-d` vs `-D`). */
function gitDiscards(args: readonly string[]): boolean {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = (args[i] ?? '').toLowerCase()
  const rest = args.slice(i + 1)
  const has = (re: RegExp): boolean => rest.some((a) => re.test(a))
  switch (sub) {
    case 'clean':
    case 'restore':
    case 'filter-branch':
    case 'filter-repo':
    case 'rm':
      return true
    case 'reset':
      return has(/^--(hard|merge|keep)$/)
    case 'checkout':
    case 'switch':
      return rest.includes('--') || rest.includes('.') || has(/^(-f|--force|--discard-changes|-B)$/)
    case 'push':
      return has(/^(-f|--force.*|--delete|-d|--mirror|--prune)$/) || rest.some((a) => a.startsWith('+'))
    case 'branch':
      return has(/^(-D|--delete|-M|-C|--force|-f)$/) || (has(/^-d$/) && has(/^(-f|--force)$/))
    case 'stash':
      return has(/^(drop|clear)$/)
    case 'update-ref':
      return has(/^-d$/)
    case 'reflog':
      return has(/^(expire|delete)$/)
    case 'gc':
    case 'prune':
      return has(/^--prune/) || sub === 'prune'
    case 'rebase':
      return has(/^--skip$/)
    default:
      return false
  }
}

// ---- gate 1: the shell denylist ----------------------------------------------------------------------------------

function denied(c: string): string | undefined {
  const lower = c.toLowerCase()
  if (/\bset-executionpolicy\b|-executionpolicy\b|-ep\s+(bypass|unrestricted)\b/.test(lower)) {
    return 'changes the execution policy'
  }
  if (
    /\b(iex|invoke-expression|invoke-command|invoke-item|start-process|new-object|add-type|new-module)\b/.test(
      lower,
    )
  ) {
    return 'runs code from a string'
  }
  if (/\$executioncontext|invokescript|\[scriptblock\]|::create\(|\.invoke\(/.test(lower)) {
    return 'runs code from a string'
  }
  if (/\beval\b|`|\$\(|<\(|\$\{/.test(lower)) return 'runs a computed command'
  const redirects = lower.replace(HARMLESS_REDIRECT, '')
  if (/(^|[^>])>(?!>)/.test(redirects) || />>/.test(redirects)) return 'writes to a file'
  if (/</.test(redirects)) return 'reads a file into a command'
  if (/\bsetx\b[^|;&]*\bpath\b/.test(lower)) return 'can truncate PATH'
  // `2>&1` is a redirection, not a separator.
  const clean = c.replace(HARMLESS_REDIRECT, ' ')
  const segments = clean.split(SEGMENT_SPLIT)
  const piped = /(^|[^|])\|(?!\|)/.test(clean)
  for (const [i, seg] of segments.entries()) {
    const original = tokens(seg)
    while (
      original.length > 0 &&
      (programNames(original[0] ?? '').some((n) => WRAPPERS.has(n)) ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(original[0] ?? ''))
    ) {
      original.shift()
    }
    const first = original[0]
    if (first === undefined) continue
    const names = programNames(first)
    const args = original.slice(1).map(unquote)
    const lowerArgs = args.map((a) => a.toLowerCase())
    if (piped && i > 0) {
      if (names.some((n) => SHELLS.test(n)) || notAPlainName(first)) return 'pipes into a shell'
      if (names.some((n) => DELETE_COMMANDS.has(n))) return 'deletes what another command lists'
    }
    if (names.some((n) => SHELLS.test(n)) && lowerArgs.some((a) => !/^(-v|--version|-version)$/.test(a))) {
      return 'runs a nested command'
    }
    for (const [j, word] of original.entries()) {
      const ns = programNames(word)
      if (ns.some((n) => DELETE_COMMANDS.has(n)) && original.slice(j + 1).some(isRecursiveFlag)) {
        return 'deletes recursively'
      }
      if (ns.some((n) => DESTRUCTIVE.test(n))) return 'can destroy or overwrite data'
      if (ns.some((n) => DOWNLOADERS.has(n))) return 'downloads a file'
      if (
        ns.some((n) => FETCHERS.has(n)) &&
        original
          .slice(j + 1)
          .map(unquote)
          .some((a) => /^(-o|-O|--output|--remote-name|--remote-name-all|-outfile|-of)$/i.test(a))
      ) {
        return 'downloads a file'
      }
    }
    if (names.includes('reg') && lowerArgs[0] !== 'query') return 'changes the registry'
    if (names.includes('find') && lowerArgs.some((a) => /^-(delete|exec|execdir|ok|okdir)$/.test(a))) {
      return 'deletes or runs files'
    }
    if (names.some((n) => ['chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'attrib', 'cacls'].includes(n))) {
      if (lowerArgs.some((a) => /^-[a-z]*r/.test(a) || a === '/t' || a === '/s' || a === '--recursive')) {
        return 'changes permissions recursively'
      }
    }
    if (names.includes('git') && gitDiscards(original.slice(1).map(unquote))) return 'discards work in git'
  }
  return undefined
}

// ---- gate 2: the command families a heal may suggest -----------------------------------------------------------

type Family = (args: readonly string[]) => string | undefined

const OK = undefined
const NOT_OFFERED = 'is not a command Dim Factory offers to copy'
const SAFE_ARG = /^[A-Za-z0-9._@:+=,/~-]+$/
const UNSAFE_ARG = /dangerously|yolo|full-?auto|bypass|danger-?full-?access|skip-?permissions|no-?sandbox/i
const VERSION_ARGS: ReadonlySet<string> = new Set(['--version', '-v', '-V', 'version', '--help', '-h'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()
const onlyVersion = (args: readonly string[]): boolean => args.length === 1 && VERSION_ARGS.has(args[0] ?? '')
const plainArgs = (args: readonly string[]): boolean =>
  args.every((a) => SAFE_ARG.test(a) && !UNSAFE_ARG.test(a))

/** A vendor CLI: only its sign-in, update and health commands (never a prompt, a session or a permission flag). */
function vendorCli(subcommands: Readonly<Record<string, readonly string[] | null>>, bare = false): Family {
  return (args) => {
    if (args.length === 0) return bare ? OK : NOT_OFFERED
    if (onlyVersion(args)) return OK
    const sub = lower(args[0])
    const next = Object.hasOwn(subcommands, sub) ? subcommands[sub] : undefined
    if (next === undefined) return NOT_OFFERED
    if (next !== null && !next.includes(lower(args[1]))) return NOT_OFFERED
    return plainArgs(args) ? OK : 'passes unusual arguments'
  }
}

const VENDOR_PACKAGE = new RegExp(
  `^(?:${VENDOR_NPM_PACKAGES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:@(?:latest|\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?))?$`,
)
const NPM_INSTALL: ReadonlySet<string> = new Set([
  'install',
  'i',
  'add',
  'update',
  'up',
  'upgrade',
  'uninstall',
  'un',
  'remove',
  'rm',
  'r',
])
const isGlobal = (a: string): boolean => a === '-g' || a === '--global'

/** npm: global installs of the vendor packages, and reading npm's settings and folders. */
const npmFamily: Family = (args) => {
  if (onlyVersion(args)) return OK
  const sub = lower(args[0])
  const rest = args.slice(1)
  if (NPM_INSTALL.has(sub)) {
    const flags = rest.filter((a) => a.startsWith('-'))
    const pkgs = rest.filter((a) => !a.startsWith('-'))
    if (!flags.some(isGlobal) || !flags.every(isGlobal)) return 'is not a global install of a vendor CLI'
    if (pkgs.length === 0 || !pkgs.every((p) => VENDOR_PACKAGE.test(p))) {
      return 'installs a package other than the vendor CLIs'
    }
    return OK
  }
  if (sub === 'config') {
    return ['get', 'list', 'ls'].includes(lower(rest[0])) && plainArgs(rest) ? OK : 'changes npm settings'
  }
  if (['prefix', 'root', 'bin', 'ls', 'list', 'doctor'].includes(sub)) {
    return rest.every((a) => isGlobal(a) || VENDOR_PACKAGE.test(a)) ? OK : NOT_OFFERED
  }
  return NOT_OFFERED
}

const SYSTEM_PACKAGES: ReadonlySet<string> = new Set([
  'git',
  'git-lfs',
  'node',
  'nodejs',
  'nodejs-lts',
  'npm',
  'ollama',
])
const WINGET_IDS: ReadonlySet<string> = new Set([
  'git.git',
  'github.gitlfs',
  'openjs.nodejs',
  'openjs.nodejs.lts',
  'ollama.ollama',
  'winget',
])

/** A package manager installing git, Node.js or Ollama (and nothing else). */
function installer(o: {
  subcommands: readonly string[]
  flags: readonly string[]
  packages: ReadonlySet<string>
  /** Whole argument lists allowed as they are (`apt-get update`). */
  exact?: readonly (readonly string[])[]
}): Family {
  return (args) => {
    if (onlyVersion(args)) return OK
    if (o.exact?.some((e) => e.length === args.length && e.every((x, i) => x === lower(args[i])))) return OK
    if (!o.subcommands.includes(lower(args[0]))) return NOT_OFFERED
    const rest = args.slice(1)
    const flags = rest.filter((a) => a.startsWith('-'))
    const names = rest.filter((a) => !a.startsWith('-'))
    if (flags.some((f) => !o.flags.includes(lower(f)))) return 'passes unusual installer options'
    if (names.length === 0 || names.some((n) => !o.packages.has(lower(n)))) {
      return 'installs something other than git, Node.js or the vendor tools'
    }
    return OK
  }
}

const pacmanFamily: Family = (args) => {
  const flags = args.filter((a) => a.startsWith('-'))
  const names = args.filter((a) => !a.startsWith('-'))
  if (!flags.some((f) => f === '-S' || f === '-Sy')) return NOT_OFFERED
  if (flags.some((f) => !['-S', '-Sy', '--needed', '--noconfirm'].includes(f))) {
    return 'passes unusual installer options'
  }
  return names.length > 0 && names.every((n) => SYSTEM_PACKAGES.has(lower(n)))
    ? OK
    : 'installs something other than git, Node.js or the vendor tools'
}

/** git config keys a heal may set or read (nothing that names a program git runs: no aliases, hooks or helpers). */
const GIT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'safe.directory',
  'core.longpaths',
  'core.autocrlf',
  'core.safecrlf',
  'core.filemode',
  'user.name',
  'user.email',
  'init.defaultbranch',
  'http.sslbackend',
  'http.postbuffer',
  'http.version',
  'pull.rebase',
])
const GIT_CONFIG_OPTIONS: ReadonlySet<string> = new Set([
  '--global',
  '--system',
  '--local',
  '--add',
  '--unset',
  '--unset-all',
  '--replace-all',
  '--get',
  '--get-all',
  '--list',
  '-l',
  '--show-origin',
  '--show-scope',
  '--bool',
  '--type=bool',
])

function gitConfig(rest: readonly string[]): string | undefined {
  const opts = rest.filter((a) => a.startsWith('-'))
  const words = rest.filter((a) => !a.startsWith('-'))
  if (opts.some((o) => !GIT_CONFIG_OPTIONS.has(lower(o))))
    return 'changes git settings Dim Factory does not offer'
  if (words.length === 0) return opts.some((o) => o === '--list' || o === '-l') ? OK : NOT_OFFERED
  if (!GIT_CONFIG_KEYS.has(lower(words[0]))) return 'changes git settings Dim Factory does not offer'
  if (words.slice(1).some((v) => v.startsWith('!'))) return 'runs a program from git'
  return words.length <= 2 ? OK : NOT_OFFERED
}

/** git: repairs that keep the user's work (abort an operation, trust a folder, prune worktrees, look around). */
const gitFamily: Family = (args) => {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const a = args[i] ?? ''
    if (VERSION_ARGS.has(a) && args.length === 1) return OK
    if (a === '-C') i += 2
    else if (a === '--no-pager' || a === '--no-optional-locks') i += 1
    else return 'runs git with options that can run programs'
  }
  const sub = lower(args[i])
  const rest = args.slice(i + 1)
  switch (sub) {
    case 'version':
    case 'status':
    case 'init':
    case 'fetch':
    case 'log':
    case 'rev-parse':
      return rest.every((a) => SAFE_ARG.test(a)) ? OK : 'passes unusual arguments'
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return rest.length === 1 && (rest[0] === '--abort' || rest[0] === '--quit') ? OK : NOT_OFFERED
    case 'bisect':
      return rest.length === 1 && rest[0] === 'reset' ? OK : NOT_OFFERED
    case 'worktree':
      return rest.length === 1 && ['prune', 'list'].includes(lower(rest[0])) ? OK : NOT_OFFERED
    case 'lfs':
      return rest.length === 1 && ['install', 'version', '--version'].includes(lower(rest[0]))
        ? OK
        : NOT_OFFERED
    case 'remote':
      return rest.every((a) => a === '-v' || a === 'show' || /^[A-Za-z0-9._-]+$/.test(a)) ? OK : NOT_OFFERED
    case 'stash':
      return rest.length >= 1 && ['list', 'show'].includes(lower(rest[0])) ? OK : NOT_OFFERED
    case 'checkout':
      // Only a detached checkout of a commit or a new branch: `git checkout <path>` throws edits away.
      return (rest[0] === '--detach' && rest.length === 2) || (rest[0] === '-b' && rest.length <= 3)
        ? OK
        : NOT_OFFERED
    case 'switch':
    case 'branch':
      return rest.every((a) => SAFE_ARG.test(a)) ? OK : 'passes unusual arguments'
    case 'config':
      return gitConfig(rest)
    default:
      return NOT_OFFERED
  }
}

const isLockFile = (target: string): boolean => {
  if (/[*?[\]]/.test(target) || !/\.lock$/i.test(target)) return false
  return target.split(/[\\/]/).some((s) => s.toLowerCase() === '.git')
}

/** Deleting one thing only: a git lock file (`index.lock` under `.git`) or an environment variable (`Env:NAME`). */
const deleteFamily: Family = (args) => {
  const flags = args.filter((a) => a.startsWith('-') || /^\/[a-z]$/i.test(a))
  const targets = args.filter((a) => !(a.startsWith('-') || /^\/[a-z]$/i.test(a)))
  if (
    flags.some((f) => !['-f', '--force', '-force', '/f', '/q', '-path', '-literalpath'].includes(lower(f)))
  ) {
    return 'deletes with options Dim Factory does not offer'
  }
  if (targets.length === 0) return NOT_OFFERED
  for (const t of targets) {
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/i.test(t)) continue
    if (!isLockFile(t)) return 'deletes something other than a git lock file'
  }
  return OK
}

const FAMILIES: Readonly<Record<string, Family>> = {
  claude: vendorCli({
    auth: ['login', 'logout', 'status'],
    login: null,
    logout: null,
    update: null,
    upgrade: null,
    doctor: null,
    install: null,
    'migrate-installer': null,
    'setup-token': null,
  }),
  codex: vendorCli({ login: null, logout: null, sandbox: ['setup'] }),
  gemini: vendorCli({}, true),
  ollama: vendorCli({ serve: null, pull: null, list: null, ls: null, ps: null }),
  npm: npmFamily,
  winget: installer({
    subcommands: ['install', 'upgrade'],
    flags: ['--id', '-e', '--exact', '--source', '--silent'],
    packages: WINGET_IDS,
  }),
  brew: installer({ subcommands: ['install', 'upgrade', 'reinstall'], flags: [], packages: SYSTEM_PACKAGES }),
  apt: installer({
    subcommands: ['install'],
    flags: ['-y', '--yes', '--no-install-recommends'],
    packages: SYSTEM_PACKAGES,
    exact: [['update']],
  }),
  'apt-get': installer({
    subcommands: ['install'],
    flags: ['-y', '--yes', '--no-install-recommends'],
    packages: SYSTEM_PACKAGES,
    exact: [['update']],
  }),
  dnf: installer({ subcommands: ['install'], flags: ['-y'], packages: SYSTEM_PACKAGES }),
  yum: installer({ subcommands: ['install'], flags: ['-y'], packages: SYSTEM_PACKAGES }),
  zypper: installer({ subcommands: ['install', 'in'], flags: ['-y', '-n'], packages: SYSTEM_PACKAGES }),
  pacman: pacmanFamily,
  choco: installer({ subcommands: ['install', 'upgrade'], flags: ['-y'], packages: SYSTEM_PACKAGES }),
  scoop: installer({ subcommands: ['install', 'update'], flags: [], packages: SYSTEM_PACKAGES }),
  'xcode-select': (args) => (args.length === 1 && args[0] === '--install' ? OK : NOT_OFFERED),
  git: gitFamily,
  rm: deleteFamily,
  del: deleteFamily,
  erase: deleteFamily,
  'remove-item': deleteFamily,
  ri: deleteFamily,
  unset: (args) => (args.length > 0 && args.every((a) => ENV_NAME.test(a)) ? OK : NOT_OFFERED),
  set: (args) => (args.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(args[0] ?? '') ? OK : NOT_OFFERED),
  where: (args) => (args.length > 0 && args.every((a) => /^[A-Za-z0-9._-]+$/.test(a)) ? OK : NOT_OFFERED),
  which: (args) => (args.length > 0 && args.every((a) => /^[A-Za-z0-9._-]+$/.test(a)) ? OK : NOT_OFFERED),
  'get-command': (args) =>
    args.length > 0 && args.every((a) => /^[A-Za-z0-9._-]+$/.test(a)) ? OK : NOT_OFFERED,
  gcm: (args) => (args.length > 0 && args.every((a) => /^[A-Za-z0-9._-]+$/.test(a)) ? OK : NOT_OFFERED),
  echo: () => OK,
  'write-output': () => OK,
  node: (args) => (onlyVersion(args) ? OK : NOT_OFFERED),
}

/** Whole segments a family check cannot word-split: clearing a user variable in PowerShell, printing one. */
const UNSET_USER_VARIABLE =
  /^\[(System\.)?Environment\]::SetEnvironmentVariable\(\s*(['"])[A-Za-z_][A-Za-z0-9_]*\2\s*,\s*(\$null|''|"")\s*,\s*(['"])(User|Process)\4\s*\)$/i
const PRINT_VARIABLE = /^\$env:[A-Za-z_][A-Za-z0-9_]*$/i

function notOffered(c: string): string | undefined {
  const clean = c.replace(HARMLESS_REDIRECT, ' ')
  if (/(^|[^|])\|(?!\|)/.test(clean)) return 'pipes one command into another'
  for (const seg of clean.split(SEGMENT_SPLIT)) {
    const text = seg.replace(HARMLESS_REDIRECT, ' ').trim()
    if (text === '') return 'has an empty command'
    if (UNSET_USER_VARIABLE.test(text) || PRINT_VARIABLE.test(text)) continue
    const words = shellWords(text)
    if (/^(sudo|doas)$/i.test(words[0] ?? '')) words.shift()
    const first = words[0]
    if (first === undefined) return 'has an empty command'
    if (notAPlainName(first)) return 'names a program by its path or a variable'
    const names = programNames(first)
    const family =
      names.length === 1 && Object.hasOwn(FAMILIES, names[0] ?? '') ? FAMILIES[names[0] ?? ''] : undefined
    if (family === undefined) return NOT_OFFERED
    const problem = family(words.slice(1).map(unquote))
    if (problem !== undefined) return problem
  }
  return undefined
}

/**
 * Why a suggested shell command may not be offered (the shell denylist and the families above), or undefined when it
 * may: more than one line, over 300 characters, hidden or look-alike characters, recursive deletes (`rm -rf`,
 * `Remove-Item -Recurse`, `rd /s`) however they are spelled, disk tools (`format`, `mkfs`, `dd`), registry changes,
 * execution-policy changes, pipes into a shell, downloads and code run from strings, nested shells, file writes, git
 * commands that discard work; and anything outside the command families a heal fixes things with. The official
 * installers (heal/commands.ts) are exempt only by exact match.
 */
export function shellCommandProblem(command: string): string | undefined {
  if (/[\r\n]/.test(command)) return 'more than one line'
  const c = command.trim()
  if (c === '') return 'empty'
  if (c.length > HEAL_SHELL_MAX) return `longer than ${HEAL_SHELL_MAX} characters`
  if (FORMAT_CHARS.test(c)) return 'hidden or direction-changing characters'
  if (LOOKALIKE.test(c) || c.normalize('NFKC') !== c) return 'look-alike dashes, quotes or letters'
  if (isOfficialInstaller(c)) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(c)) return 'control characters'
  return denied(c) ?? notOffered(c)
}
