// The New project dialog as pure logic: the folder it would create (parent folder + project name), why Create is not
// ready yet, the templates grouped by category, and its words.
import type { Platform } from '@shared/ipc.ts'
import type { TemplatesList, TemplateView } from '@shared/templates.ts'
import { isAbsoluteFolder } from '../../pages/dashboard/composer-model.ts'

export const NEW_PROJECT_TITLE = 'New project'
export const NEW_PROJECT_LABEL = 'New project…'
export const CREATE_LABEL = 'Create project'
export const COPY_LABEL = 'Copy'
export const COPIED_LABEL = 'Copied'
export const COPY_LABELS: readonly string[] = [COPY_LABEL, COPIED_LABEL]
export const GOAL_LABEL = 'What should it do?'
export const GOAL_PLACEHOLDER = 'Optional, e.g. A tip calculator that splits the bill between friends'
export const NO_STARTER_TEXT =
  'No official starter command for this template: the run builds the scaffold from the task.'
export const STARTER_HINT =
  'Prefer the official starter? Run it in the new folder before you press Run; the run then builds on what it created.'
export const NEW_PROJECT_DESCRIPTION =
  'Dim Factory creates the folder and initializes git (no commit). The template fills the task and the Brief; you press Run.'

/** A project name: one folder name, no path. */
export function nameProblem(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Name the project'
  if (/[\\/]/.test(n)) return 'The name is one folder name, without slashes'
  if (n === '.' || n === '..') return 'Choose another name'
  if (/[<>:"|?*]/.test(n) || [...n].some((c) => c.charCodeAt(0) < 0x20)) {
    return 'The name has a character folders cannot have'
  }
  return null
}

/** The new folder: the parent and the name joined with the platform's separator ('' until both make sense). */
export function projectFolder(parent: string, name: string, platform: Platform): string {
  const p = parent.trim()
  const n = name.trim()
  if (!isAbsoluteFolder(p) || nameProblem(n) !== null) return ''
  const sep = platform === 'win32' ? '\\' : '/'
  // Without its trailing separators, a root too: C:\ + app = C:\app, / + app = /app.
  return `${p.replace(/[\\/]+$/, '')}${sep}${n}`
}

/** The parent of a folder ('' when it has none we can tell). */
export function parentOf(folder: string): string {
  const f = folder.trim().replace(/[\\/]+$/, '')
  if (!isAbsoluteFolder(f)) return ''
  const i = Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/'))
  if (i <= 0) return f.startsWith('/') ? '/' : ''
  const head = f.slice(0, i)
  return /^[A-Za-z]:$/.test(head) ? `${head}\\` : head
}

/** Why Create is not ready (null: it is). */
export function createProblem(
  parent: string,
  name: string,
  templateId: string | null,
  loading: boolean,
): string | null {
  if (loading) return 'Loading the templates…'
  if (templateId === null) return 'Choose a template'
  if (parent.trim() === '') return 'Choose the parent folder'
  if (!isAbsoluteFolder(parent)) return 'Enter the full path of the parent folder'
  return nameProblem(name)
}

export interface TemplateGroup {
  pack: { id: string; label: string }
  templates: TemplateView[]
}

/** The templates by category, in the packs' order (categories without a template are left out). */
export function groupTemplates(list: TemplatesList): TemplateGroup[] {
  return list.packs
    .map((pack) => ({ pack, templates: list.templates.filter((v) => v.template.pack === pack.id) }))
    .filter((g) => g.templates.length > 0)
}
