// Guardrails: rules a user can define and trust. Trust comes from three things, none of them a list of rules sent to a
// model: each rule states its real strength per vendor, a run will not start if a rule cannot be kept at the strength the
// user required, and there is evidence of what fired. Layers only tighten: a project or a run adds rules, never removes
// or weakens one. Pure data and logic, shared with the renderer.
import { z } from 'zod'

// ---- strength -------------------------------------------------------------------------------------------------------

/**
 * How firmly a rule holds. `hard`: Dim Factory itself refuses before anything starts. `sandboxed`: the AI tool's own
 * sandbox refuses it, whatever program tries. `blocked`: stopped before it runs, though a disguised command can get
 * through. `caught`: found afterwards from what changed or what ran; a change in the folder can be undone, a network
 * call or a read cannot. `none`: this AI tool cannot keep the rule at all, so preflight says so.
 */
export const GUARDRAIL_STRENGTHS = ['hard', 'sandboxed', 'blocked', 'caught', 'none'] as const
export type GuardrailStrength = (typeof GUARDRAIL_STRENGTHS)[number]

const STRENGTH_RANK: Record<GuardrailStrength, number> = {
  none: 0,
  caught: 1,
  blocked: 2,
  sandboxed: 3,
  hard: 4,
}

export function strengthAtLeast(have: GuardrailStrength, want: GuardrailStrength): boolean {
  return STRENGTH_RANK[have] >= STRENGTH_RANK[want]
}

// ---- rules ----------------------------------------------------------------------------------------------------------

export const ON_BREAK = ['stop', 'undo', 'ask'] as const
export type OnBreak = (typeof ON_BREAK)[number]

const PathsZ = z.array(z.string().min(1).max(512)).min(1).max(200)
/** What a rule may require: never `none`, which is no guarantee at all. */
const RequireZ = z.enum(['hard', 'sandboxed', 'blocked', 'caught'])

const ProtectedFilesRuleZ = z.strictObject({
  kind: z.literal('protectedFiles'),
  paths: PathsZ,
  onBreak: z.enum(ON_BREAK).optional(),
  require: RequireZ.optional(),
})
const ForbiddenCommandRuleZ = z.strictObject({
  kind: z.literal('forbiddenCommand'),
  argvPrefix: z.array(z.string().min(1).max(128)).min(1).max(8),
  onBreak: z.enum(['stop', 'ask']).optional(),
  require: RequireZ.optional(),
})
const PrivateFilesRuleZ = z.strictObject({
  kind: z.literal('privateFiles'),
  paths: PathsZ,
  require: RequireZ.optional(),
})
const NoWritesOutsideRuleZ = z.strictObject({
  kind: z.literal('noWritesOutside'),
  require: RequireZ.optional(),
})
const NetworkRuleZ = z.strictObject({
  kind: z.literal('network'),
  allow: z.literal(false),
  require: RequireZ.optional(),
})
const AllowedVendorsRuleZ = z.strictObject({
  kind: z.literal('allowedVendors'),
  vendors: z.array(z.string().min(1).max(64)).min(1).max(20),
})
const NoFullAccessRuleZ = z.strictObject({ kind: z.literal('noFullAccess') })
const NoExtensionsRuleZ = z.strictObject({ kind: z.literal('noExtensions') })
const RequireIsolatedRuleZ = z.strictObject({ kind: z.literal('requireIsolated') })
const MaxChangesRuleZ = z
  .strictObject({
    kind: z.literal('maxChanges'),
    files: z.number().int().positive().optional(),
    lines: z.number().int().positive().optional(),
    onBreak: z.enum(['stop', 'ask']).optional(),
  })
  .refine((r) => r.files !== undefined || r.lines !== undefined, { message: 'set files, lines or both' })
const NewDependenciesRuleZ = z.strictObject({
  kind: z.literal('newDependencies'),
  onBreak: z.enum(ON_BREAK).optional(),
})
const TestsNotWeakenedRuleZ = z.strictObject({
  kind: z.literal('testsNotWeakened'),
  onBreak: z.enum(ON_BREAK).optional(),
})

export const GuardrailRuleZ = z.union([
  ProtectedFilesRuleZ,
  ForbiddenCommandRuleZ,
  PrivateFilesRuleZ,
  NoWritesOutsideRuleZ,
  NetworkRuleZ,
  AllowedVendorsRuleZ,
  NoFullAccessRuleZ,
  NoExtensionsRuleZ,
  RequireIsolatedRuleZ,
  MaxChangesRuleZ,
  NewDependenciesRuleZ,
  TestsNotWeakenedRuleZ,
])
export type GuardrailRule = z.infer<typeof GuardrailRuleZ>
export type GuardrailKind = GuardrailRule['kind']

export const GUARDRAIL_PRESETS = ['off', 'recommended', 'strict'] as const
export type GuardrailPreset = (typeof GUARDRAIL_PRESETS)[number]

export const GuardrailsZ = z.strictObject({
  preset: z.enum(GUARDRAIL_PRESETS),
  rules: z.array(GuardrailRuleZ).max(200),
  /** The one exception to self-protection, for a project that really edits agent settings. Only the user's file counts. */
  allowAgentSettings: z.boolean().optional(),
})
export type Guardrails = z.infer<typeof GuardrailsZ>

export const GUARDRAILS_DEFAULT: Readonly<Guardrails> = { preset: 'recommended', rules: [] }

// ---- what each rule is ----------------------------------------------------------------------------------------------

