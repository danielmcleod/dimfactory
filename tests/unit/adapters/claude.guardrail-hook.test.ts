// Dim Factory's own PreToolUse hook: what it refuses, what it lets through, and that it fails closed. The real CLI's
// behaviour (the hook fires under Approve everything, on PowerShell, in subagents and with disableAllHooks) was measured
// live on 2.1.289.
import { describe, expect, it } from 'vitest'
import { ClaudeNormalizer, GUARDRAIL_HOOK_ID, guardrailHookMatcher } from '@core/adapters/claude/normalize.ts'
import type { GuardrailRule } from '@shared/guardrails.ts'
import { pathForRules, presetRules } from '@shared/guardrails.ts'

const CWD = 'C:\\work\\app'

function fire(
  rules: readonly GuardrailRule[] | undefined,
  input: unknown,
  o: { allowAgentSettings?: boolean; callback?: string } = {},
): { answer: string; signals: { type: string }[] } {
  const n = new ClaudeNormalizer({
    route: 'edit',
    askTimeoutMs: 600_000,
    now: () => 0,
    cwd: CWD,
    configDir: 'C:\\Users\\me\\.claude',
    ...(rules !== undefined
      ? { guardrails: { rules, allowAgentSettings: o.allowAgentSettings === true } }
      : {}),
  })
  const step = n.line(
    JSON.stringify({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'hook_callback', callback_id: o.callback ?? GUARDRAIL_HOOK_ID, input },
    }),
  )
  return { answer: JSON.stringify(step.stdin), signals: step.signals }
}

const bash = (command: string): unknown => ({ tool_name: 'Bash', tool_input: { command } })
const write = (file_path: string): unknown => ({ tool_name: 'Write', tool_input: { file_path } })

describe('the guardrail hook', () => {
  it('refuses a forbidden command, tells the model and reports it', () => {
    const r = fire(presetRules('recommended'), bash('git add . && git push origin main'))
    expect(r.answer).toContain('"permissionDecision":"deny"')
    expect(r.answer).toContain('git push')
    expect(r.signals.map((s) => s.type)).toEqual(['guardrail-blocked'])
  })

  it('refuses a forbidden command on a later line', () => {
    expect(fire(presetRules('recommended'), bash('git add .\ngit push')).answer).toContain('deny')
  })

  it('lets an ordinary command through with nothing added', () => {
    const r = fire(presetRules('recommended'), bash('npm test'))
    expect(r.answer).not.toContain('deny')
    expect(r.signals.filter((s) => s.type !== 'liveness')).toEqual([])
  })

  it('refuses an edit to a settings file, in the folder and outside it', () => {
    expect(fire([], write('C:\\work\\app\\.claude\\settings.json')).answer).toContain('deny')
    expect(fire([], write('C:\\Users\\someone\\.claude\\settings.json')).answer).toContain('deny')
    expect(fire([], write('C:\\work\\app\\.dimfactory\\dimfactory.json')).answer).toContain('deny')
  })

  it('leaves instruction files editable', () => {
    expect(fire([], write('C:\\work\\app\\CLAUDE.md')).answer).not.toContain('deny')
  })

  it('honours the explicit settings exception', () => {
    const r = fire([], write('C:\\work\\app\\.claude\\settings.json'), { allowAgentSettings: true })
    expect(r.answer).not.toContain('deny')
  })

  it('refuses an edit to a protected file', () => {
    const rules: GuardrailRule[] = [{ kind: 'protectedFiles', paths: ['migrations/**'] }]
    expect(fire(rules, write('C:\\work\\app\\migrations\\1.sql')).answer).toContain('deny')
    expect(fire(rules, write('C:\\work\\app\\src\\a.ts')).answer).not.toContain('deny')
  })

  it('leaves a rule that says ask for the check after the pass', () => {
    const rules: GuardrailRule[] = [{ kind: 'protectedFiles', paths: ['a.ts'], onBreak: 'ask' }]
    expect(fire(rules, write('C:\\work\\app\\a.ts')).answer).not.toContain('deny')
  })

  it('fails closed: a callback it cannot read is refused', () => {
    expect(fire([], {}).answer).toContain('deny')
    expect(fire([], null).answer).toContain('deny')
    expect(fire(undefined, bash('ls')).answer).toContain('deny')
  })
})

describe('the hook on reads, outside writes and the web', () => {
  const read = (tool: string, args: object): unknown => ({ tool_name: tool, tool_input: args })
  const PRIVATE: GuardrailRule[] = [{ kind: 'privateFiles', paths: ['.env*'] }]

  it('refuses a read, a search or a listing that names a private file', () => {
    expect(fire(PRIVATE, read('Read', { file_path: 'C:\\work\\app\\.env' })).answer).toContain('deny')
    expect(fire(PRIVATE, read('Grep', { pattern: 'KEY', path: '.env' })).answer).toContain('deny')
    expect(fire(PRIVATE, read('Grep', { pattern: 'KEY', glob: '.env*' })).answer).toContain('deny')
    expect(fire(PRIVATE, read('Glob', { pattern: '**/.env*' })).answer).toContain('deny')
    const r = fire(PRIVATE, bash('cat .env'))
    expect(r.answer).toContain('private file')
    expect(r.signals.map((s) => s.type)).toEqual(['guardrail-blocked'])
  })

  it('lets other reads through, and a search pattern is not a path', () => {
    expect(fire(PRIVATE, read('Read', { file_path: 'C:\\work\\app\\src\\a.ts' })).answer).not.toContain(
      'deny',
    )
    expect(fire(PRIVATE, read('Grep', { pattern: '.env', path: 'src' })).answer).not.toContain('deny')
  })

  it('refuses an edit outside the folder but not a Claude plan file', () => {
    const rules: GuardrailRule[] = [{ kind: 'noWritesOutside' }]
    expect(fire(rules, write('C:\\Users\\me\\Desktop\\x.txt')).answer).toContain('deny')
    expect(fire(rules, write('C:\\Users\\me\\.claude\\plans\\p.md')).answer).not.toContain('deny')
    expect(fire(rules, write('C:\\work\\app\\src\\a.ts')).answer).not.toContain('deny')
  })

  it('refuses web tools and network programs under the network rule', () => {
    const rules: GuardrailRule[] = [{ kind: 'network', allow: false }]
    expect(fire(rules, read('WebFetch', { url: 'https://example.com' })).answer).toContain('deny')
    expect(fire(rules, read('WebSearch', { query: 'x' })).answer).toContain('deny')
    expect(fire(rules, bash('curl https://example.com')).answer).toContain('deny')
    expect(fire(rules, bash('npm install')).answer).not.toContain('deny')
  })

  it('registers for reads and web tools only when a rule needs them', () => {
    const p = (rules: GuardrailRule[]) => guardrailHookMatcher({ rules, allowAgentSettings: false })
    expect(p([])).toBe('Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit')
    expect(p(PRIVATE)).toContain('|Read|Grep|Glob|NotebookRead')
    expect(p([{ kind: 'network', allow: false }])).toContain('|WebFetch|WebSearch')
  })
})

describe('a path as the rules read it', () => {
  it('is relative to the folder, whatever the case', () => {
    expect(pathForRules('C:\\Work\\App\\src\\a.ts', CWD)).toBe('src/a.ts')
  })
  it('starts at a settings folder when it is outside', () => {
    expect(pathForRules('/home/x/.codex/config.toml', '/work/app')).toBe('.codex/config.toml')
  })
})
