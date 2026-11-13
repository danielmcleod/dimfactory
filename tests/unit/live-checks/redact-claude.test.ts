// The recorder's Claude rules (scripts/redact-claude.mjs; the live re-record on the user's
// everyday ~/.claude): the commands the CLI does not mark built in, the user's and plugins' subagents, skills and
// output styles, plugins, MCP servers and tools, and hook frames are scrubbed from the CLI's frames; the CLI's own
// entries stay; every rule is idempotent and keeps each value's type; the profile's names and literals come from its
// own files, and the login and account files are never opened. (tests/unit/fixtures-redaction.test.ts checks every
// committed Claude recording is a fixed point of the protocol rules.)
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_REDACTED,
  NEVER_READ,
  QUOTA_RESETS_AT,
  REDACTED,
  builtinCommandNames,
  profileTerms,
  proseName,
  readProfileText,
  redactClaudeValue,
} from '../../../scripts/redact-claude.mjs'

// Every personal value here is an obviously fake one.
const initializeReply = {
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'init-1',
    response: {
      commands: [
        { name: 'fake-own-skill', description: 'Mine. (user)', argumentHint: '' },
        {
          name: 'code-review',
          description: 'Review the diff.',
          argumentHint: '[pr]',
          aliases: ['cr'],
          builtin: true,
        },
        {
          name: 'fakedocs',
          description: 'Synced. (claude.ai sync)',
          argumentHint: '',
          aliases: ['acme-skills:fakedocs'],
        },
      ],
      agents: [
        { name: 'general-purpose', description: 'General-purpose agent.' },
        { name: 'fake-reviewer', description: 'My own reviewer.', model: 'opus' },
      ],
      output_style: 'Fake Pirate',
      available_output_styles: ['default', 'Concise', 'Fake Pirate'],
      models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }],
      account: { email: 'user@example.invalid', organization: '<REDACTED>', subscriptionType: 'Claude Max' },
    },
  },
}

