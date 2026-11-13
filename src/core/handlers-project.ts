// New project's commands: `templates.list` (the built-in and user templates, checked against their packs) and
// `project.create` (check and create the folder, git init it, save the template's Brief for it, and answer the task,
// Brief and recipe the run starts with). app-core implements ProjectHost; without one these answer UNSUPPORTED.
import type { ProjectCreated, ProjectCreateRequest, TemplatesList } from '../shared/templates.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'

export interface ProjectHost {
  templates(): Promise<TemplatesList>
  create(req: ProjectCreateRequest): Promise<ProjectCreated>
}

export function projectHandlers(ctx: HandlerContext): HandlerMap {
  const host = (): ProjectHost => {
    const h = ctx.project
    if (h === undefined)
      throw new DimFactoryError('UNSUPPORTED', 'New project is not available in this build.')
    return h
  }
  return {
    'templates.list': () => host().templates(),
    'project.create': (req) => {
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      if (typeof req.folder !== 'string' || req.folder.trim() === '') {
        throw new DimFactoryError('VALIDATION', 'Enter the full path of the new project folder.')
      }
      if (typeof req.templateId !== 'string' || req.templateId === '') {
        throw new DimFactoryError('VALIDATION', 'Choose a template.')
      }
      return host().create({
        folder: req.folder,
        templateId: req.templateId,
        ...(typeof req.goal === 'string' && req.goal.trim() !== '' ? { goal: req.goal } : {}),
      })
    },
  }
}
