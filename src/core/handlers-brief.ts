// The Brief's commands: `brief.detect` (the packs, the folder's facts and the task text's keyword choices, no
// tokens), `brief.save` (the folder's brief, or Reset) and `brief.suggest` (one read-only model call, only when the
// user asks). app-core implements BriefHost; without one these answer UNSUPPORTED.
import { isAbsolute, resolve } from 'node:path'
import type { RunOverrides } from '../shared/config-schema.ts'
import type { BriefContext, BriefInput, BriefSuggestResult } from '../shared/brief.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'

export interface BriefHost {
  detect(req: { folder?: string; task?: string }): Promise<BriefContext>
  save(folder: string, brief: BriefInput | null): Promise<void>
  suggest(req: {
    folder: string
    task: string
    brief: BriefInput
    overrides?: RunOverrides
  }): Promise<BriefSuggestResult>
}

const absolute = (folder: string): string => (isAbsolute(folder) ? folder : resolve(folder))

export function briefHandlers(ctx: HandlerContext): HandlerMap {
  const host = (): BriefHost => {
    const h = ctx.brief
    if (h === undefined) throw new DimFactoryError('UNSUPPORTED', 'The Brief is not available in this build.')
    return h
  }
  return {
    'brief.detect': (req) =>
      host().detect({
        ...(req.folder !== undefined && req.folder.trim() !== '' ? { folder: absolute(req.folder) } : {}),
        ...(req.task !== undefined ? { task: req.task } : {}),
      }),
    'brief.save': (req) => {
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return host().save(absolute(req.folder), req.brief)
    },
    'brief.suggest': (req) =>
      host().suggest({
        folder: absolute(req.folder),
        task: req.task,
        brief: req.brief,
        ...(req.overrides !== undefined ? { overrides: req.overrides } : {}),
      }),
  }
}
