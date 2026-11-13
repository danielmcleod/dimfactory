import { describe, expect, it } from 'vitest'
import { REPLAY_MAX_LIMIT } from '../../../src/core/bus/bus.ts'
import {
  REQUEST_SCHEMAS,
  RUN_IDS_MAX,
  TASK_MAX_BYTES,
  TEXT_INPUT_MAX_BYTES,
  parseRequest,
  utf8ByteLength,
} from '@shared/ipc-schemas.ts'
import { COMMAND_AREA, RUN_EVENTS_MAX_LIMIT } from '@shared/ipc.ts'
import type { Cmd, Req } from '@shared/ipc.ts'

const runId = '20261005T010203Z-abcd'
const folder = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
const sha = 'a'.repeat(64)
const taskId = 't0123456789ab'

/** Representative valid requests per command (typed by `Req<C>`): a minimal one, a full one, one per union variant. */
const SAMPLES: { [C in Cmd]: readonly Req<C>[] } = {
  'app.info': [undefined],
  'app.ready': [{}, { route: '/runs/' + runId }],
  'app.quit': [{ confirm: true }, { confirm: false }],
  'dialog.pickFolder': [{}, { defaultPath: folder }],
  'dialog.pickFiles': [{}, { defaultPath: folder }],
  'shell.open': [
    { target: 'runFolder', runId },
    { target: 'rawLog', runId, step: 'verify:1' },
    { target: 'worktree', runId },
    { target: 'folder', path: folder },
    { target: 'logs' },
    { target: 'home' },
    { target: 'url', url: 'https://docs.anthropic.com/en/docs/claude-code' },
    { target: 'uploadFile', path: folder },
  ],
  'log.write': [
    { level: 'info', msg: 'renderer ready' },
    { level: 'error', msg: 'boom', data: { stack: 'x', n: 1 } },
  ],
  'diagnostics.build': [{}, { runId, includeRaw: true }],
  'diagnostics.copy': [{ runId }],
  'diagnostics.save': [{ includeRaw: false }],
  'events.focus': [{ runIds: [] }, { runIds: [runId, '20261005T010204Z-beef'] }],
  'state.get': [undefined],
  'state.set': [
    {},
    { setupDismissed: true, notificationsPausedUntil: 1_790_000_000_000 },
    { notificationsPausedUntil: null },
  ],
  'runs.start': [
    { folder, task: 'add a --version flag' },
    {
      folder,
      task: 'x',
      overrides: { profile: 'claude-only', auto: true, passes: { review: { enabled: false } } },
    },
    { folder, task: 'fix the date bug', recipe: 'bug-fix' },
  ],
  'runs.list': [
    {},
    {
      folder,
      status: ['running', 'paused'],
      vendor: 'claude',
      text: 'flag',
      from: 0,
      to: 1_790_000_000_000,
      cursor: '100',
      limit: 100,
    },
  ],
  'runs.get': [{ runId }],
  'runs.events': [
    { runId, sinceSeq: 0 },
    { runId, sinceSeq: 41, limit: 2000, condensed: true },
  ],
  'runs.output': [
    { runId, file: 'plan' },
    { runId, file: 'plan.original' },
  ],
  'runs.stop': [{ runId }],
  'runs.close': [{ runId }],
  'runs.resume': [{ runId }, { runId, allowTimedOutAsk: true }],
  'runs.retryPass': [
    { runId, pass: 'implement' },
    { runId, pass: 'fix', strategy: 'revert-then-fresh' },
  ],
  'runs.skipPass': [{ runId, pass: 'review' }],
  'runs.keepWaiting': [{ runId, pass: 'implement' }],
  'runs.switchToAuto': [{ runId }],
  'runs.rerun': [
    { runId, from: 'start' },
    { runId, from: 'fix', findingIds: ['F1', 'b'.repeat(40)] },
  ],
  'runs.pin': [{ runId, pinned: true }],
  'runs.remove': [{ runIds: [runId] }],
  'runs.undoRemove': [{ undoToken: 'eyJyIjpbXX0' }],
  'runs.branch': [
    { runId, action: 'return' },
    { runId, action: 'delete' },
  ],
  'asks.answer': [
    { runId, requestId: 'req_0123456789abcdef', decision: 'allow' },
    { runId, requestId: 'toolu_01', decision: 'allow-session' },
    { runId, requestId: '42', decision: 'deny', graceMs: 5000 },
  ],
  'asks.undo': [{ runId, requestId: '42' }],
  'cards.resolve': [
    { runId, cardId: 'gate:afterPlan#1', choiceId: 'approve' },
    { runId, cardId: 'gate:afterPlan#1', choiceId: 'edit', input: '# Plan\n\n1. Do the thing.' },
    { runId, cardId: 'gate:beforeFix#2', choiceId: 'fix', input: ['F1', 'F2'] },
  ],
  'recovery.execute': [{ actionId: 'implement:retry' }, { actionId: 'run:close', runId, folder }],
  'heal.diagnose': [{ runId, step: 'implement' }],
  'diff.files': [{ runId, seg: 'combined' }],
  'diff.file': [
    { runId, seg: 'implement', path: 'src/index.ts' },
    { runId, seg: 'fix', path: 'a b/c.ts', ignoreEol: true },
  ],
  'diff.blob': [{ runId, seg: 'combined', side: 'old', path: 'logo.png' }],
  'diff.revert': [
    { runId, paths: 'all' },
    { runId, seg: 'fix', paths: ['src/index.ts'] },
  ],
  'diff.undoRevert': [{ runId, undoToken: 'tok' }],
  'diff.markReviewed': [{ runId, paths: ['src/index.ts'], reviewed: true }],
  'worktree.preview': [{ runId }],
  'worktree.apply': [{ runId }, { runId, paths: ['src/index.ts'] }],
  'worktree.undoApply': [{ runId, undoToken: 'tok' }],
  'worktree.discard': [{ runId }],
  'worktree.undoDiscard': [{ runId, undoToken: 'tok' }],
  'preflight.run': [{ folder }, { folder, overrides: { auto: false } }, { folder, recipe: 'bug-fix' }],
  'depth.decide': [
    { folder, task: 'Fix the typo' },
    { folder, task: 'Add sign-in', overrides: { depth: 'full' }, recipe: 'bug-fix' },
  ],
  'matches.start': [
    {
      folder,
      task: 'Add a flag',
      sides: [{ vendor: 'claude' }, { vendor: 'codex', model: 'gpt-x', effort: 'high' }],
    },
    {
      folder,
      task: 'Add a flag',
      overrides: { auto: false },
      recipe: 'bug-fix',
      sides: [
        { vendor: 'claude', model: null },
        { vendor: 'claude', model: 'opus' },
      ],
    },
  ],
  'matches.get': [{ matchId: runId }],
  'matches.list': [undefined],
  'matches.pick': [
    { matchId: runId, side: 'a' },
    { matchId: runId, side: 'none' },
  ],
  'matches.undoPick': [{ matchId: runId }],
  'matches.rematch': [
    { runId, challenger: { vendor: 'codex' } },
    { runId, challenger: { vendor: 'claude', model: 'opus', effort: 'high' }, fresh: true, blind: true },
    { runId, challenger: { vendor: 'gemini' }, confirmNewVendor: true },
  ],
  'matches.rematchCheck': [{ runId }],
  'matches.scoreboard': [undefined],
  'matches.batchPlan': [{ challenger: { vendor: 'codex', model: 'gpt-x' } }],
  'matches.batchAdd': [{ challenger: { vendor: 'codex', model: 'gpt-x' }, runIds: [runId] }],
  'matches.offers': [undefined],
  'matches.dismissOffer': [{ vendor: 'codex', model: 'gpt-x' }],
  'matches.savePatch': [{ matchId: runId, side: 'b' }],
  'matches.blind': [{ matchId: runId, on: true }],
  'matches.compare': [{ matchId: runId }],
  'matches.compareFile': [
    { matchId: runId, path: 'src/a.ts' },
    { matchId: runId, path: 'src/a.ts', ignoreEol: true },
  ],
  'task.check': [
    { folder, task: '' },
    { folder, task: 'Fix the bug', recipe: 'bug-fix' },
  ],
  'task.sharpen': [{ folder, task: 'Fix the bug' }],
  'vendors.list': [undefined],
  'vendors.probe': [{}, { vendor: 'codex', force: true }],
  'vendors.setPath': [
    { vendor: 'claude', path: folder },
    { vendor: 'claude', path: null },
  ],
  'vendors.models': [{ vendor: 'local-ollama' }, { vendor: 'gemini', force: false }],
  'config.resolve': [
    {},
    { folder, overrides: { gates: { afterPlan: false } } },
    { folder, recipe: 'new-web-app' },
  ],
  'extensions.discover': [{}, { folder }],
  'extensions.claudeConnectors': [{}, { force: true }],
  'config.read': [{ scope: 'user' }, { scope: 'project', folder }],
  'config.save': [
    { scope: 'project', folder, overrides: {}, mode: 'projectDefault' },
    { scope: 'user', overrides: { passes: { review: { vendor: 'codex' } } }, mode: 'row', pass: 'review' },
  ],
  'config.patch': [
    { scope: 'user', ops: [] },
    {
      scope: 'project',
      folder,
      ops: [
        { op: 'add', path: '/gates/afterPlan', value: false },
        { op: 'replace', path: '/timeouts/stallMs', value: 600_000 },
        { op: 'remove', path: '/vendors/claude/flagMap/--x' },
        { op: 'test', path: '/profiles/a~1b/plan', value: { vendor: 'claude', model: null } },
      ],
    },
  ],
  'config.restoreBackup': [
    { scope: 'user', backupId: 'last-good' },
    { scope: 'project', folder, backupId: '20261005T010203123Z-abcd' },
  ],
  'prompts.get': [{ name: 'heal' }, { name: 'plan', folder }],
  'prompts.save': [
    { name: 'review', scope: 'user', text: 'Review {{diff}}' },
    { name: 'fix', scope: 'project', folder, text: null },
  ],
  'ui.setTheme': [{}, { theme: 'dark', accent: 'violet' }],
  'folders.recent': [undefined],
  'git.init': [{ folder }],
  'trust.get': [{ folder }],
  'trust.set': [
    { folder, grant: { kind: 'vendorFolder', vendor: 'gemini' }, trusted: true },
    { folder, grant: { kind: 'largeFolder' }, trusted: false },
    { folder, grant: { kind: 'projectAuto' }, trusted: true },
    { folder, grant: { kind: 'projectAuto', projectSha: sha }, trusted: true },
    { folder, grant: { kind: 'recipeAuto', recipeId: 'ship-it' }, trusted: true },
    { folder, grant: { kind: 'recipeAuto', recipeId: 'ship-it', recipeSha: sha }, trusted: false },
    {
      folder,
      grant: { kind: 'command', command: { kind: 'verify', argv: ['npm', 'test'], cwdRel: '' } },
      trusted: true,
    },
  ],
  'verify.detect': [{ folder }],
  'guardrails.suggest': [{ folder }],
  'guardrails.state': [undefined],
  'guardrails.prove': [{ kind: 'protectedFiles' }, { kind: 'privateFiles' }],
  'dashboard.get': [undefined],
  'stats.get': [{ range: '7d' }, { range: 'all' }],
  'usage.get': [{ range: '7d' }, { range: '30d' }],
  'context.report': [{ folder: 'C:\\work\\app' }],
  'estimates.get': [
    { folder },
    { folder, overrides: { profile: 'balanced' } },
    { folder, brief: { category: 'software', fields: { approach: { choices: ['test-first'] } } } },
    { folder, recipe: 'data-report' },
  ],
  'brief.detect': [{}, { folder }, { folder, task: 'add a login page' }],
  'recipes.list': [{}, { folder }],
  'brief.save': [
    { folder, brief: null },
    {
      folder,
      brief: { category: 'software', fields: { styling: { choices: ['tailwind'], source: 'user' } } },
    },
  ],
  'brief.suggest': [
    { folder, task: 'a landing page', brief: { category: 'software', fields: {} } },
    { folder, task: 'x', brief: { category: 'documents', fields: {} }, overrides: { profile: 'balanced' } },
  ],
  'catalog.get': [undefined],
  'catalog.refreshPlan': [undefined],
  'catalog.refresh': [
    { consent: true },
    { consent: true, vendor: 'claude', model: null },
    { consent: true, model: 'gpt-5.5' },
  ],
  'catalog.cancel': [{ jobId: 'job_1' }],
  'catalog.apply': [
    { jobId: 'job_1', rowIds: [] },
    { jobId: 'job_1', rowIds: ['r1', 'r2'] },
  ],
  'catalog.undo': [undefined],
  'catalog.savePrice': [
    {
      entry: {
        vendor: 'claude',
        model: 'claude-opus-4-1',
        inputPerMTok: 15,
        outputPerMTok: 75,
        cacheReadPerMTok: null,
        cacheWritePerMTok: 18.75,
      },
    },
    {
      entry: {
        vendor: 'codex',
        model: 'gpt-5.5',
        inputPerMTok: 0,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: null,
        aliases: ['gpt-5.5-latest'],
        sourceUrl: 'https://openai.com/api/pricing',
      },
    },
  ],
  'catalog.setSchedule': [{}, { enabled: false }, { intervalDays: 14 }, { snoozeDays: 7 }],
  'storage.usage': [undefined],
  'storage.clearShadow': [{ folderKey: '0123456789abcdef' }],
  'notifications.test': [undefined],
  'notifications.repairShortcut': [undefined],
  'e2e.state': [undefined],
  'e2e.power': [{ event: 'suspend' }, { event: 'resume' }],
  'e2e.clock': [{ advanceMs: 0 }, { advanceMs: 600_000 }],
  'mcp.external.get': [undefined],
  'mcp.external.set': [
    {},
    { enabled: true },
    { port: 47821 },
    { regenerate: true },
    { enabled: false, port: 1024 },
  ],
  'mcp.external.codexPlugin': [{ install: false }, { install: true }],
  'mcp.external.claudePlugin': [{ install: false }, { install: true }],
  'mcp.addToEditor': [{ editor: 'vscode' }, { editor: 'cursor' }],
  'mcp.requests.list': [undefined],
  'mcp.requests.approve': [{ id: 'req-abc' }],
  'mcp.requests.decline': [{ id: 'req-abc' }],
  'preview.detect': [{ folder }, { runId }, { folder, runId }],
  'preview.start': [
    { folder, commandId: 'pkg:dev' },
    { runId, commandId: 'static:.' },
  ],
  'preview.trust': [
    { folder, commandId: 'pkg:dev', trusted: true },
    { runId, commandId: 'docker:compose', hash: sha, trusted: false },
  ],
  'preview.stop': [{ sessionId: 'pv_abc' }, { sessionId: 'pv_abc', containers: true }],
  'preview.list': [undefined],
  'preview.open': [
    { sessionId: 'pv_abc', target: 'app' },
    { sessionId: 'pv_abc', target: 'browser' },
  ],
  'preview.openPair': [{ sessionIds: ['pv_abc', 'pv_def'], labels: ['Side A', 'Side B'] }],
  'preview.smoke': [{ sessionId: 'pv_abc' }],
  'preview.savePdf': [{ sessionId: 'pv_abc' }],
  'preview.playtest': [{ sessionId: 'pv_abc' }],
  'preview.tryIt': [{ sessionId: 'pv_abc' }],
  'preview.shareCheck': [{ sessionId: 'pv_abc' }],
  'preview.network': [
    { sessionId: 'pv_abc', internet: true },
    { sessionId: 'pv_abc', internet: false },
  ],
  'preview.phone': [
    { sessionId: 'pv_abc', phone: true },
    { sessionId: 'pv_abc', phone: false },
  ],
  'deploy.inspect': [{ folder }, { runId }, { folder, cls: 'server-app' }],
  'deploy.uploadFile': [{ folder }, { runId }, { folder, cls: 'spa' }],
  'deploy.build': [{ folder }, { runId }, { runId, trustHash: 'a'.repeat(64) }],
  'deploy.tick': [
    { folder, item: 'https', ticked: true },
    { runId, item: 'admin-auth', ticked: false },
  ],
  'git.commitPreview': [{ runId }],
  'git.commit': [{ runId }, { runId, message: 'Add the login page\n\nMade by Dim Factory.' }],
  'git.prPreview': [{ runId }],
  'git.prCreate': [
    { runId, confirm: { remote: 'origin', repo: 'acme/shop', branch: 'dim/20261024-add-login' } },
  ],
  'templates.list': [undefined],
  'project.create': [
    { folder, templateId: 'vite-react' },
    { folder, templateId: 'data-report', goal: 'Track weekly sign-ups' },
  ],
  'queue.get': [undefined],
  'queue.add': [
    { folder, tasks: [{ task: 'Add a --version flag' }] },
    { folder, tasks: [{ task: 'Fix the login bug', recipe: 'bug-fix' }, { task: 'Write the docs' }] },
  ],
  'queue.remove': [{ folder, id: taskId }],
  'queue.move': [
    { folder, id: taskId, to: 0 },
    { folder, id: taskId, to: 3 },
  ],
  'queue.retry': [{ folder, id: taskId }],
  'queue.clear': [{ folder }],
  'queue.importTodo': [{ folder }, { folder, file: 'docs/TODO.md' }],
  'queue.githubCheck': [{ folder }],
  'queue.importGithub': [{ folder }],
  'queue.start': [{}, { folders: [folder] }, { folders: [folder], noticeId: 'n1abc' }],
  'queue.pause': [{}, { folders: [folder] }],
  'queue.dismissNotice': [{ id: 'n1abc' }],
  'queue.report': [{}, { date: '2026-10-24' }],
  'memory.get': [{ folder }],
  'memory.apply': [{ folder, id: runId }],
  'memory.dismiss': [{ folder, id: runId }],
  'runs.limits': [{ runId }],
  'easy.state': [undefined],
  'easy.setExperience': [{ experience: 'easy' }, { experience: 'full' }],
  'easy.resolve': [
    { idea: 'A tip splitter' },
    { idea: 'A tip splitter', kind: 'app' },
    { idea: 'A tip splitter', kind: 'app', stack: 'html', recheck: true },
  ],
  'easy.create': [
    {
      idea: 'A tip splitter',
      kind: 'app',
      folder,
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: false,
    },
    { idea: 'A memo', kind: 'research', folder, limits: { maxCostUsd: 5, maxMinutes: 45 }, consent: true },
    {
      idea: 'A report',
      kind: 'data',
      folder,
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: false,
      attachments: [folder],
    },
    {
      idea: 'An AI caption writer',
      kind: 'app',
      folder,
      limits: { maxCostUsd: null, maxMinutes: null },
      consent: true,
      stack: 'react',
      needs: { ai: 'proxy', forms: 'email' },
    },
  ],
  'easy.change': [
    { folder, change: 'Bigger buttons', limits: { maxCostUsd: 2, maxMinutes: null } },
    { folder, continueRunId: runId, limits: { maxCostUsd: 3, maxMinutes: null } },
    {
      folder,
      change: 'Use my new sales file',
      attachments: [folder],
      limits: { maxCostUsd: null, maxMinutes: null },
    },
  ],
  'easy.changeEstimate': [{ folder, change: 'Bigger buttons' }],
  'easy.projects': [undefined],
  'easy.attachCheck': [{ paths: [] }, { paths: [folder] }],
  'easy.permissions': [undefined],
  'easy.permission': [{ folder }, { folder, runId }],
  'easy.revokePermission': [{ folder }],
  'easy.inspectFolder': [{ folder }],
  'easy.work': [
    { folder, change: 'Add a contact page', limits: { maxCostUsd: null, maxMinutes: null } },
    { folder, change: 'Add a contact page', turnOnUndo: true, limits: { maxCostUsd: 2, maxMinutes: 30 } },
    {
      folder,
      change: 'Add a contact page',
      how: 'saveFirst',
      limits: { maxCostUsd: null, maxMinutes: null },
    },
  ],
  'easy.intent': [{ idea: 'Something for my bakery', candidates: ['website', 'app'] }],
  'easy.visual': [{ runId }],
  'easy.visualReview': [{ runId }],
  'easy.helperCost': [{ helper: 'think' }, { helper: 'ask', runId }],
  'easy.think': [
    { idea: 'Something for my bakery', turns: [] },
    {
      idea: 'Something for my bakery',
      turns: [
        {
          question: 'Who is it for?',
          options: ['Regulars: simple', 'Tourists: more photos'],
          answer: 'Regulars',
        },
      ],
      finish: true,
    },
  ],
  'easy.shareFiles': [{ runId }],
  'easy.ask': [{ runId, question: 'How do I change the colours?' }],
  'easy.queue': [undefined],
  'easy.queueAdd': [
    {
      ideas: [{ idea: 'A tip splitter', kind: 'app', consent: false }],
      limits: { maxCostUsd: null, maxMinutes: null },
    },
  ],
  'easy.queueStart': [{}, { at: '22:00' }, { noticeId: 'n1abc' }],
  'easy.queuePause': [undefined],
  'easy.queueRemove': [{ folder }],
}

