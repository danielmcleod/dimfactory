// Read-only Codex passes switch the user's MCP servers off by name: the config.toml reader (names only), the keys a
// read-only pass sends (thread/start config, exec `-c`) and never on Implement or Fix, the guard against a name that
// would address another key, the redaction of the names, and the copy (off only when every server was switched off).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_SERVER_COPY,
  CATALOG_COPY,
  MCP_NOTE,
  MCP_OFF_NOTE,
  PLAN_NATIVE_COPY,
  WIN_SANDBOX_READONLY_COPY,
  codexSupport,
  defaultFacts,
  mcpCopy,
} from '@core/adapters/codex/capabilities.ts'
import { createCodexAdapter } from '@core/adapters/codex/index.ts'
import { execArgv, mcpOffKeys } from '@core/adapters/codex/launch.ts'
import {
  codexMcpIsolation,
  codexMcpServerNames,
  isSafeServerName,
  mcpNameRedactor,
  parseCodexMcpServers,
  projectConfigPaths,
} from '@core/adapters/codex/mcp-isolation.ts'
import { threadResumeParams, threadStartParams } from '@core/adapters/codex/params.ts'
import type { StartStep } from '@core/adapters/types.ts'
import type { ReadinessNeed } from '@shared/vendors.ts'

const READ_ONLY: StartStep[] = ['plan', 'review', 'critic', 'heal', 'catalog']
const MUTATING: StartStep[] = ['implement', 'fix']
const temp = (p = 'codex-mcp-'): string => mkdtempSync(join(tmpdir(), p))

/** A temp CODEX_HOME with this config.toml (never the developer's ~/.codex). */
function codexHome(toml: string | undefined): string {
  const home = temp('codex-mcp-home-')
  if (toml !== undefined) writeFileSync(join(home, 'config.toml'), toml)
  return home
}

describe('the config.toml reader (server names only)', () => {
  it('table headers: bare and quoted names, sub-tables, trailing comments, other tables ignored', () => {
    const toml = [
      '[mcp_servers.sample_repl]',
      'command = "x"',
      '[mcp_servers.sample_repl.env]',
      'A = "1"',
      '[mcp_servers."my server"]',
      'url = "y"',
      "[ mcp_servers . 'single' ] # a comment",
      'url = "z"',
      '[profiles.fast]',
      'model = "m"',
      '[projects."C:\\\\work"]',
      'trust_level = "trusted"',
    ].join('\n')
    expect(parseCodexMcpServers(toml)).toEqual({ names: ['sample_repl', 'my server', 'single'], ok: true })
  })

  it('the [mcp_servers] table and top-level dotted keys', () => {
    const toml = [
      'model = "gpt"',
      'mcp_servers.top.command = "a"',
      'mcp_servers.inl = { command = "a2" }',
      '[mcp_servers]',
      'inline = { command = "b" }',
      'dotted.command = "c"',
      '"quoted-key" = { url = "d" }',
      '[profiles.fast]',
      'mcp_servers.not_root.command = "e"',
    ].join('\r\n')
    expect(parseCodexMcpServers(toml)).toEqual({
      names: ['top', 'inl', 'inline', 'dotted', 'quoted-key'],
      ok: true,
    })
  })

  it('comments, multi-line strings, multi-line arrays and inline tables are not keys', () => {
    const toml = [
      '# [mcp_servers.commented]',
      '   # mcp_servers.also_commented.command = "x"',
      'instructions = """',
      '[mcp_servers.in_a_string]',
      'mcp_servers.in_a_string_too.command = "x"',
      '"""',
      "notes = '''",
      '[mcp_servers.literal_string]',
      "'''",
      '[mcp_servers]',
      'real.args = [',
      '  "--port=3000",',
      '  "x = 1",',
      ']',
      'spread = {',
      '  command = "y",',
      '  args = ["a", "b"],',
      '}',
      'after = { command = "z" } # mcp_servers.trailing',
    ].join('\n')
    expect(parseCodexMcpServers(toml)).toEqual({ names: ['real', 'spread', 'after'], ok: true })
    expect(codexMcpServerNames('')).toEqual([])
  })

  it('a shape it does not follow is reported, never guessed at', () => {
    for (const toml of [
      'mcp_servers = { a = { command = "x" } }',
      '[[mcp_servers.arr]]\ncommand = "x"',
      '[mcp_servers."esc\\"aped"]\ncommand = "x"',
      '[mcp_servers]\n"esc\\"aped" = { command = "x" }',
      '"mcp_servers".q.command = "x"',
      'text = """\nnever closed',
      'arr = [\n  "never closed"',
    ]) {
      expect(parseCodexMcpServers(toml).ok, toml).toBe(false)
    }
  })

  it('names safe as one bare key segment', () => {
    for (const n of ['a', 'sample_repl', 'my-server-2', 'A_B'.repeat(10)])
      expect(isSafeServerName(n), n).toBe(true)
    for (const n of ['', 'my server', 'a.b', 'a"b', "a'b", 'a=b', 'a]b', 'ü', 'x\ny', 'a'.repeat(129)])
      expect(isSafeServerName(n), n).toBe(false)
  })
})