const init = {
  type: 'system',
  subtype: 'init',
  cwd: '<CWD>',
  session_id: 's',
  tools: ['Bash', 'Read', 'mcp__fake-notes__read_note', 'Skill'],
  mcp_servers: [{ name: 'fake-notes', status: 'connected' }],
  model: 'claude-sonnet-5-5',
  slash_commands: ['fake-own-skill', 'code-review', 'acme-skills:fakedocs', 'fake-plugin:review'],
  skills: ['fake-own-skill', 'code-review', 'acme-skills:fakedocs'],
  agents: ['claude', 'Explore', 'general-purpose', 'fake-reviewer', 'Plan'],
  plugins: [
    { name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' },
    { name: 'fake-plugin', path: '~/.claude/plugins/cache/fake-plugin', source: 'fake-plugin@fake-market' },
  ],
  output_style: 'default',
  uuid: '<REDACTED>',
}

describe('redactClaudeValue: protocol rules', () => {
  it('initialize: commands the CLI does not mark built in, the user’s agents and output styles', () => {
    const r = redactClaudeValue(initializeReply)
    const res = (r.value as typeof initializeReply).response.response
    expect(res.commands).toEqual([
      { name: REDACTED, description: REDACTED, argumentHint: REDACTED },
      initializeReply.response.response.commands[1],
      { name: REDACTED, description: REDACTED, argumentHint: REDACTED, aliases: [REDACTED] },
    ])
    expect(res.agents).toEqual([
      initializeReply.response.response.agents[0],
      { name: REDACTED, description: REDACTED, model: REDACTED },
    ])
    expect(res.output_style).toBe(REDACTED)
    expect(res.available_output_styles).toEqual(['default', 'Concise', REDACTED])
    // Not profile data: the models, the plan tier (the shared rules take the account's email and organization).
    expect(res.models).toEqual(initializeReply.response.response.models)
    expect(res.account).toEqual(initializeReply.response.response.account)
    expect(r.counts).toEqual({ 'claude-command': 1, 'claude-agent': 1, 'claude-output-style': 2 })
  })

  it('init: namespaced skills, the user’s agents, plugins not built in, MCP servers and tools', () => {
    const r = redactClaudeValue(init)
    expect(r.value).toEqual({
      ...init,
      tools: ['Bash', 'Read', MCP_TOOL_REDACTED, 'Skill'],
      mcp_servers: [{ name: REDACTED, status: 'connected' }],
      // A plain name is the user's only when the profile names it (ctx below).
      slash_commands: ['fake-own-skill', 'code-review', REDACTED, REDACTED],
      skills: ['fake-own-skill', 'code-review', REDACTED],
      agents: ['claude', 'Explore', 'general-purpose', REDACTED, 'Plan'],
      plugins: [init.plugins[0], { name: REDACTED, path: REDACTED, source: REDACTED }],
    })
  })

  it('init: with the profile’s names, a plain skill or command name too', () => {
    const r = redactClaudeValue(init, { names: new Set(['fake-own-skill']) })
    const v = r.value as typeof init
    expect(v.slash_commands).toEqual([REDACTED, 'code-review', REDACTED, REDACTED])
    expect(v.skills).toEqual([REDACTED, 'code-review', REDACTED])
  })

  it('hook frames: the name and what the hook wrote; the event and outcome stay', () => {
    const hook = {
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      output: 'Welcome back, Fake Person',
      stdout: 'Welcome back, Fake Person',
      stderr: '',
      exit_code: 0,
      outcome: 'success',
      uuid: '<REDACTED>',
      session_id: 's',
    }
    const r = redactClaudeValue(hook)
    expect(r.value).toEqual({ ...hook, hook_name: REDACTED, output: REDACTED, stdout: REDACTED })
    expect(r.counts).toEqual({ 'claude-hook': 3 })
    const started = {
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'Stop',
      hook_event: 'Stop',
    }
    expect(redactClaudeValue(started).value).toEqual({ ...started, hook_name: REDACTED })
  })

  it('an MCP tool call anywhere: its id and input; a permission denial naming it', () => {
    const call = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'mcp__fake-notes__read_note',
            input: { title: 'Dear fake diary', n: 2 },
          },
        ],
      },
    }
    expect(redactClaudeValue(call).value).toEqual({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: MCP_TOOL_REDACTED, input: { title: REDACTED, n: 2 } }],
      },
    })
    const denial = {
      type: 'result',
      permission_denials: [{ tool_name: 'mcp__fake-notes__write_note', tool_use_id: 't2' }],
    }
    expect(redactClaudeValue(denial).value).toEqual({
      type: 'result',
      permission_denials: [{ tool_name: MCP_TOOL_REDACTED, tool_use_id: 't2' }],
    })
  })

  it('a subagent type that is not built in, in a call and in the result tally', () => {
    const call = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'a1',
            name: 'Agent',
            input: { subagent_type: 'fake-reviewer', prompt: 'x' },
          },
        ],
      },
    }
    expect(redactClaudeValue(call).value).toEqual({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: REDACTED, prompt: 'x' } },
        ],
      },
    })
    const builtin = {
      ...call,
      message: { content: [{ ...call.message.content[0]!, input: { subagent_type: 'general-purpose' } }] },
    }
    expect(redactClaudeValue(builtin).counts).toEqual({})
    const result = {
      type: 'result',
      subagent_stats: { spawned: 2, by_type: { 'general-purpose': 1, 'fake-reviewer': 1 } },
    }
    expect(redactClaudeValue(result).value).toEqual({
      type: 'result',
      subagent_stats: { spawned: 2, by_type: { 'general-purpose': 1, [REDACTED]: 1 } },
    })
  })

  it('the Skill tool naming a plugin’s or the user’s skill', () => {
    const call = (skill: string) => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill } }] },
    })
    expect(redactClaudeValue(call('acme-skills:fakedocs')).value).toEqual(call(REDACTED))
    expect(redactClaudeValue(call('fake-own-skill'), { names: new Set(['fake-own-skill']) }).value).toEqual(
      call(REDACTED),
    )
    expect(redactClaudeValue(call('code-review')).counts).toEqual({})
  })

  it('a plan-limit event: its reset times and billing flags; status, window and utilization stay', () => {
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: 1792281600,
        rateLimitType: 'seven_day',
        utilization: 0.78,
        overageResetsAt: 1792281601,
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
        surpassedThreshold: 0.75,
        canUserPurchaseCredits: true,
        hasChargeableSavedPaymentMethod: true,
        unifiedWindows: {
          five_hour: { utilization: 0.05, resetsAt: 1791847800 },
          seven_day: { utilization: 0.78, resetsAt: 1792281600 },
        },
      },
      uuid: '<REDACTED>',
      session_id: 's',
    }
    const r = redactClaudeValue(event)
    expect(r.value).toEqual({
      ...event,
      rate_limit_info: {
        ...event.rate_limit_info,
        resetsAt: QUOTA_RESETS_AT,
        overageResetsAt: QUOTA_RESETS_AT,
        canUserPurchaseCredits: false,
        hasChargeableSavedPaymentMethod: false,
        unifiedWindows: {
          five_hour: { utilization: 0.05, resetsAt: 0 },
          seven_day: { utilization: 0.78, resetsAt: 0 },
        },
      },
    })
    expect(r.counts).toEqual({ 'claude-quota': 6 })
    expect(redactClaudeValue(r.value).counts).toEqual({})
  })

  it('an mcp_status reply: each server’s name, definition, server info, error and tools; status, scope and type stay', () => {
    const reply = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'st-1',
        response: {
          mcpServers: [
            {
              name: 'claude.ai Fake Mail',
              status: 'connected',
              serverInfo: { name: 'fake-mail', version: '1.2.3' },
              config: {
                type: 'claudeai-proxy',
                url: 'https://mcp-proxy.example.invalid/v1/mcp/srv_fake',
                id: 'srv_fake',
              },
              scope: 'claudeai',
              source: 'claudeai',
              tools: [{ name: 'send_fake', description: 'Sends.', annotations: { destructive: true } }],
            },
            { name: 'fake-local', status: 'failed', error: 'spawn fake-local.exe ENOENT', scope: 'user' },
          ],
        },
      },
    }
    const { value, counts } = redactClaudeValue(reply)
    expect((value as typeof reply).response.response.mcpServers).toEqual([
      {
        name: REDACTED,
        status: 'connected',
        serverInfo: { name: REDACTED, version: REDACTED },
        config: { type: 'claudeai-proxy', url: REDACTED, id: REDACTED },
        scope: 'claudeai',
        source: 'claudeai',
        tools: [{ name: REDACTED, description: REDACTED, annotations: { destructive: true } }],
      },
      { name: REDACTED, status: 'failed', error: REDACTED, scope: 'user' },
    ])
    expect(counts).toEqual({ 'claude-mcp': 1 })
    expect(redactClaudeValue(value).counts).toEqual({})
  })

  it('a commands_changed push is a command list like initialize’s', () => {
    const push = {
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'fake-own-skill', description: 'Mine.', argumentHint: '' },
        { name: 'clear', description: 'Clear.', argumentHint: '', builtin: true },
      ],
    }
    expect((redactClaudeValue(push).value as typeof push).commands).toEqual([
      { name: REDACTED, description: REDACTED, argumentHint: REDACTED },
      push.commands[1],
    ])
  })

  it('is idempotent and leaves ordinary frames alone', () => {
    for (const frame of [initializeReply, init]) {
      const once = redactClaudeValue(frame).value
      const twice = redactClaudeValue(once)
      expect(twice.value).toEqual(once)
      expect(twice.counts).toEqual({})
    }
    const plain = [
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      },
      { type: 'system', subtype: 'status', status: 'requesting' },
      {
        type: 'control_request',
        request_id: 'r',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm --version' } },
      },
      'not an object',
      null,
    ]
    for (const v of plain) expect(redactClaudeValue(v)).toEqual({ value: v, counts: {} })
  })

  it('builtinCommandNames reads the initialize reply and a commands_changed push', () => {
    expect(builtinCommandNames(initializeReply)).toEqual(['code-review'])
    expect(
      builtinCommandNames({
        type: 'system',
        subtype: 'commands_changed',
        commands: [{ name: 'Clear', builtin: true }],
      }),
    ).toEqual(['clear'])
    expect(builtinCommandNames({ type: 'system', subtype: 'init' })).toEqual([])
  })
})