const COMMANDS = Object.keys(COMMAND_AREA) as Cmd[]
const isVoid = (c: Cmd): boolean => SAMPLES[c].every((s) => s === undefined)

/** Expect a VALIDATION result whose message starts with `<path>: `. */
function expectInvalid(cmd: Cmd, raw: unknown, path: string): void {
  const r = parseRequest(cmd, raw)
  expect(r.ok, `${cmd} ${JSON.stringify(raw)?.slice(0, 200)}`).toBe(false)
  if (r.ok) return
  expect(r.error.code).toBe('VALIDATION')
  expect(r.error.message.startsWith(`${path}: `), r.error.message).toBe(true)
  expect(Array.isArray(r.error.details) && r.error.details.length > 0).toBe(true)
}

describe('REQUEST_SCHEMAS', () => {
  it('has exactly one schema per command', () => {
    expect(Object.keys(REQUEST_SCHEMAS).sort()).toEqual([...COMMANDS].sort())
  })

  it('has samples for every command (the table above is exhaustive)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...COMMANDS].sort())
  })

  it.each(COMMANDS)('%s accepts its representative requests unchanged', (cmd) => {
    for (const sample of SAMPLES[cmd]) {
      const r = parseRequest(cmd, sample)
      expect(r, JSON.stringify(sample)).toEqual({ ok: true, value: sample })
    }
  })

  it.each(COMMANDS.filter((c) => !isVoid(c)))('%s rejects an unknown key on every sample', (cmd) => {
    for (const sample of SAMPLES[cmd]) {
      const r = parseRequest(cmd, { ...(sample as object), extra: 1 })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('VALIDATION')
      expect(r.error.message).toContain('Unrecognized key')
      expect(r.error.message).toContain('extra')
    }
  })

  it.each(COMMANDS.filter(isVoid))('%s (void) accepts undefined only', (cmd) => {
    expect(parseRequest(cmd, undefined)).toEqual({ ok: true, value: undefined })
    expectInvalid(cmd, {}, 'request')
    expectInvalid(cmd, null, 'request')
    expectInvalid(cmd, 0, 'request')
  })

  it('rejects non-object requests for object commands', () => {
    expectInvalid('runs.get', undefined, 'request')
    expectInvalid('runs.get', null, 'request')
    expectInvalid('runs.get', 'r1', 'request')
    expectInvalid('runs.get', [runId], 'request')
  })
})