describe('codexMcpIsolation (CODEX_HOME aware, names in memory only)', () => {
  it('reads config.toml under CODEX_HOME: every server named, isolation complete', () => {
    const home = codexHome('[mcp_servers.alpha]\ncommand = "a"\n[mcp_servers.beta-2]\nurl = "b"\n')
    expect(codexMcpIsolation({ env: { CODEX_HOME: home }, home: temp() })).toEqual({
      names: ['alpha', 'beta-2'],
      complete: true,
    })
  })

  it('without CODEX_HOME, ~/.codex under the given home', () => {
    const home = temp('codex-mcp-user-')
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'mcp_servers.gamma.command = "g"\n')
    expect(codexMcpIsolation({ env: {}, home })).toEqual({ names: ['gamma'], complete: true })
  })

  it('no config.toml: nothing to switch off, complete', () => {
    expect(codexMcpIsolation({ env: { CODEX_HOME: codexHome(undefined) } })).toEqual({
      names: [],
      complete: true,
    })
  })

  it('a config.toml that cannot be read: incomplete (the copy keeps saying servers may load)', () => {
    const home = codexHome(undefined)
    mkdirSync(join(home, 'config.toml')) // a folder where the file should be: EISDIR
    expect(codexMcpIsolation({ env: { CODEX_HOME: home } })).toEqual({ names: [], complete: false })
    const denied = (): string => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    expect(codexMcpIsolation({ env: { CODEX_HOME: home }, read: denied })).toEqual({
      names: [],
      complete: false,
    })
  })

  it('a shape the reader does not follow, or a name unsafe as a key: the safe ones only, incomplete', () => {
    const unsafe = codexHome('[mcp_servers.ok]\ncommand = "x"\n[mcp_servers."has space"]\ncommand = "y"\n')
    expect(codexMcpIsolation({ env: { CODEX_HOME: unsafe } })).toEqual({ names: ['ok'], complete: false })
    const odd = codexHome('[mcp_servers.ok]\ncommand = "x"\n[[mcp_servers.arr]]\n')
    expect(codexMcpIsolation({ env: { CODEX_HOME: odd } })).toEqual({ names: ['ok'], complete: false })
  })

  it('a project config in the pass folder (up to the git root) that defines servers leaves it incomplete', () => {
    const home = codexHome('[mcp_servers.alpha]\ncommand = "a"\n')
    const repo = temp('codex-mcp-repo-')
    mkdirSync(join(repo, '.git'))
    const cwd = join(repo, 'pkg', 'sub')
    mkdirSync(cwd, { recursive: true })
    const env = { CODEX_HOME: home }
    expect(codexMcpIsolation({ env, cwd })).toEqual({ names: ['alpha'], complete: true })
    // A project config without servers changes nothing.
    mkdirSync(join(repo, '.codex'))
    writeFileSync(join(repo, '.codex', 'config.toml'), 'model = "gpt"\n')
    expect(codexMcpIsolation({ env, cwd })).toEqual({ names: ['alpha'], complete: true })
    // One that defines a server: Codex loads it only for a trusted project, so it is never named (a name the loaded
    // config lacks fails the pass), and the copy stays honest.
    writeFileSync(join(repo, '.codex', 'config.toml'), '[mcp_servers.project_srv]\ncommand = "p"\n')
    expect(codexMcpIsolation({ env, cwd })).toEqual({ names: ['alpha'], complete: false })
    // Without a cwd (a vendor card) only the user's file decides.
    expect(codexMcpIsolation({ env })).toEqual({ names: ['alpha'], complete: true })
  })

  it('project config paths: the folder up to the git root, or the folder alone outside a repository', () => {
    const root = resolve('/r')
    const isRoot = (d: string): boolean => d === root
    const cwd = join(root, 'a', 'b')
    expect(projectConfigPaths(cwd, isRoot)).toEqual(
      [cwd, join(root, 'a'), root].map((d) => join(d, '.codex', 'config.toml')),
    )
    expect(projectConfigPaths(cwd, () => false)).toEqual([join(cwd, '.codex', 'config.toml')])
  })
})

