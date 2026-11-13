import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  APP_EVENT_KINDS,
  CMD_CHANNEL,
  COMMAND_AREA,
  EVT_CHANNEL,
  IPC_PROTOCOL,
  RESULT_CODES,
} from '@shared/ipc.ts'
import type {
  AppEvent,
  AppEventOf,
  Cmd,
  CommandCall,
  DimFactoryApi,
  InvokeArgs,
  Req,
  Res,
  Result,
  ResultCode,
} from '@shared/ipc.ts'
import type { RunSnapshot } from '@shared/run.ts'

// Every command the IPC contract names.
const PLAN_COMMANDS = [
  'app.info',
  'app.ready',
  'app.quit',
  'dialog.pickFolder',
  'dialog.pickFiles',
  'shell.open',
  'log.write',
  'diagnostics.build',
  'diagnostics.copy',
  'diagnostics.save',
  'events.focus',
  'state.get',
  'state.set',
  'runs.start',
  'runs.list',
  'runs.get',
  'runs.events',
  'runs.output',
  'runs.stop',
  'runs.close',
  'runs.resume',
  'runs.retryPass',
  'runs.skipPass',
  'runs.keepWaiting',
  'runs.switchToAuto',
  'runs.rerun',
  'runs.pin',
  'runs.remove',
  'runs.undoRemove',
  'runs.branch',
  'asks.answer',
  'asks.undo',
  'cards.resolve',
  'recovery.execute',
  'heal.diagnose',
  'diff.files',
  'diff.file',
  'diff.blob',
  'diff.revert',
  'diff.undoRevert',
  'diff.markReviewed',
  'worktree.preview',
  'worktree.apply',
  'worktree.undoApply',
  'worktree.discard',
  'worktree.undoDiscard',
  'preflight.run',
  'depth.decide',
  'matches.start',
  'matches.get',
  'matches.list',
  'matches.pick',
  'matches.undoPick',
  'matches.blind',
  'matches.compare',
  'matches.compareFile',
  'matches.rematch',
  'matches.rematchCheck',
  'matches.savePatch',
  'matches.scoreboard',
  'matches.batchPlan',
  'matches.batchAdd',
  'matches.offers',
  'matches.dismissOffer',
  'task.check',
  'task.sharpen',
  'vendors.list',
  'vendors.probe',
  'vendors.setPath',
  'vendors.models',
  'config.resolve',
  'config.read',
  'config.save',
  'config.patch',
  'config.restoreBackup',
  'extensions.discover',
  'extensions.claudeConnectors',
  'prompts.get',
  'prompts.save',
  'ui.setTheme',
  'folders.recent',
  'git.init',
  'trust.get',
  'trust.set',
  'verify.detect',
  'guardrails.suggest',
  'guardrails.state',
  'guardrails.prove',
  'dashboard.get',
  'stats.get',
  'usage.get',
  'context.report',
  'estimates.get',
  'catalog.get',
  'catalog.refreshPlan',
  'catalog.refresh',
  'catalog.cancel',
  'catalog.apply',
  'catalog.undo',
  'catalog.savePrice',
  'catalog.setSchedule',
  'storage.usage',
  'storage.clearShadow',
  'notifications.test',
  'notifications.repairShortcut',
  'e2e.state',
  'e2e.power',
  'e2e.clock',
  'mcp.external.get',
  'mcp.external.set',
  'mcp.external.codexPlugin',
  'mcp.external.claudePlugin',
  'mcp.addToEditor',
  'mcp.requests.list',
  'mcp.requests.approve',
  'mcp.requests.decline',
  'brief.detect',
  'brief.save',
  'brief.suggest',
  'recipes.list',
  'preview.detect',
  'preview.start',
  'preview.trust',
  'preview.stop',
  'preview.list',
  'preview.open',
  'preview.openPair',
  'preview.smoke',
  'preview.savePdf',
  'preview.playtest',
  'preview.tryIt',
  'preview.shareCheck',
  'preview.network',
  'preview.phone',
  'deploy.inspect',
  'deploy.tick',
  'deploy.uploadFile',
  'deploy.build',
  'git.commitPreview',
  'git.commit',
  'git.prPreview',
  'git.prCreate',
  'templates.list',
  'project.create',
  'queue.get',
  'queue.add',
  'queue.remove',
  'queue.move',
  'queue.retry',
  'queue.clear',
  'queue.importTodo',
  'queue.githubCheck',
  'queue.importGithub',
  'queue.start',
  'queue.pause',
  'queue.dismissNotice',
  'queue.report',
  'memory.get',
  'memory.apply',
  'memory.dismiss',
  'runs.limits',
  'easy.state',
  'easy.setExperience',
  'easy.resolve',
  'easy.create',
  'easy.change',
  'easy.changeEstimate',
  'easy.projects',
  'easy.attachCheck',
  'easy.permissions',
  'easy.permission',
  'easy.revokePermission',
  'easy.inspectFolder',
  'easy.work',
  'easy.intent',
  'easy.visual',
  'easy.visualReview',
  'easy.helperCost',
  'easy.think',
  'easy.ask',
  'easy.shareFiles',
  'easy.queue',
  'easy.queueAdd',
  'easy.queueStart',
  'easy.queuePause',
  'easy.queueRemove',
] as const