describe('representative invalid requests', () => {
  const big = (bytes: number): string => 'x'.repeat(bytes)
  const cases: [string, Cmd, unknown, string][] = [
    ['missing runId', 'runs.get', {}, 'runId'],
    ['empty runId', 'runs.get', { runId: '' }, 'runId'],
    ['overlong runId', 'runs.get', { runId: 'r'.repeat(129) }, 'runId'],
    ['runId with a newline', 'runs.stop', { runId: 'a\nb' }, 'runId'],
    ['numeric runId', 'runs.get', { runId: 7 }, 'runId'],
    ['negative sinceSeq', 'runs.events', { runId, sinceSeq: -1 }, 'sinceSeq'],
    ['fractional sinceSeq', 'runs.events', { runId, sinceSeq: 1.5 }, 'sinceSeq'],
    ['NaN sinceSeq', 'runs.events', { runId, sinceSeq: Number.NaN }, 'sinceSeq'],
    ['infinite sinceSeq', 'runs.events', { runId, sinceSeq: Number.POSITIVE_INFINITY }, 'sinceSeq'],
    [
      'limit over the replay cap',
      'runs.events',
      { runId, sinceSeq: 0, limit: RUN_EVENTS_MAX_LIMIT + 1 },
      'limit',
    ],
    ['limit 0', 'runs.events', { runId, sinceSeq: 0, limit: 0 }, 'limit'],
    ['unknown output file', 'runs.output', { runId, file: 'secrets' }, 'file'],
    ['unknown pass', 'runs.retryPass', { runId, pass: 'verify' }, 'pass'],
    ['unknown retry strategy', 'runs.retryPass', { runId, pass: 'fix', strategy: 'yolo' }, 'strategy'],
    ['decision cancel', 'asks.answer', { runId, requestId: '1', decision: 'cancel' }, 'decision'],
    [
      'graceMs above 10 s',
      'asks.answer',
      { runId, requestId: '1', decision: 'deny', graceMs: 10_001 },
      'graceMs',
    ],
    ['negative graceMs', 'asks.answer', { runId, requestId: '1', decision: 'deny', graceMs: -1 }, 'graceMs'],
    [
      'too many focused runs',
      'events.focus',
      { runIds: Array.from({ length: RUN_IDS_MAX + 1 }, () => runId) },
      'runIds',
    ],
    ['bad id in a list', 'events.focus', { runIds: [runId, ''] }, 'runIds[1]'],
    ['empty remove list', 'runs.remove', { runIds: [] }, 'runIds'],
    ['blank folder', 'runs.start', { folder: '  ', task: 'x' }, 'folder'],
    ['NUL in a path', 'runs.start', { folder: 'C:\\a\u0000b', task: 'x' }, 'folder'],
    ['overlong path', 'git.init', { folder: 'a'.repeat(4097) }, 'folder'],
    ['blank task', 'runs.start', { folder, task: ' \n ' }, 'task'],
    ['oversize task', 'runs.start', { folder, task: big(TASK_MAX_BYTES + 1) }, 'task'],
    ['oversize multibyte task', 'runs.start', { folder, task: 'é'.repeat(TASK_MAX_BYTES / 2 + 1) }, 'task'],
    ['unknown override key', 'runs.start', { folder, task: 'x', overrides: { vendors: {} } }, 'overrides'],
    ['bad override value', 'preflight.run', { folder, overrides: { auto: 'yes' } }, 'overrides.auto'],
    [
      'oversize card input',
      'cards.resolve',
      { runId, cardId: 'c', choiceId: 'edit', input: big(TEXT_INPUT_MAX_BYTES + 1) },
      'input',
    ],
    ['card input of numbers', 'cards.resolve', { runId, cardId: 'c', choiceId: 'fix', input: [1] }, 'input'],
    ['http URL', 'shell.open', { target: 'url', url: 'http://example.com' }, 'url'],
    ['not a URL', 'shell.open', { target: 'url', url: 'javascript:alert(1)' }, 'url'],
    ['unknown shell target', 'shell.open', { target: 'exe', path: 'calc.exe' }, 'target'],
    ['folder target without path', 'shell.open', { target: 'folder' }, 'path'],
    ['upload file target without path', 'shell.open', { target: 'uploadFile' }, 'path'],
    ['upload file with neither folder nor run', 'deploy.uploadFile', {}, 'request'],
    ['build with neither folder nor run', 'deploy.build', {}, 'request'],
    [
      'an Easy need answered with a way it does not have',
      'easy.create',
      {
        idea: 'x',
        kind: 'app',
        folder,
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: false,
        needs: { ai: 'email' },
      },
      'needs',
    ],
    ['an Easy stack that is not one', 'easy.resolve', { idea: 'x', stack: 'vue' }, 'stack'],
    ['build trust hash that is no sha256', 'deploy.build', { folder, trustHash: 'abc' }, 'trustHash'],
    ['run target with a step typo', 'shell.open', { target: 'rawLog', runId, step: 'verify' }, 'step'],
    [
      'patch op without value',
      'config.patch',
      { scope: 'user', ops: [{ op: 'add', path: '/auto' }] },
      'ops[0].value',
    ],
    [
      'patch remove with value',
      'config.patch',
      { scope: 'user', ops: [{ op: 'remove', path: '/auto', value: 1 }] },
      'ops[0]',
    ],
    [
      'patch op unknown',
      'config.patch',
      { scope: 'user', ops: [{ op: 'move', path: '/a', from: '/b' }] },
      'ops[0].op',
    ],
    [
      'patch path not a pointer',
      'config.patch',
      { scope: 'user', ops: [{ op: 'remove', path: 'auto' }] },
      'ops[0].path',
    ],
    [
      'patch path bad escape',
      'config.patch',
      { scope: 'user', ops: [{ op: 'remove', path: '/a~2b' }] },
      'ops[0].path',
    ],
    [
      'patch whole document',
      'config.patch',
      { scope: 'user', ops: [{ op: 'remove', path: '' }] },
      'ops[0].path',
    ],
    [
      'patch value undefined',
      'config.patch',
      { scope: 'user', ops: [{ op: 'replace', path: '/auto', value: undefined }] },
      'ops[0].value',
    ],
    [
      'patch value a Date',
      'config.patch',
      { scope: 'user', ops: [{ op: 'replace', path: '/a', value: new Date(0) }] },
      'ops[0].value',
    ],
    [
      'patch value nested NaN',
      'config.patch',
      { scope: 'user', ops: [{ op: 'add', path: '/a', value: { b: [Number.NaN] } }] },
      'ops[0].value',
    ],
    ['unknown scope', 'config.read', { scope: 'global' }, 'scope'],
    ['row save without pass', 'config.save', { scope: 'user', overrides: {}, mode: 'row' }, 'pass'],
    ['unknown save mode', 'config.save', { scope: 'user', overrides: {}, mode: 'all' }, 'mode'],
    ['prompt name verify', 'prompts.get', { name: 'verify' }, 'name'],
    ['save an internal prompt', 'prompts.save', { name: 'heal', scope: 'user', text: 'x' }, 'name'],
    [
      'empty command argv',
      'trust.set',
      {
        folder,
        trusted: true,
        grant: { kind: 'command', command: { kind: 'verify', argv: [], cwdRel: '' } },
      },
      'grant.command.argv',
    ],
    [
      'bad projectSha',
      'trust.set',
      { folder, trusted: true, grant: { kind: 'projectAuto', projectSha: 'abc' } },
      'grant.projectSha',
    ],
    ['unknown grant', 'trust.set', { folder, trusted: true, grant: { kind: 'everything' } }, 'grant.kind'],
    [
      'a recipe grant without its recipe',
      'trust.set',
      { folder, trusted: true, grant: { kind: 'recipeAuto' } },
      'grant.recipeId',
    ],
    [
      'a recipe grant for a path, not an id',
      'trust.set',
      { folder, trusted: true, grant: { kind: 'recipeAuto', recipeId: '../evil' } },
      'grant.recipeId',
    ],
    ['a recipe id with capitals', 'runs.start', { folder, task: 'x', recipe: 'Bug-Fix' }, 'recipe'],
    ['a recipe id that is a path', 'estimates.get', { folder, recipe: '../x' }, 'recipe'],
    ['trusted as string', 'trust.set', { folder, trusted: 'yes', grant: { kind: 'largeFolder' } }, 'trusted'],
    ['vendor id with capitals', 'vendors.setPath', { vendor: 'Claude', path: null }, 'vendor'],
    ['unknown run status', 'runs.list', { status: ['done'] }, 'status[0]'],
    ['list limit 0', 'runs.list', { limit: 0 }, 'limit'],
    ['refresh without consent', 'catalog.refresh', { consent: false }, 'consent'],
    [
      'negative price',
      'catalog.savePrice',
      {
        entry: {
          vendor: 'claude',
          model: 'm',
          inputPerMTok: -1,
          outputPerMTok: 1,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      },
      'entry.inputPerMTok',
    ],
    ['schedule of 0 days', 'catalog.setSchedule', { intervalDays: 0 }, 'intervalDays'],
    ['bad folder key', 'storage.clearShadow', { folderKey: '../../x' }, 'folderKey'],
    ['unknown theme', 'ui.setTheme', { theme: 'sepia' }, 'theme'],
    ['unknown stats range', 'stats.get', { range: '1y' }, 'range'],
    ['usage range it does not keep', 'usage.get', { range: '24h' }, 'range'],
    ['negative clock advance', 'e2e.clock', { advanceMs: -5 }, 'advanceMs'],
    ['unknown power event', 'e2e.power', { event: 'hibernate' }, 'event'],
    ['privileged MCP port', 'mcp.external.set', { port: 80 }, 'port'],
    ['MCP port out of range', 'mcp.external.set', { port: 70_000 }, 'port'],
    ['fractional MCP port', 'mcp.external.set', { port: 4782.5 }, 'port'],
    ['token in a set request', 'mcp.external.set', { token: 'mine' }, 'request'],
    ['unknown editor', 'mcp.addToEditor', { editor: 'emacs' }, 'editor'],
    ['an editor command from the page', 'mcp.addToEditor', { editor: 'vscode', command: 'calc' }, 'request'],
    ['install as a string', 'mcp.external.codexPlugin', { install: 'yes' }, 'install'],
    ['Claude install as a string', 'mcp.external.claudePlugin', { install: 'yes' }, 'install'],
    ['empty request id', 'mcp.requests.approve', { id: '' }, 'id'],
    ['a preview with no target', 'preview.detect', {}, 'request'],
    [
      'a preview URL from the page',
      'preview.open',
      { sessionId: 'pv_abc', target: 'app', url: 'https://x.test' },
      'request',
    ],
    ['an unknown open target', 'preview.open', { sessionId: 'pv_abc', target: 'tab' }, 'target'],
    ['a preview start with no command', 'preview.start', { folder }, 'commandId'],
    ['a deploy report with no target', 'deploy.inspect', {}, 'request'],
    ['an unknown deliverable class', 'deploy.inspect', { folder, cls: 'mainframe' }, 'cls'],
    ['a checklist item that is not an id', 'deploy.tick', { folder, item: '../x', ticked: true }, 'item'],
    ['an empty commit message', 'git.commit', { runId, message: '   ' }, 'message'],
    ['a pull request without its confirmation', 'git.prCreate', { runId }, 'confirm'],
    [
      'a pull request for a repository that is not owner/name',
      'git.prCreate',
      { runId, confirm: { remote: 'origin', repo: 'https://evil.test/x', branch: 'dim/x' } },
      'confirm.repo',
    ],
    [
      'a pull request branch with shell syntax',
      'git.prCreate',
      { runId, confirm: { remote: 'origin', repo: 'acme/shop', branch: 'x;rm -rf' } },
      'confirm.branch',
    ],
    ['a queue with no task', 'queue.add', { folder, tasks: [] }, 'tasks'],
    ['an empty task', 'queue.add', { folder, tasks: [{ task: '' }] }, 'tasks[0].task'],
    [
      'a queued task with a recipe that is not an id',
      'queue.add',
      { folder, tasks: [{ task: 'x', recipe: '../x' }] },
      'tasks[0].recipe',
    ],
    ['a task id that is not one', 'queue.remove', { folder, id: '../t' }, 'id'],
    ['a negative queue position', 'queue.move', { folder, id: taskId, to: -1 }, 'to'],
    ['a fractional queue position', 'queue.move', { folder, id: taskId, to: 1.5 }, 'to'],
    ['an empty folder list to start', 'queue.start', { folders: [] }, 'folders'],
    ['a report date that is not a date', 'queue.report', { date: 'yesterday' }, 'date'],
    ['a TODO file with a NUL', 'queue.importTodo', { folder, file: 'a\u0000b' }, 'file'],
    ['a memory update id with a path', 'memory.apply', { folder, id: '../x' }, 'id'],
    ['a memory read without a folder', 'memory.get', {}, 'folder'],
    [
      'explicit undefined optional',
      'runs.resume',
      { runId, allowTimedOutAsk: undefined },
      'allowTimedOutAsk',
    ],
  ]

  it.each(cases)('%s', (_label, cmd, raw, path) => {
    expectInvalid(cmd, raw, path)
  })

  it('accepts a task at exactly 100 KB of UTF-8, counting multibyte characters', () => {
    expect(parseRequest('runs.start', { folder, task: big(TASK_MAX_BYTES) }).ok).toBe(true)
    expect(parseRequest('runs.start', { folder, task: 'é'.repeat(TASK_MAX_BYTES / 2) }).ok).toBe(true)
    expect(parseRequest('runs.start', { folder, task: '😀'.repeat(TASK_MAX_BYTES / 4) }).ok).toBe(true)
    expect(parseRequest('runs.start', { folder, task: '😀'.repeat(TASK_MAX_BYTES / 4) + 'x' }).ok).toBe(false)
  })

  it('reports the first issue in the message and every issue in details', () => {
    const r = parseRequest('runs.events', { runId: '', sinceSeq: -1, extra: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toMatch(/^runId: .+ \(and 2 more\)$/)
    const details = r.error.details as { path: unknown[] }[]
    expect(details.map((d) => d.path)).toEqual(expect.arrayContaining([['runId'], ['sinceSeq'], []]))
  })

  it('returns a parsed copy, not the input object', () => {
    const req = { runId, sinceSeq: 3 }
    const r = parseRequest('runs.events', req)
    expect(r.ok && r.value).toEqual(req)
    expect(r.ok && r.value).not.toBe(req)
  })
})

describe('parseRequest command lookup', () => {
  it.each(['runs.nope', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'answers UNKNOWN_COMMAND for %j',
    (cmd) => {
      const r = parseRequest(cmd as Cmd, {})
      expect(r).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${cmd}".` },
      })
    },
  )

  it('answers UNKNOWN_COMMAND for a non-string command', () => {
    const r = parseRequest(42 as unknown as Cmd, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_COMMAND')
  })
})

describe('shared bounds', () => {
  it('RUN_EVENTS_MAX_LIMIT is the bus replay cap', () => {
    expect(RUN_EVENTS_MAX_LIMIT).toBe(REPLAY_MAX_LIMIT)
  })

  it('utf8ByteLength matches TextEncoder', () => {
    const enc = new TextEncoder()
    for (const s of [
      '',
      'abc',
      'é',
      '€',
      '😀',
      'a😀b€é',
      '\ud800',
      'x\udc00y',
      '\ud83d',
      '\ud83d\ude00\ud83d',
    ]) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(enc.encode(s).length)
    }
  })
})