export interface GuardrailInfo {
  title: string
  /** What it stops, in plain words. */
  stops: string
  /** What it cannot stop. Shown beside every rule; never left out. */
  limit: string
  strength: GuardrailStrength
  /** A vendor where the rule holds differently. Empty until a vendor's own mechanism is proven. */
  byVendor?: Readonly<Record<string, GuardrailStrength>>
  /** A vendor where Approve everything takes the rule's mechanism away (Codex runs with no sandbox then). */
  fullAccess?: Readonly<Record<string, GuardrailStrength>>
  defaultOnBreak?: OnBreak
}

export const GUARDRAIL_INFO: Readonly<Record<GuardrailKind, GuardrailInfo>> = {
  protectedFiles: {
    title: 'Protected files',
    stops:
      'A run changing these files. On Claude its edit tools are refused first, and on Codex an edit it asks to make is declined. Everywhere, the change is also found when the pass ends, however it was made.',
    limit: 'Reading these files is not stopped, and files your project ignores are not in snapshots.',
    strength: 'caught',
    byVendor: { claude: 'blocked' },
    defaultOnBreak: 'undo',
  },
  forbiddenCommand: {
    title: 'Forbidden command',
    stops:
      'This command. On Claude it is refused before it runs. On Codex it is declined when Codex asks to run it. Otherwise the run stops once the tool reports it.',
    limit:
      'Codex asks only for commands its sandbox would not allow, so most commands there are found afterwards, when the effect cannot be undone. The same holds on other tools. A command inside a script is not seen on any tool.',
    strength: 'caught',
    byVendor: { claude: 'blocked' },
    defaultOnBreak: 'stop',
  },
  privateFiles: {
    title: 'Private files',
    stops:
      'A run reading these files. On Claude its read and search tools are refused for them, and so is a shell command that names one.',
    limit:
      'A script or program can still read them, and a search across a whole folder can still show their lines. Other AI tools cannot keep this rule: a read leaves nothing behind to find.',
    strength: 'none',
    byVendor: { claude: 'blocked' },
  },
  noWritesOutside: {
    title: 'No writes outside the folder',
    stops:
      "A run writing files outside its folder. On Claude its edit tools are refused (Claude's own plan files still work). On Codex its sandbox refuses it.",
    limit:
      "On Claude a shell command or script can still write elsewhere. Codex's sandbox still allows the temp folder, and under Approve everything Codex has no sandbox. Other AI tools cannot keep this rule: Dim Factory only sees changes inside the folder.",
    strength: 'none',
    byVendor: { claude: 'blocked', codex: 'sandboxed' },
    fullAccess: { codex: 'none' },
  },
  network: {
    title: 'No network',
    stops:
      "A run reaching the internet. On Claude its web tools are refused, and so are curl, wget, Invoke-WebRequest and Invoke-RestMethod. On Codex its sandbox's network is off, its web search is off, and a request for network access is declined.",
    limit:
      'On Claude any other program (a package install, git, a script) can still connect. Under Approve everything Codex has no sandbox. Other AI tools cannot keep this rule: a network call leaves nothing behind to find.',
    strength: 'none',
    byVendor: { claude: 'blocked', codex: 'sandboxed' },
    fullAccess: { codex: 'none' },
  },
  allowedVendors: {
    title: 'Only these AI tools',
    stops: 'Any pass starting with another AI tool.',
    limit: 'Holds for Dim Factory only. It does not change what the tool itself connects to.',
    strength: 'hard',
  },
  noFullAccess: {
    title: 'No Approve everything',
    stops: 'Auto and Approve everything starting in this project.',
    limit: 'Holds for Dim Factory only. Your own use of a CLI outside it is not affected.',
    strength: 'hard',
  },
  noExtensions: {
    title: 'No extensions',
    stops: 'Passes using your MCP servers, skills, plugins or hooks.',
    limit: 'An AI tool that cannot turn extensions off for a run will not start.',
    strength: 'hard',
  },
  requireIsolated: {
    title: 'Isolated copy only',
    stops: 'A run working directly in your folder.',
    limit: 'The copy holds the project. It does not keep the AI tool away from the rest of your computer.',
    strength: 'hard',
  },
  maxChanges: {
    title: 'Size of change',
    stops: 'A run continuing once it has changed more than this.',
    limit: 'Checked when a pass ends, so a single pass can go past the limit first.',
    strength: 'caught',
    defaultOnBreak: 'stop',
  },
  newDependencies: {
    title: 'New dependencies need approval',
    stops: 'A new package in a manifest going unnoticed.',
    limit: 'Reads common manifests. A package installed without being listed is not seen.',
    strength: 'caught',
    defaultOnBreak: 'ask',
  },
  testsNotWeakened: {
    title: 'Tests may not be weakened',
    stops: 'A run deleting a test file or marking tests as skipped.',
    limit: 'A test rewritten to check less still passes this rule.',
    strength: 'caught',
    // Removing a feature can rightly remove its tests, so this asks rather than ending the run.
    defaultOnBreak: 'ask',
  },
}

/** How firmly a rule holds on a vendor; `fullAccess`: the pass approves everything (Approve everything or Auto). */
export function strengthOf(
  kind: GuardrailKind,
  vendor?: string,
  o: { fullAccess?: boolean } = {},
): GuardrailStrength {
  const info = GUARDRAIL_INFO[kind]
  if (vendor === undefined) return info.strength
  if (o.fullAccess === true && info.fullAccess?.[vendor] !== undefined) return info.fullAccess[vendor]
  return info.byVendor?.[vendor] ?? info.strength
}

export function onBreakOf(rule: GuardrailRule): OnBreak {
  const own = 'onBreak' in rule ? rule.onBreak : undefined
  return own ?? GUARDRAIL_INFO[rule.kind].defaultOnBreak ?? 'stop'
}