describe('IPC contract', () => {
  it('uses the plan channels', () => {
    expect(CMD_CHANNEL).toBe('dimf:cmd')
    expect(EVT_CHANNEL).toBe('dimf:evt')
    expect(IPC_PROTOCOL).toBe(1)
  })

  it('declares every command from the plan and nothing else', () => {
    expectTypeOf<(typeof PLAN_COMMANDS)[number]>().toEqualTypeOf<Cmd>()
    expectTypeOf<keyof typeof COMMAND_AREA>().toEqualTypeOf<Cmd>()
    expect(Object.keys(COMMAND_AREA).sort()).toEqual([...PLAN_COMMANDS].sort())
    expect(PLAN_COMMANDS).toHaveLength(186)
  })

  it('tags exactly the e2e.* commands as E2E-only', () => {
    const e2e = Object.entries(COMMAND_AREA)
      .filter(([, area]) => area === 'e2e')
      .map(([cmd]) => cmd)
    expect(e2e.sort()).toEqual(['e2e.clock', 'e2e.power', 'e2e.state'])
  })

  it('tags the queue.* and memory.* commands as the factory area', () => {
    const factory = Object.entries(COMMAND_AREA)
      .filter(([, area]) => area === 'factory')
      .map(([cmd]) => cmd)
    expect(factory.sort()).toEqual(
      PLAN_COMMANDS.filter((c) => c.startsWith('queue.') || c.startsWith('memory.')).sort(),
    )
  })

  it('declares the plan result codes', () => {
    expect(RESULT_CODES).toHaveLength(15)
    expect(new Set(RESULT_CODES).size).toBe(15)
    expectTypeOf<(typeof RESULT_CODES)[number]>().toEqualTypeOf<ResultCode>()
    expectTypeOf<'PREFLIGHT_BLOCKED'>().toExtend<ResultCode>()
  })

  it('declares every AppEvent kind', () => {
    expectTypeOf<(typeof APP_EVENT_KINDS)[number]>().toEqualTypeOf<AppEvent['kind']>()
    expect(APP_EVENT_KINDS).toHaveLength(17)
    expect(APP_EVENT_KINDS).toContain('queue')
    expect(APP_EVENT_KINDS).toContain('memory')
    expectTypeOf<AppEventOf<'heartbeat'>>().toEqualTypeOf<{ kind: 'heartbeat'; at: number }>()
  })

  it('types requests, responses and invoke arguments per command', () => {
    expectTypeOf<Res<'runs.get'>>().toEqualTypeOf<RunSnapshot>()
    expectTypeOf<Req<'catalog.refresh'>['consent']>().toEqualTypeOf<true>()
    expectTypeOf<InvokeArgs<'app.info'>>().toEqualTypeOf<[req?: undefined]>()
    expectTypeOf<InvokeArgs<'runs.stop'>>().toEqualTypeOf<[req: { runId: string }]>()
    expectTypeOf<Extract<CommandCall, { cmd: 'runs.pin' }>['req']>().toEqualTypeOf<
      { runId: string } & { pinned: boolean }
    >()
  })

  it('lets a DimFactoryApi implementation be called with checked arguments', async () => {
    const calls: unknown[][] = []
    const api: DimFactoryApi = {
      invoke: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve<Result<never>>({
          ok: false,
          error: { code: 'UNSUPPORTED', message: 'not in this build' },
        })
      },
      subscribe: () => () => undefined,
      platform: 'win32',
      initialTheme: { theme: 'system', resolved: 'dark', accent: 'slate' },
    }
    const info = await api.invoke('app.info')
    await api.invoke('runs.get', { runId: '20261005T010203Z-abcd' })
    // @ts-expect-error -- runs.get requires its request
    await api.invoke('runs.get')
    // @ts-expect-error -- consent must be literally true
    await api.invoke('catalog.refresh', { consent: false })
    expect(info.ok).toBe(false)
    if (!info.ok) expect(info.error.code).toBe('UNSUPPORTED')
    expect(calls).toHaveLength(4)
  })
})