describe('what a pass sends', () => {
  const names = ['alpha', 'beta-2']

  it('read-only steps: thread/start config and exec -c switch each server off', () => {
    for (const step of READ_ONLY) {
      const p = threadStartParams({ step, mode: 'readonly', cwd: '/w', mcpOff: names })
      expect(p.config, step).toMatchObject({
        'mcp_servers.alpha.enabled': false,
        'mcp_servers.beta-2.enabled': false,
      })
      const argv = execArgv({ step, mode: 'readonly', cwd: '/w', outFile: '/o', mcpOff: names })
      const at = argv.indexOf('mcp_servers.alpha.enabled=false')
      expect(argv[at - 1], step).toBe('-c')
      expect(argv[argv.indexOf('mcp_servers.beta-2.enabled=false') - 1]).toBe('-c')
      // Every flag before `resume` and the stdin marker.
      expect(at).toBeLessThan(argv.indexOf('-o'))
    }
  })

  it('Implement and Fix keep the user servers, whatever their mode', () => {
    for (const step of MUTATING) {
      for (const mode of ['readonly', 'autoedit', 'full'] as const) {
        const p = threadStartParams({ step, mode, cwd: '/w', mcpOff: names })
        expect(JSON.stringify(p), `${step} ${mode}`).not.toContain('mcp_servers')
        const r = threadResumeParams('t', { step, mode, cwd: '/w', mcpOff: names })
        expect(JSON.stringify(r)).not.toContain('mcp_servers')
        const argv = execArgv({ step, mode, cwd: '/w', outFile: '/o', resumeId: 't', mcpOff: names })
        expect(argv.join(' ')).not.toContain('mcp_servers')
      }
    }
  })

  it('nothing to switch off: no mcp_servers entry, only the feature switches of a read-only pass', () => {
    expect(threadStartParams({ step: 'review', mode: 'readonly', cwd: '/w', mcpOff: [] }).config).toEqual(
      FEATURES_OFF,
    )
    expect(threadStartParams({ step: 'review', mode: 'readonly', cwd: '/w' }).config).toEqual(FEATURES_OFF)
    expect(threadStartParams({ step: 'catalog', mode: 'readonly', cwd: '/w', mcpOff: [] }).config).toEqual({
      web_search: 'live',
      ...FEATURES_OFF,
    })
  })

  it('a name that would address another key is never sent (no injection)', () => {
    const evil = [
      'ok',
      'x.enabled=true',
      'a.b',
      'sandbox_mode="danger-full-access"',
      'z = 1\nsandbox_mode',
      '"quoted"',
      'x]\n[permissions',
      'sp ace',
      '',
    ]
    expect(mcpOffKeys('review', evil)).toEqual(['mcp_servers.ok.enabled'])
    const config = threadStartParams({ step: 'review', mode: 'readonly', cwd: '/w', mcpOff: evil }).config
    expect(config).toEqual({ 'mcp_servers.ok.enabled': false, ...FEATURES_OFF })
    const argv = execArgv({ step: 'review', mode: 'readonly', cwd: '/w', outFile: '/o', mcpOff: evil })
    const overrides = argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []))
    expect(overrides.filter((c) => c.startsWith('mcp_servers'))).toEqual(['mcp_servers.ok.enabled=false'])
    expect(argv.join(' ')).not.toMatch(/sandbox_mode|permissions|enabled=true/)
    // Duplicates are sent once.
    expect(mcpOffKeys('critic', ['ok', 'ok'])).toEqual(['mcp_servers.ok.enabled'])
  })

  it('a malicious name in config.toml goes no further than the reader', () => {
    const home = codexHome(
      ['[mcp_servers."x.enabled=true"]', 'command = "x"', '[mcp_servers.good]', 'command = "y"'].join('\n'),
    )
    const iso = codexMcpIsolation({ env: { CODEX_HOME: home } })
    expect(iso).toEqual({ names: ['good'], complete: false })
    expect(
      threadStartParams({ step: 'plan', mode: 'readonly', cwd: '/w', mcpOff: iso.names }).config,
    ).toEqual({
      'mcp_servers.good.enabled': false,
      ...FEATURES_OFF,
    })
  })
})

/** What a read-only pass also switches off: Codex's apps, plugins and hooks (launch.ts featuresOffKeys). */
const FEATURES_OFF = { 'features.apps': false, 'features.plugins': false, 'features.hooks': false }