/** A rule's one-line description of what it covers. */
export function describeRule(rule: GuardrailRule): string {
  const info = GUARDRAIL_INFO[rule.kind]
  switch (rule.kind) {
    case 'protectedFiles':
    case 'privateFiles':
      return `${info.title}: ${rule.paths.join(', ')}`
    case 'forbiddenCommand':
      return `${info.title}: ${rule.argvPrefix.join(' ')}`
    case 'allowedVendors':
      return `${info.title}: ${rule.vendors.join(', ')}`
    case 'maxChanges': {
      const parts = [
        ...(rule.files !== undefined ? [`${rule.files} files`] : []),
        ...(rule.lines !== undefined ? [`${rule.lines} lines`] : []),
      ]
      return `${info.title}: ${parts.join(', ')}`
    }
    case 'noWritesOutside':
    case 'network':
    case 'noFullAccess':
    case 'noExtensions':
    case 'requireIsolated':
    case 'newDependencies':
    case 'testsNotWeakened':
      return info.title
  }
}

// ---- presets and self-protection ------------------------------------------------------------------------------------

const RECOMMENDED_RULES: readonly GuardrailRule[] = [
  { kind: 'forbiddenCommand', argvPrefix: ['git', 'push'] },
  { kind: 'forbiddenCommand', argvPrefix: ['npm', 'publish'] },
  { kind: 'forbiddenCommand', argvPrefix: ['pnpm', 'publish'] },
  { kind: 'forbiddenCommand', argvPrefix: ['yarn', 'publish'] },
  { kind: 'testsNotWeakened' },
]

const STRICT_RULES: readonly GuardrailRule[] = [
  ...RECOMMENDED_RULES,
  { kind: 'noFullAccess' },
  { kind: 'requireIsolated' },
  { kind: 'newDependencies' },
]

export function presetRules(preset: GuardrailPreset): readonly GuardrailRule[] {
  if (preset === 'strict') return STRICT_RULES
  return preset === 'recommended' ? RECOMMENDED_RULES : []
}

/**
 * Always on and not removable: a run may not change Dim Factory's own config or a vendor's settings and hooks, so a model
 * or a poisoned repository cannot turn a rule off. `CLAUDE.md` and `AGENTS.md` stay editable.
 */
export const SELF_PROTECTED_PATHS: readonly string[] = [
  '.dimfactory/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/**',
  '.codex/**',
  '.gemini/settings.json',
  '.gemini/policies/**',
  '.mcp.json',
]

// ---- tightening-only merge ------------------------------------------------------------------------------------------

const PRESET_RANK: Record<GuardrailPreset, number> = { off: 0, recommended: 1, strict: 2 }

export function stricterPreset(a: GuardrailPreset, b: GuardrailPreset): GuardrailPreset {
  return PRESET_RANK[a] >= PRESET_RANK[b] ? a : b
}

