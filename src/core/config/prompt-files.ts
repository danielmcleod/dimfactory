// Prompt overrides (lookup; IPC `prompts.get` / `prompts.save`): `<home>/prompts/<pass>.md` (user)
// and `<projectRoot>/.dimfactory/prompts/<pass>.md` (project, next to the project dimfactory.json). A save validates the
// template (line-numbered errors refuse it; a missing required placeholder is only a warning), backs up the text it
// replaces (ten per prompt) and writes atomically; `text: null` removes the override so the next layer down applies
// again. Settings → Prompts: the view carries the text's placeholders and issues, which scopes override it,
// and after a save what the scope held before (the undo toast puts it back).
import { access, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigScope } from '../../shared/config-schema.ts'
import type { EditablePromptName, PromptIssue, PromptName, PromptView } from '../../shared/ipc.ts'
import { isStepPromptName, stepPromptKind } from '../../shared/prompt-names.ts'
import { isPassName } from '../../shared/run.ts'
import type { TemplatePass } from '../prompts/resolve.ts'

/**
 * A prompt the user may see and edit: a pass's, Test-first's Tests step's, or an optional step's (Clarify, Research,
 * the acceptance review, Explain, Deploy and the plain-words twins). The re-check's stays Dim Factory-internal.
 */
type EditablePrompt = EditablePromptName | 'tests'

import { DimFactoryError, errnoCode, storageError } from '../errors.ts'
import { homePaths, projectPaths } from '../home.ts'
import { readBuiltinTemplate, resolvePromptTemplate } from '../prompts/resolve.ts'
import { TEMPLATE_SPECS, formatIssue, normalizeText, validateTemplate } from '../prompts/template.ts'
import type { TemplateIssue } from '../prompts/template.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { BACKUPS_KEEP, newBackupId, readConfigText, withConfigLocks } from './backups.ts'
import { projectBackupDir } from './paths.ts'

export interface PromptFileOptions {
  /** DIM_FACTORY_HOME. */
  home: string
  /** The folder holding the project's `.dimfactory/` (omitted: no project layer). */
  projectRoot?: string
  /**
   * The project's folderKey: project prompt backups live in `prompts/` under the project file's backup directory
   * (`backups/project/<folderKey>/[<fileKey>/]`, paths.ts projectBackupDir).
   */
  folderKey?: string
  /** The scope root (tells a subfolder's own `.dimfactory/` from the scope root's). Omitted: projectRoot is the root. */
  scopeRoot?: string | null
  /** Test seam for the builtin prompt directory. */
  builtinDir?: string
}

const isTemplatePass = (name: unknown): name is EditablePrompt =>
  isPassName(name) || name === 'tests' || isStepPromptName(name)

/** The template kind a prompt is checked as (its placeholders): a plain-words twin is its step's. */
export function promptKind(name: EditablePrompt): TemplatePass {
  return isStepPromptName(name) ? stepPromptKind(name) : name
}

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w !== '').length

function requiredOf(pass: TemplatePass): string[] {
  const spec = TEMPLATE_SPECS[pass]
  return [...spec.required, ...(spec.requiredWhenPlan ?? [])]
}

const toPromptIssue = (i: TemplateIssue): PromptIssue => ({
  code: i.code,
  severity: i.severity,
  message: i.message,
  ...(i.line !== undefined ? { line: i.line } : {}),
  ...(i.col !== undefined ? { col: i.col } : {}),
  ...(i.name !== undefined ? { name: i.name } : {}),
})

/** A template's problems as the Prompts tab shows them (implement checked as if Plan runs, like a save). */
export function promptIssues(
  text: string,
  name: TemplatePass,
): { placeholders: string[]; issues: PromptIssue[] } {
  const v = validateTemplate(normalizeText(text), name, { planEnabled: true })
  return { placeholders: v.placeholders, issues: v.issues.map(toPromptIssue) }
}

const fileExists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  )

/** `prompts.get`: the text a pass's default template name resolves to (project → user → builtin). */
export function getPrompt(name: PromptName, o: PromptFileOptions): PromptView {
  if (!isTemplatePass(name)) {
    throw new DimFactoryError('UNSUPPORTED', `The ${name} prompt is not available in this build.`)
  }
  const kind = promptKind(name)
  const found = resolvePromptTemplate(name, {
    pass: kind,
    home: o.home,
    ...(o.projectRoot !== undefined ? { folder: o.projectRoot } : {}),
    ...(o.builtinDir !== undefined ? { builtinDir: o.builtinDir } : {}),
  })
  return {
    name,
    text: found.text,
    source: found.layer,
    path: found.layer === 'builtin' ? null : found.path,
    defaultText: readBuiltinTemplate(name, o.builtinDir),
    allowed: [...TEMPLATE_SPECS[kind].allowed],
    required: requiredOf(kind),
    wordCount: wordCount(found.text),
    editable: !TEMPLATE_SPECS[kind].internal,
    ...promptIssues(found.text, kind),
  }
}