describe('redaction of the switched-off names', () => {
  it('argv, the thread/start frame and Codex errors that quote the key', () => {
    const redact = mcpNameRedactor(['alpha', 'alpha-long'])
    const argv = execArgv({
      step: 'review',
      mode: 'readonly',
      cwd: '/w',
      outFile: '/o',
      mcpOff: ['alpha', 'alpha-long'],
    })
    const shown = argv.map(redact).join(' ')
    expect(shown).not.toMatch(/alpha/)
    expect(shown).toContain('mcp_servers.[REDACTED].enabled=false')
    const frame = JSON.stringify(
      threadStartParams({ step: 'review', mode: 'readonly', cwd: '/w', mcpOff: ['alpha', 'alpha-long'] }),
    )
    expect(redact(frame)).not.toMatch(/alpha/)
    expect(redact('invalid transport in `mcp_servers.alpha`')).toBe(
      'invalid transport in `mcp_servers.[REDACTED]`',
    )
    // Only the key is touched: other text, and a longer name that was not switched off, stay.
    expect(redact('mcp_servers.alphabet and alpha')).toBe('mcp_servers.alphabet and alpha')
    expect(mcpNameRedactor([])('mcp_servers.alpha')).toBe('mcp_servers.alpha')
  })
})

describe('the copy', () => {
  const need = (
    pass: ReadinessNeed['pass'],
    mode: ReadinessNeed['mode'],
    o: Partial<ReadinessNeed> = {},
  ) => ({
    pass,
    mode,
    planNative: false,
    trustFolder: false,
    ...o,
  })
  const facts = defaultFacts('linux')

  it('isolation applied: every read-only copy says the config.toml servers are off; edit passes unchanged', () => {
    const off = [
      codexSupport(need('review', 'readonly'), facts, true),
      codexSupport(need('critic', 'autoedit'), facts, true),
      codexSupport(need('plan', 'readonly', { planNative: true }), facts, true),
      codexSupport(need('plan', 'readonly'), { ...facts, route: 'exec', planNative: false }, true),
      codexSupport(need('catalog', 'readonly'), facts, true),
      codexSupport(need('heal', 'readonly'), defaultFacts('win32'), true),
      codexSupport(need('review', 'readonly'), { ...facts, winSandbox: 'notConfigured' }, true),
    ]
    for (const s of off) {
      expect(s.copy.endsWith(` ${MCP_OFF_NOTE}`), s.copy).toBe(true)
      expect(s.copy).not.toContain(MCP_NOTE)
    }
    expect(off[0]?.copy).toBe(mcpCopy(APP_SERVER_COPY.readonly, true))
    expect(off[2]?.copy).toBe(mcpCopy(PLAN_NATIVE_COPY, true))
    expect(off[4]?.copy).toBe(mcpCopy(CATALOG_COPY, true))
    expect(off[6]?.copy).toBe(mcpCopy(WIN_SANDBOX_READONLY_COPY, true))
    // Implement in read-only mode keeps the user's servers, and says so.
    expect(codexSupport(need('implement', 'readonly'), facts, true).copy).toBe(APP_SERVER_COPY.readonly)
    expect(codexSupport(need('implement', 'autoedit'), facts, true).copy).toBe(APP_SERVER_COPY.autoedit)
    expect(MCP_OFF_NOTE).not.toContain(String.fromCharCode(0x2014))
  })

  it('not applied: the copy is unchanged', () => {
    expect(codexSupport(need('review', 'readonly'), facts, false).copy).toBe(APP_SERVER_COPY.readonly)
    expect(codexSupport(need('review', 'readonly'), facts).copy).toBe(APP_SERVER_COPY.readonly)
    expect(mcpCopy('No note here.', true)).toBe('No note here.')
  })

  it('adapter.support reads the config: readable says off, unreadable or a project with servers keeps the note', () => {
    const adapterWith = (codexHomeDir: string) =>
      createCodexAdapter({
        env: { CODEX_HOME: codexHomeDir },
        home: temp('codex-mcp-adapter-home-'),
        probeCwd: temp('codex-mcp-probe-'),
        platform: 'linux',
        initialFacts: defaultFacts('linux'),
      })
    const readable = adapterWith(codexHome('[mcp_servers.alpha]\ncommand = "a"\n'))
    expect(readable.support(need('review', 'readonly')).copy).toBe(mcpCopy(APP_SERVER_COPY.readonly, true))
    expect(readable.support(need('implement', 'readonly')).copy).toBe(APP_SERVER_COPY.readonly)

    const broken = codexHome(undefined)
    mkdirSync(join(broken, 'config.toml'))
    expect(adapterWith(broken).support(need('review', 'readonly')).copy).toBe(APP_SERVER_COPY.readonly)

    const repo = temp('codex-mcp-proj-')
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, '.codex'))
    writeFileSync(join(repo, '.codex', 'config.toml'), 'mcp_servers.p.command = "p"\n')
    expect(readable.support(need('review', 'readonly', { cwd: repo })).copy).toBe(APP_SERVER_COPY.readonly)
    // A started pass's argv does not hide the folder's project config.
    expect(readable.support(need('review', 'readonly', { cwd: repo, argv: ['app-server'] })).copy).toBe(
      APP_SERVER_COPY.readonly,
    )
  })
})