/** A rule's identity: two layers stating the same rule count once. */
export function ruleKey(rule: GuardrailRule): string {
  return JSON.stringify(Object.entries(rule).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Layers in order, the user's own file first (undefined when there is none). The stricter preset wins and rules add up,
 * so no later layer can remove what an earlier one set. A preset of `off` in a project does nothing to the user's floor.
 */
export function mergeGuardrails(
  ...layers: readonly ({ [K in keyof Guardrails]?: Guardrails[K] | undefined } | undefined)[]
): Guardrails {
  let preset: GuardrailPreset | undefined
  const rules = new Map<string, GuardrailRule>()
  for (const layer of layers) {
    if (layer === undefined) continue
    if (layer.preset !== undefined)
      preset = preset === undefined ? layer.preset : stricterPreset(preset, layer.preset)
    for (const rule of layer.rules ?? []) rules.set(ruleKey(rule), rule)
  }
  // Only the first layer (the user's own file) can grant the exception: a committed project file never can.
  const allow =
    layers[0]?.allowAgentSettings === true && layers.slice(1).every((l) => l?.allowAgentSettings !== false)
  return {
    preset: preset ?? GUARDRAILS_DEFAULT.preset,
    rules: [...rules.values()],
    ...(allow ? { allowAgentSettings: true } : {}),
  }
}

/** Everything in force: the preset's rules, then the user's and the project's, one of each. Self-protection is separate. */
export function rulesInForce(g: Guardrails): GuardrailRule[] {
  const rules = new Map<string, GuardrailRule>()
  for (const rule of [...presetRules(g.preset), ...g.rules]) rules.set(ruleKey(rule), rule)
  return [...rules.values()]
}

// ---- paths ----------------------------------------------------------------------------------------------------------

/** A folder-relative path with `/`, no leading `./`. */
export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

/**
 * `*` within one path segment, `**` across segments, `?` one character. A pattern without a `/` matches that name at any
 * depth, and one naming a folder covers what is inside it. Case is ignored everywhere: a rule that protects `Secrets.md`
 * on a case-sensitive disk protects a little more than it says, which is the safe way round.
 */
export function pathGlobToRegExp(glob: string): RegExp {
  const g = normalizeRelPath(glob).replace(/\/+$/, '')
  const anyDepth = !g.includes('/')
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${out}(?:/.*)?$`, 'i')
}

export function pathMatches(path: string, globs: readonly string[]): string | undefined {
  const p = normalizeRelPath(path)
  return globs.find((g) => pathGlobToRegExp(g).test(p))
}

// ---- commands -------------------------------------------------------------------------------------------------------

/** The simple commands in a command line, as words. Splits on `&&`, `||`, `;`, `|` and newlines. Quotes are removed. */
export function commandSegments(line: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote = ''
  const endWord = (): void => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quote !== '') {
      if (c === quote) quote = ''
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endSegment()
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
  return segments
}

/** The program's bare name: `C:\git\git.exe` and `/usr/bin/git` are both `git`. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

/**
 * Whether a command line runs this command. Words after the program may have options between them (`git -C x push`), so
 * the rest of the prefix is looked for in order. Disguises (`sh -c`, a script, an alias) are not seen: the rule says so.
 */
export function commandMatches(line: string, argvPrefix: readonly string[]): boolean {
  const [program, ...rest] = argvPrefix
  if (program === undefined) return false
  return commandSegments(line).some((words) => {
    if (programName(words[0] ?? '') !== program.toLowerCase()) return false
    let at = 1
    for (const want of rest) {
      while (at < words.length && words[at] !== want) at++
      if (at >= words.length) return false
      at++
    }
    return true
  })
}

// ---- proposals: what a change does ----------------------------------------------------------------------------------

/** A file a pass changed. */
export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** Lines the change added, when known. */
  addedLines?: readonly string[]
  linesChanged?: number
}

/** Dependencies a manifest names before and after a change. */
export interface ManifestChange {
  path: string
  before: readonly string[]
  after: readonly string[]
}

export interface GuardrailFinding {
  kind: GuardrailKind
  /** Always-on self-protection rather than a rule the user set. */
  self?: true
  rule: string
  onBreak: OnBreak
  /** The file or command that broke it. */
  subject: string
  detail: string
}

const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec|e2e)\/|(\.|_|-)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i
const SKIP_MARKER =
  /\b(?:it|test|describe|context|suite)\.skip\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip(?:Now)?\s*\(|#\[ignore\]|@Disabled\b|@Ignore\b/

export const isTestFile = (path: string): boolean => TEST_FILE.test(normalizeRelPath(path))

/** The rule breaks a pass's changes made. `allowAgentSettings`: the one explicit exception to self-protection. */
export function checkChanges(
  rules: readonly GuardrailRule[],
  changes: readonly ChangedFile[],
  o: { manifests?: readonly ManifestChange[]; allowAgentSettings?: boolean } = {},
): GuardrailFinding[] {
  const out: GuardrailFinding[] = []
  if (o.allowAgentSettings !== true) {
    for (const c of changes) {
      const hit = pathMatches(c.path, SELF_PROTECTED_PATHS)
      if (hit === undefined) continue
      out.push({
        kind: 'protectedFiles',
        self: true,
        rule: 'Settings files',
        onBreak: 'undo',
        subject: c.path,
        detail: `Runs may not change settings files, so a rule cannot be turned off from inside a run.`,
      })
    }
  }
  for (const rule of rules) {
    const onBreak = onBreakOf(rule)
    const label = describeRule(rule)
    if (rule.kind === 'protectedFiles') {
      for (const c of changes) {
        if (pathMatches(c.path, rule.paths) !== undefined) {
          out.push({
            kind: rule.kind,
            rule: label,
            onBreak,
            subject: c.path,
            detail: `This file is protected.`,
          })
        }
      }
    } else if (rule.kind === 'maxChanges') {
      const lines = changes.reduce((n, c) => n + (c.linesChanged ?? 0), 0)
      if (rule.files !== undefined && changes.length > rule.files) {
        out.push({
          kind: rule.kind,
          rule: label,
          onBreak,
          subject: `${changes.length} files`,
          detail: `The limit is ${rule.files} files.`,
        })
      }
      if (rule.lines !== undefined && lines > rule.lines) {
        out.push({
          kind: rule.kind,
          rule: label,
          onBreak,
          subject: `${lines} lines`,
          detail: `The limit is ${rule.lines} lines.`,
        })
      }
    } else if (rule.kind === 'testsNotWeakened') {
      for (const c of changes) {
        if (!isTestFile(c.path)) continue
        if (c.status === 'deleted') {
          out.push({
            kind: rule.kind,
            rule: label,
            onBreak,
            subject: c.path,
            detail: 'A test file was deleted.',
          })
        } else if ((c.addedLines ?? []).some((l) => SKIP_MARKER.test(l))) {
          out.push({
            kind: rule.kind,
            rule: label,
            onBreak,
            subject: c.path,
            detail: 'A test was marked as skipped.',
          })
        }
      }
    } else if (rule.kind === 'newDependencies') {
      for (const m of o.manifests ?? []) {
        const before = new Set(m.before)
        for (const dep of m.after) {
          if (!before.has(dep)) {
            out.push({ kind: rule.kind, rule: label, onBreak, subject: dep, detail: `New in ${m.path}.` })
          }
        }
      }
    }
  }
  return out
}

/** The rule breaks in the commands a pass reported running. */
export function checkCommands(
  rules: readonly GuardrailRule[],
  commands: readonly string[],
): GuardrailFinding[] {
  const out: GuardrailFinding[] = []
  for (const rule of rules) {
    if (rule.kind !== 'forbiddenCommand') continue
    for (const command of commands) {
      if (commandMatches(command, rule.argvPrefix)) {
        out.push({
          kind: rule.kind,
          rule: describeRule(rule),
          onBreak: onBreakOf(rule),
          subject: command,
          detail: 'This command is forbidden. It had already run when this was found.',
        })
      }
    }
  }
  return out
}

// ---- before a tool runs (where the vendor offers it) ----

/** What a vendor's pre-tool check refuses: the rules that hold on this tool, with the reason the model is told. */
export interface ToolPolicy {
  rules: readonly GuardrailRule[]
  allowAgentSettings: boolean
  /**
   * Other spellings of the run folder, set by core: its real path when the folder was given as a Windows 8.3 short name
   * or under a link (macOS /var is /private/var). A vendor's tool often names the real one; a path under it is read as
   * the same path under the run folder, so a rule never misses a file for how its folder is spelled.
   */
  folderSpellings?: readonly string[]
}

/** `path` spelled from the run folder when it lies under another spelling of it; otherwise as given. */
export function asRunFolder(policy: ToolPolicy, path: string, cwd: string): string {
  if (cwd === '' || !isAbsolutePath(path) || isInside(path, cwd)) return path
  const p = cleanPath(path)
  if (p === undefined) return path
  for (const spelling of policy.folderSpellings ?? []) {
    const root = cleanPath(spelling)
    if (root === undefined || !isInside(p, root)) continue
    return `${cwd.replace(/[\\/]+$/, '')}${p.slice(root.replace(/\/+$/, '').length)}`
  }
  return path
}

/** A tool's path as the rules read it: relative to the folder, or from a settings folder when it is outside the folder. */
export function pathForRules(path: string, cwd: string): string {
  const p = normalizeRelPath(path)
  const root = `${normalizeRelPath(cwd).replace(/\/+$/, '')}/`
  if (p.toLowerCase().startsWith(root.toLowerCase())) return p.slice(root.length)
  const inSettings = /\/(\.(?:claude|codex|gemini|dimfactory)\/.*)$/i.exec(p)
  return inSettings?.[1] ?? p
}

/**
 * A shell command or a file edit about to run. A rule that says ask is left to the check after the pass, where the user
 * can answer; everything else is refused here. Undefined: nothing here refuses it.
 */
export function refuseCommand(policy: ToolPolicy, command: string, cwd = ''): GuardrailFinding | undefined {
  const forbidden = checkCommands(
    policy.rules.filter((r) => onBreakOf(r) !== 'ask'),
    [command],
  )[0]
  // Refused before it runs, so the after-the-fact wording does not apply.
  if (forbidden !== undefined) return { ...forbidden, detail: FORBIDDEN }
  for (const rule of policy.rules) {
    if (rule.kind === 'privateFiles') {
      const named = commandWords(command).find((w) =>
        pathMatches(pathForRules(asRunFolder(policy, w, cwd), cwd), rule.paths),
      )
      if (named !== undefined) return refusal(rule, command, `It names ${named}, a private file.`)
    } else if (rule.kind === 'network') {
      const program = programsIn(command).find((p) => NETWORK_PROGRAMS.has(p))
      if (program !== undefined) return refusal(rule, command, `${program} reaches the network.`)
    }
  }
  return undefined
}

const FORBIDDEN = 'This command is forbidden.'

function refusal(rule: GuardrailRule, subject: string, detail: string): GuardrailFinding {
  return { kind: rule.kind, rule: describeRule(rule), onBreak: onBreakOf(rule), subject, detail }
}

/** Folders outside the run folder an edit tool may still write: the AI tool's own plan files. */
export interface EditContext {
  writable?: readonly string[]
}

export function refuseEdit(
  policy: ToolPolicy,
  path: string,
  cwd: string,
  o: EditContext = {},
): GuardrailFinding | undefined {
  const p = asRunFolder(policy, path, cwd)
  const rel = pathForRules(p, cwd)
  const changed = checkChanges(
    policy.rules.filter((r) => r.kind === 'protectedFiles' && onBreakOf(r) !== 'ask'),
    [{ path: rel, status: 'modified' }],
    { allowAgentSettings: policy.allowAgentSettings },
  )[0]
  if (changed !== undefined) return changed
  const outside = policy.rules.find((r) => r.kind === 'noWritesOutside')
  if (
    outside !== undefined &&
    cwd !== '' &&
    !isInside(p, cwd) &&
    !(o.writable ?? []).some((dir) => isInside(path, dir))
  ) {
    return refusal(outside, path, 'This is outside the folder the run works in.')
  }
  return undefined
}

/** A file or search tool about to read: refused when it names a private file. */
export function refuseRead(policy: ToolPolicy, path: string, cwd: string): GuardrailFinding | undefined {
  const rel = pathForRules(asRunFolder(policy, path, cwd), cwd)
  for (const rule of policy.rules) {
    if (rule.kind === 'privateFiles' && pathMatches(rel, rule.paths) !== undefined)
      return refusal(rule, path, 'This file is private.')
  }
  return undefined
}

/**
 * A content search about to run over a folder (`root`, the run folder when absent): refused when a private file that
 * exists in it would be searched, so its lines cannot come back in the results. `files`: the folder's private files as
 * found when the pass looked (folder-relative). A file-type filter (`type`) or a glob that leaves them out lets it run.
 */
export function refuseSearch(
  policy: ToolPolicy,
  search: { root?: string | undefined; glob?: string | undefined; type?: string | undefined },
  cwd: string,
  files: readonly string[],
): GuardrailFinding | undefined {
  if (search.type !== undefined && search.type !== '') return undefined
  const root = search.root !== undefined && search.root !== '' ? asRunFolder(policy, search.root, cwd) : cwd
  if (!isInside(root, cwd)) return undefined
  // The folder relative to the run folder ('' for the run folder itself), read through a child so the folder's own
  // name is cut off like any path in it.
  const rel = pathForRules(`${root.replace(/[\\/]+$/, '')}/x`, cwd)
    .slice(0, -1)
    .replace(/\/+$/, '')
  const under = (f: string): boolean =>
    rel === '' ||
    rel === '.' ||
    f.toLowerCase() === rel.toLowerCase() ||
    f.toLowerCase().startsWith(`${rel.toLowerCase()}/`)
  for (const rule of policy.rules) {
    if (rule.kind !== 'privateFiles') continue
    const hit = files.find(
      (f) =>
        pathMatches(f, rule.paths) !== undefined &&
        under(f) &&
        (search.glob === undefined || search.glob === '' || pathGlobToRegExp(search.glob).test(f)),
    )
    if (hit !== undefined)
      return refusal(
        rule,
        root,
        `This search would read ${hit}, a private file. Search a narrower folder, or use a glob or file type that leaves it out.`,
      )
  }
  return undefined
}

/** A request to write somewhere the folder's sandbox does not cover: refused while No writes outside is on. */
export function refuseOutsideWrite(policy: ToolPolicy, what: string): GuardrailFinding | undefined {
  const rule = policy.rules.find((r) => r.kind === 'noWritesOutside')
  return rule !== undefined ? refusal(rule, what, 'This is outside the folder the run works in.') : undefined
}

/** A web tool about to run (fetch or search): refused while the network rule is on. */
export function refuseWeb(policy: ToolPolicy, what: string): GuardrailFinding | undefined {
  const rule = policy.rules.find((r) => r.kind === 'network')
  return rule !== undefined ? refusal(rule, what, 'Network access is off for this run.') : undefined
}

/** Programs that only reach the network, refused by name. A package manager or git is not on this list. */
export const NETWORK_PROGRAMS: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
])

/** Every word of a command line that could be a path: options split at `=`, quotes and brackets taken off. */
export function commandWords(line: string): string[] {
  return commandSegments(line)
    .flat()
    .flatMap((w) => w.split(/[=<>,()]/))
    .map((w) => w.replace(/^[`{[$@]+|[`}\];]+$/g, ''))
    .filter((w) => w !== '' && !w.startsWith('-'))
}

/** The programs a command line runs: each simple command's first word, and one opened with `(` or `$(`. */
export function programsIn(line: string): string[] {
  const out: string[] = []
  for (const words of commandSegments(line)) {
    words.forEach((w, i) => {
      const inner = w.lastIndexOf('(')
      if (i === 0) out.push(programName(inner >= 0 ? w.slice(inner + 1) : w))
      else if (inner >= 0 && inner < w.length - 1) out.push(programName(w.slice(inner + 1)))
    })
  }
  return out.filter((p) => p !== '')
}

/** `/` separators, `.` and `..` worked out; undefined when `..` climbs above the root. */
function cleanPath(path: string): string | undefined {
  const p = path.replace(/\\/g, '/')
  const unc = p.startsWith('//')
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }
  const lead = unc ? '//' : p.startsWith('/') ? '/' : ''
  return lead + parts.join('/')
}

const isAbsolutePath = (p: string): boolean => /^(?:[a-zA-Z]:)?[\\/]/.test(p) || /^[a-zA-Z]:$/.test(p)

/**
 * Whether a path is the folder or inside it. A relative path is read from the folder. Case is ignored for a Windows
 * folder (a drive letter or a network share); elsewhere a path spelled with other case counts as outside.
 */
export function isInside(path: string, folder: string): boolean {
  const f = cleanPath(folder)
  const p = cleanPath(isAbsolutePath(path) ? path : `${folder}/${path}`)
  if (f === undefined || p === undefined) return false
  const windows = /^[a-zA-Z]:/.test(f) || f.startsWith('//')
  const a = windows ? p.toLowerCase() : p
  const b = (windows ? f.toLowerCase() : f).replace(/\/+$/, '')
  return a === b || a.startsWith(`${b}/`)
}

// ---- before a run starts --------------------------------------------------------------------------------------------

/** What a run is about to do, for the rules that hold before anything starts. */
export interface RunPlanFacts {
  vendors: readonly string[]
  fullAccess: boolean
  isolated: boolean
  extensionsInUse: readonly string[]
  /** Each enabled pass's vendor, and whether it approves everything. Absent: every vendor at `fullAccess`. */
  passes?: readonly { vendor: string; fullAccess: boolean }[]
}

export interface GuardrailBlock {
  kind: GuardrailKind
  rule: string
  detail: string
}

/** Why this run may not start: the hard rules it breaks, and rules that cannot reach the strength they require. */
export function checkRunPlan(rules: readonly GuardrailRule[], facts: RunPlanFacts): GuardrailBlock[] {
  const out: GuardrailBlock[] = []
  for (const rule of rules) {
    const label = describeRule(rule)
    if (rule.kind === 'allowedVendors') {
      const allowed = new Set(rule.vendors.map((v) => v.toLowerCase()))
      const other = facts.vendors.filter((v) => !allowed.has(v.toLowerCase()))
      if (other.length > 0) {
        out.push({ kind: rule.kind, rule: label, detail: `This run would use ${other.join(', ')}.` })
      }
    } else if (rule.kind === 'noFullAccess' && facts.fullAccess) {
      out.push({ kind: rule.kind, rule: label, detail: 'This run would approve everything.' })
    } else if (rule.kind === 'requireIsolated' && !facts.isolated) {
      out.push({ kind: rule.kind, rule: label, detail: 'This run would work directly in your folder.' })
    } else if (rule.kind === 'noExtensions' && facts.extensionsInUse.length > 0) {
      out.push({
        kind: rule.kind,
        rule: label,
        detail: `Passes using extensions: ${facts.extensionsInUse.join(', ')}.`,
      })
    }
    const want = 'require' in rule ? rule.require : undefined
    if (want !== undefined) {
      for (const { vendor, have } of strengthsFor(rule, facts)) {
        if (!strengthAtLeast(have, want)) {
          out.push({
            kind: rule.kind,
            rule: label,
            detail:
              have === 'none'
                ? `You required this to be ${want}. ${vendorName(vendor)} cannot keep it at all.`
                : `You required this to be ${want}. With ${vendor} it can only be ${have}.`,
          })
        }
      }
    }
  }
  return out
}

const vendorName = (v: string): string => (v === '' ? v : `${v[0]?.toUpperCase() ?? ''}${v.slice(1)}`)

/** Each vendor's strength for a rule in this run, one per vendor and strength (a pass that approves everything counts apart). */
function strengthsFor(
  rule: GuardrailRule,
  facts: RunPlanFacts,
): { vendor: string; have: GuardrailStrength }[] {
  const passes = facts.passes ?? facts.vendors.map((vendor) => ({ vendor, fullAccess: facts.fullAccess }))
  const seen = new Set<string>()
  const out: { vendor: string; have: GuardrailStrength }[] = []
  for (const p of passes) {
    const have = strengthOf(rule.kind, p.vendor, { fullAccess: p.fullAccess })
    const key = `${p.vendor}|${have}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ vendor: p.vendor, have })
  }
  return out
}

/**
 * Rules this run cannot keep on a vendor it uses, when they do not require a strength (one that does is refused by
 * checkRunPlan instead). The run may start; preflight warns so nobody trusts a rule that does nothing there.
 */
export function guardrailWarnings(rules: readonly GuardrailRule[], facts: RunPlanFacts): GuardrailBlock[] {
  const out: GuardrailBlock[] = []
  for (const rule of rules) {
    if ('require' in rule && rule.require !== undefined) continue
    const cannot = [
      ...new Set(
        strengthsFor(rule, facts)
          .filter((s) => s.have === 'none')
          .map((s) => s.vendor),
      ),
    ]
    if (cannot.length === 0) continue
    const fullOnly = (facts.passes ?? []).some(
      (p) => cannot.includes(p.vendor) && strengthOf(rule.kind, p.vendor) !== 'none',
    )
    out.push({
      kind: rule.kind,
      rule: describeRule(rule),
      detail: `${cannot.map(vendorName).join(' and ')} cannot keep this rule${fullOnly ? ' while it approves everything' : ''}, so it does nothing there.`,
    })
  }
  return out
}

// ---- Test this rule (free, the same code as the real checks) ----------------------------------------------------------

export type RuleTest = { path: string } | { command: string }

export interface RuleTestResult {
  rule: string
  applies: boolean
  strength: GuardrailStrength
  outcome: string
}

/** The check-time wording for a vendor: refused first where it holds, found later everywhere else. */
function whenFound(kind: GuardrailKind, vendor: string | undefined, later: string): string {
  return strengthOf(kind, vendor) === 'blocked' ? 'Refused before it runs.' : later
}

/** The wording for a rule only some tools can keep: where it holds, and where it does nothing. */
function whereHeld(kind: GuardrailKind, vendor: string | undefined): string {
  if (vendor !== undefined) {
    const s = strengthOf(kind, vendor)
    if (s === 'none') return 'This AI tool cannot keep this rule.'
    return s === 'sandboxed' ? "Refused by the AI tool's sandbox." : 'Refused before it runs.'
  }
  const held = Object.entries(GUARDRAIL_INFO[kind].byVendor ?? {}).map(([v]) => vendorName(v))
  return `Refused on ${held.join(' and ')}. Other AI tools cannot keep this rule.`
}

export function testRules(
  rules: readonly GuardrailRule[],
  input: RuleTest,
  vendor?: string,
): RuleTestResult[] {
  const out: RuleTestResult[] = []
  if ('path' in input) {
    const self = pathMatches(input.path, SELF_PROTECTED_PATHS) !== undefined
    if (self) {
      out.push({
        rule: 'Settings files',
        applies: true,
        strength: 'caught',
        outcome: 'Found when the pass ends, and undone. Always on.',
      })
    }
    for (const rule of rules) {
      if (rule.kind === 'privateFiles') {
        const applies = pathMatches(input.path, rule.paths) !== undefined
        out.push({
          rule: describeRule(rule),
          applies,
          strength: strengthOf(rule.kind, vendor),
          outcome: applies ? `Reading it: ${whereHeld(rule.kind, vendor)}` : 'Does not cover this path.',
        })
        continue
      }
      if (rule.kind !== 'protectedFiles') continue
      const applies = pathMatches(input.path, rule.paths) !== undefined
      out.push({
        rule: describeRule(rule),
        applies,
        strength: strengthOf(rule.kind, vendor),
        outcome: applies
          ? `${whenFound(rule.kind, vendor, 'Found when the pass ends.')} Then: ${onBreakOf(rule)}.`
          : 'Does not cover this path.',
      })
    }
  } else {
    // The same check a tool's command gets before it runs; the folder is unknown here, so paths read as written.
    const policy: ToolPolicy = { rules, allowAgentSettings: false }
    for (const rule of rules) {
      if (rule.kind === 'privateFiles' || rule.kind === 'network') {
        const hit = refuseCommand({ ...policy, rules: [rule] }, input.command)
        out.push({
          rule: describeRule(rule),
          applies: hit !== undefined,
          strength: strengthOf(rule.kind, vendor),
          outcome:
            hit !== undefined
              ? `${hit.detail} ${whereHeld(rule.kind, vendor)}`
              : 'Does not match this command.',
        })
        continue
      }
      if (rule.kind !== 'forbiddenCommand') continue
      const applies = commandMatches(input.command, rule.argvPrefix)
      out.push({
        rule: describeRule(rule),
        applies,
        strength: strengthOf(rule.kind, vendor),
        outcome: applies
          ? `${whenFound(rule.kind, vendor, 'Found after it runs, when the AI tool reports it.')} Then: ${onBreakOf(rule)}.`
          : 'Does not match this command.',
      })
    }
  }
  return out
}

// ---- suggestions from the project, no model call ----------------------------------------------------------------------

export interface GuardrailSuggestion {
  rule: GuardrailRule
  reason: string
}

/** Rules worth offering for a project, from the paths in it. Each has a one-line reason and is never applied unasked. */
export function suggestGuardrails(paths: readonly string[]): GuardrailSuggestion[] {
  const has = (re: RegExp): boolean => paths.some((p) => re.test(normalizeRelPath(p)))
  const out: GuardrailSuggestion[] = []
  const protect = (glob: string, reason: string): void => {
    out.push({ rule: { kind: 'protectedFiles', paths: [glob] }, reason })
  }
  // Only the name is looked at: whether the file holds secrets is never read.
  if (has(/(^|\/)\.env(\.[^/]*)?$/i)) {
    out.push({
      rule: { kind: 'privateFiles', paths: ['.env*'] },
      reason: 'Environment files usually hold keys and passwords.',
    })
  }
  if (has(/(^|\/)migrations\//i))
    protect('migrations/**', 'Database migrations are hard to take back once applied.')
  if (has(/^\.github\/workflows\//i)) protect('.github/**', 'Workflows run with your repository credentials.')
  if (has(/(^|\/)terraform\/|\.tf$/i)) {
    protect('terraform/**', 'Infrastructure changes can affect live systems.')
    out.push({
      rule: { kind: 'forbiddenCommand', argvPrefix: ['terraform', 'apply'] },
      reason: 'Applying changes live systems straight away.',
    })
  }
  if (has(/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock)$/i)) {
    out.push({
      rule: { kind: 'newDependencies' },
      reason: 'Your project pins its packages, so a new one is worth a look.',
    })
  }
  return out
}

// ---- proof and loosening --------------------------------------------------------------------------------------------

/** The rules Prove it can run: the ones a real Claude session can be asked to break harmlessly in a temp folder. */
export const PROVE_KINDS = ['protectedFiles', 'forbiddenCommand', 'privateFiles'] as const
export type ProveKind = (typeof PROVE_KINDS)[number]

/**
 * One Prove it result. `held`: the AI tool tried and was refused. `broken`: it got through. `unclear`: it never tried,
 * so nothing was shown either way. `version`: the CLI it ran on; a different version now needs a re-test.
 */
export interface GuardrailProof {
  kind: ProveKind
  vendor: string
  result: 'held' | 'broken' | 'unclear'
  at: number
  version: string | null
  model: string | null
  detail: string
}

/** A rule taken away or a preset lowered in Settings, as trust.json records it. */
export interface GuardrailLoosening {
  at: number
  what: string
}

/** Settings > Guardrails: the last proof of each rule, the CLI version now, and the loosenings on record. */
export interface GuardrailsState {
  proofs: GuardrailProof[]
  /** The Claude CLI's version now (null: not known). */
  version: string | null
  loosened: GuardrailLoosening[]
}

/** A proof made on another CLI version than the one installed now. */
export const proofNeedsRetest = (p: GuardrailProof, version: string | null): boolean =>
  version !== null && p.version !== version

const PRESET_LABEL: Record<GuardrailPreset, string> = {
  off: 'Off',
  recommended: 'Recommended',
  strict: 'Strict',
}

/** What a change to your own guardrails took away, in words; empty when it only tightened or kept them. */
export function loosenedBetween(
  before: { [K in keyof Guardrails]?: Guardrails[K] | undefined },
  after: { [K in keyof Guardrails]?: Guardrails[K] | undefined },
): string[] {
  const out: string[] = []
  const from = before.preset ?? GUARDRAILS_DEFAULT.preset
  const to = after.preset ?? GUARDRAILS_DEFAULT.preset
  if (PRESET_RANK[to] < PRESET_RANK[from])
    out.push(`Preset lowered from ${PRESET_LABEL[from]} to ${PRESET_LABEL[to]}`)
  const kept = new Set((after.rules ?? []).map(ruleKey))
  for (const rule of before.rules ?? []) {
    if (!kept.has(ruleKey(rule))) out.push(`Removed ${describeRule(rule)}`)
  }
  if (before.allowAgentSettings !== true && after.allowAgentSettings === true)
    out.push('Runs may change agent settings files')
  return out
}

/** Where a rule in force comes from, for a project's view of its guardrails. */
export type GuardrailSource = 'always' | 'preset' | 'user' | 'project'

export interface GuardrailInForce {
  label: string
  kind: GuardrailKind | 'self'
  from: GuardrailSource
}

/**
 * Every rule in force for a folder and where it comes from: `user` is your own file's guardrails (with the built-in
 * preset), `merged` what the folder resolves to. A rule in both is yours; one only in `merged` is the project's. The
 * preset's rules name the preset, and it is the project's when it raised the preset. Settings files come first, always.
 */
export function guardrailsInForce(
  user: Guardrails,
  merged: Guardrails,
): { preset: GuardrailPreset; presetFrom: 'user' | 'project'; rules: GuardrailInForce[] } {
  const presetFrom = merged.preset === user.preset ? 'user' : 'project'
  const out: GuardrailInForce[] = [{ label: 'Settings files', kind: 'self', from: 'always' }]
  const seen = new Set<string>()
  for (const rule of presetRules(merged.preset)) {
    seen.add(ruleKey(rule))
    out.push({ label: describeRule(rule), kind: rule.kind, from: 'preset' })
  }
  const mine = new Set(user.rules.map(ruleKey))
  for (const rule of merged.rules) {
    const key = ruleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: describeRule(rule), kind: rule.kind, from: mine.has(key) ? 'user' : 'project' })
  }
  return { preset: merged.preset, presetFrom, rules: out }
}