describe('profileTerms: the config folder’s own files', () => {
  const md = (name: string): string => `---\nname: ${name}\ndescription: x\n---\nBody.\n`
  function profile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-profile-'))
    const put = (rel: string, text: string): void => {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, text)
    }
    put('skills/fake-own-skill/SKILL.md', md('fake-own-skill-named'))
    put(
      'skills/synced/11111111-2222-4333-8444-555555555555_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/docs/SKILL.md',
      md('docs'),
    )
    put('skills/.trash/1-x/old/SKILL.md', md('trashed-skill'))
    put('agents/fake-reviewer.md', md('fake-reviewer'))
    put('agents/Explore.md', md('Explore'))
    put('commands/fake-cmd.md', 'Do it.')
    put('commands/team/fake-sub.md', 'Do it too.')
    put('output-styles/pirate.md', md('Fake Pirate'))
    put(
      'plugins/installed_plugins.json',
      JSON.stringify({ version: 2, plugins: { 'fake-plugin@fake-market': [] } }),
    )
    put(
      'settings.json',
      JSON.stringify({
        enabledPlugins: { 'other-plugin@fake-market': true },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node C:/fake/hooks/notify.js' }] }] },
        statusLine: { type: 'command', command: 'bash ~/.claude/fake-status.sh' },
        env: { FAKE_PROXY: 'http://proxy.fake.invalid:3128', SHORT: 'x' },
        permissions: { allow: ['Bash(npm test:*)'] },
      }),
    )
    put('CLAUDE.md', '# Me\n- Always sign answers as the fake person, please.\nok\n')
    // Never opened: the login and the account record (a read would throw in readProfileText).
    put('.credentials.json', '{"claudeAiOauth":{"accessToken":"never-read"}}')
    put('.claude.json', '{"oauthAccount":{"emailAddress":"never-read"}}')
    return dir
  }

  it('names the user’s skills, commands, agents, output styles and plugins; not built-ins, trash or synced skills', () => {
    const t = profileTerms(profile())
    expect(new Set(t.names)).toEqual(
      new Set([
        'fake-own-skill',
        'fake-own-skill-named',
        'fake-reviewer',
        'fake-cmd',
        'team:fake-sub',
        'Fake Pirate',
        'pirate',
        'fake-plugin@fake-market',
        'fake-plugin',
        'fake-market',
        'other-plugin@fake-market',
        'other-plugin',
      ]),
    )
    expect(t.skipped).toBe(0)
  })

  it('takes hook and status-line commands, distinctive env values, the synced bucket and CLAUDE.md lines verbatim', () => {
    const t = profileTerms(profile())
    expect(new Set(t.literals)).toEqual(
      new Set([
        'node C:/fake/hooks/notify.js',
        'bash ~/.claude/fake-status.sh',
        'http://proxy.fake.invalid:3128',
        '11111111-2222-4333-8444-555555555555_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        // Each account id of the synced folder's name on its own too (a frame can name one alone).
        '11111111-2222-4333-8444-555555555555',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'Always sign answers as the fake person, please.',
      ]),
    )
    // Values and names never include what the credential or account files hold.
    expect(JSON.stringify(t)).not.toContain('never-read')
  })

  it('a synced folder’s account ids are literals on their own, in skills/synced and plugins/synced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-profile-synced-'))
    const org = '33333333-4444-4555-8666-777777777777'
    const account = 'cccccccc-dddd-4eee-8fff-000000000000'
    mkdirSync(join(dir, 'plugins', 'synced', `${org}_${account}`, 'fake-sync-plugin'), { recursive: true })
    mkdirSync(join(dir, 'skills', 'synced', 'not-ids_either-part', 'docs'), { recursive: true })
    const t = profileTerms(dir)
    expect(new Set(t.literals)).toEqual(new Set([`${org}_${account}`, org, account, 'not-ids_either-part']))
    // What the recorder and the scan do with them: a frame naming one id alone is caught.
    const frame = JSON.stringify({ organization_uuid: org, account_uuid: account })
    const left = t.literals.reduce((text, l) => text.split(l).join(REDACTED), frame)
    expect(left).toBe(JSON.stringify({ organization_uuid: REDACTED, account_uuid: REDACTED }))
  })

  it('never opens the login or the account file', () => {
    expect(NEVER_READ).toEqual(expect.arrayContaining(['.credentials.json', '.claude.json']))
    const dir = profile()
    for (const f of NEVER_READ) expect(() => readProfileText(join(dir, f))).toThrow(/credentials/)
  })

  it('an empty or missing folder names nothing; a settings file that will not parse is counted', () => {
    expect(profileTerms(join(tmpdir(), 'no-such-claude-config-dir'))).toEqual({
      literals: [],
      names: [],
      skipped: 0,
    })
    const dir = mkdtempSync(join(tmpdir(), 'claude-profile-bad-'))
    writeFileSync(join(dir, 'settings.json'), '{ not json')
    expect(profileTerms(dir).skipped).toBe(1)
  })

  it('proseName: only long hyphenated or namespaced names are words to look for in free text', () => {
    expect(proseName('fake-own-skill')).toBe(true)
    expect(proseName('acme-skills:docs')).toBe(true)
    for (const n of ['docs', 'pdf', 'run', 'morning', 'Fake Pirate', 'fakecmd1'])
      expect(proseName(n)).toBe(false)
  })
})