/** `prompts.get` with which scopes hold an override (the Prompts tab's scope chips and badge). */
export async function getPromptView(name: PromptName, o: PromptFileOptions): Promise<PromptView> {
  const view = getPrompt(name, o)
  if (!isTemplatePass(name)) return view
  const [user, project] = await Promise.all([
    fileExists(homePaths(o.home).userPrompt(name)),
    o.projectRoot !== undefined
      ? fileExists(projectPaths(o.projectRoot).prompt(name))
      : Promise.resolve(null),
  ])
  return { ...view, overrides: { user, project } }
}

/** Where a scope's override of `name` lives, and where its backups go. */
export function promptOverridePaths(
  name: EditablePrompt,
  scope: ConfigScope,
  o: PromptFileOptions,
): { path: string; backupDir: string; fileMode: number; dirMode: number } {
  const hp = homePaths(o.home)
  if (scope === 'user') {
    return {
      path: hp.userPrompt(name),
      backupDir: join(hp.backupsDir, 'prompts'),
      fileMode: 0o600,
      dirMode: 0o700,
    }
  }
  if (o.projectRoot === undefined || o.folderKey === undefined) {
    throw new DimFactoryError('VALIDATION', 'A project prompt needs a folder')
  }
  const config = projectPaths(o.projectRoot).config
  return {
    path: projectPaths(o.projectRoot).prompt(name),
    backupDir: join(projectBackupDir(hp, o.folderKey, o.scopeRoot, config), 'prompts'),
    fileMode: 0o644,
    dirMode: 0o755,
  }
}

async function backupPrompt(backupDir: string, name: EditablePrompt, data: Uint8Array): Promise<string> {
  const id = newBackupId()
  await writeFileAtomic(join(backupDir, `${name}.${id}.md`), data, { mode: 0o600, dirMode: 0o700 })
  let names: string[] = []
  try {
    names = await readdir(backupDir)
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw storageError(`cannot list ${backupDir}`, err)
  }
  const mine = names
    .filter((n) => n.startsWith(`${name}.`) && n.endsWith('.md'))
    .sort()
    .reverse()
  for (const old of mine.slice(BACKUPS_KEEP)) await rm(join(backupDir, old), { force: true })
  return id
}

export interface SavePromptRequest extends PromptFileOptions {
  name: EditablePrompt
  scope: ConfigScope
  /** The new override text; null removes the override. */
  text: string | null
}

/**
 * `prompts.save`: validate (errors → VALIDATION with `file:line:col` issues), back up the replaced text, write
 * atomically (or remove the override). Returns the prompt as it now resolves.
 */
export async function savePrompt(req: SavePromptRequest): Promise<PromptView & { backupId: string | null }> {
  if (!isTemplatePass(req.name))
    throw new DimFactoryError('VALIDATION', `"${String(req.name)}" is not a prompt you can change`)
  const target = promptOverridePaths(req.name, req.scope, req)
  if (req.text !== null) {
    const v = validateTemplate(normalizeText(req.text), promptKind(req.name), { planEnabled: true })
    const errors = v.issues.filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      throw new DimFactoryError(
        'VALIDATION',
        `The ${req.name} prompt has ${errors.length === 1 ? 'an error' : `${errors.length} errors`}: ` +
          errors
            .slice(0, 3)
            .map((i) => formatIssue(i))
            .join('; '),
        { details: errors.map((i) => ({ ...i, file: target.path })) },
      )
    }
  }
  let previous: string | null = null
  const backupId = await withConfigLocks([target.path], async () => {
    const cur = await readConfigText(target.path)
    previous = cur?.text ?? null
    if (req.text === null) {
      if (cur === null) return null
      const id = await backupPrompt(target.backupDir, req.name, cur.bytes)
      try {
        await rm(target.path, { force: true })
      } catch (err) {
        throw storageError(`cannot remove ${target.path}`, err)
      }
      return id
    }
    if (cur?.utf8 === true && cur.text === req.text) return null
    const id = cur !== null ? await backupPrompt(target.backupDir, req.name, cur.bytes) : null
    await writeFileAtomic(target.path, req.text, { mode: target.fileMode, dirMode: target.dirMode })
    return id
  })
  return {
    ...(await getPromptView(req.name, req)),
    previous: { scope: req.scope, text: previous },
    backupId,
  }
}
