// Prompt template lookup (Resolve step 6): for a `promptTemplate` name,
// project `<folder>/.dimfactory/prompts/<name>.md` → `DIM_FACTORY_HOME/prompts/<name>.md` → builtin
// `defaults/<name>.md` → builtin `defaults/<pass>.md`. The builtin texts are read from disk next to this module.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedTemplate } from '../../shared/config-schema.ts'
import { TemplateNameZ } from '../../shared/config-schema.ts'
import type { PassName } from '../../shared/run.ts'
import { resolveHome } from '../home.ts'
import { normalizeText, render, validateTemplate } from './template.ts'
import type { RenderOptions, RenderResult, TemplateValues } from './template.ts'
import { BRAND } from '../../shared/brand.ts'
import { STEP_PROMPT_NAMES, stepPromptKind } from '../../shared/prompt-names.ts'
import type { StepPromptName } from '../../shared/prompt-names.ts'

export type TemplateLayer = ResolvedTemplate['layer']

/**
 * A step with a prompt template: the configured passes, Test-first's Tests step (`tests.md`), the re-check after
 * Fix (`recheck.md`), Clarify before Plan (`clarify.md`), Research before Plan (`research.md`), the Deploy step
 * (`deploy.md`), the acceptance review (`acceptance.md`) and Explain it to me (`explain.md`). The re-check's is Dim
 * Factory-internal; the others' the user may override like a pass's (Settings › Prompts), and so may Clarify's and
 * Explain's plain-words twins (`clarify-easy.md`, `explain-easy.md`).
 */
export type TemplatePass =
  PassName | 'tests' | 'recheck' | 'clarify' | 'research' | 'deploy' | 'acceptance' | 'explain'

/** Directory holding the builtin `<pass>.md` texts. */
export const BUILTIN_PROMPTS_DIR = fileURLToPath(new URL('./defaults/', import.meta.url))

export interface ResolvedPrompt {
  /** The template name actually used (the pass name after a fallback). */
  name: string
  path: string
  layer: TemplateLayer
  /** sha256 of the normalized text (BOM stripped, LF), so it is stable across OSes and autocrlf. */
  sha256: string
  /** Normalized text. */
  text: string
  /** The name that was asked for (`null` in config means the pass name). */
  requested: string
  /** `requested` was not found anywhere, so the pass's builtin template is used instead. */
  fellBack: boolean
}

export interface ResolvePromptOptions {
  pass: TemplatePass
  /** The run folder (scopeRoot); omitted → no project layer. */
  folder?: string
  /** DIM_FACTORY_HOME; default {@link resolveHome}. */
  home?: string
  /** Test seam for the builtin directory. */
  builtinDir?: string
}

export class PromptResolveError extends Error {
  readonly path: string | undefined
  constructor(message: string, path?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PromptResolveError'
    this.path = path
  }
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Read a template file: normalized text + its sha256. `undefined` when the file does not exist. */
export function readTemplateFile(path: string): { text: string; sha256: string } | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new PromptResolveError(`Cannot read the prompt template ${path}: ${(err as Error).message}`, path, {
      cause: err,
    })
  }
  const text = normalizeText(raw)
  return { text, sha256: sha256Text(text) }
}

export function builtinTemplatePath(name: string, builtinDir: string = BUILTIN_PROMPTS_DIR): string {
  return join(builtinDir, `${name}.md`)
}

/** The builtin text for a pass (normalized). Throws when the packaged file is missing. */
export function readBuiltinTemplate(pass: string, builtinDir: string = BUILTIN_PROMPTS_DIR): string {
  const path = builtinTemplatePath(pass, builtinDir)
  const file = readTemplateFile(path)
  if (file === undefined)
    throw new PromptResolveError(`The builtin ${pass} template is missing (${path})`, path)
  return file.text
}

/** The lookup chain for `name`, in precedence order. */
export function templateCandidates(
  name: string,
  o: ResolvePromptOptions,
): { layer: TemplateLayer; path: string }[] {
  const home = o.home ?? resolveHome()
  const builtinDir = o.builtinDir ?? BUILTIN_PROMPTS_DIR
  const out: { layer: TemplateLayer; path: string }[] = []
  if (o.folder !== undefined)
    out.push({ layer: 'project', path: join(o.folder, BRAND.projectDirName, 'prompts', `${name}.md`) })
  out.push({ layer: 'user', path: join(home, 'prompts', `${name}.md`) })
  out.push({ layer: 'builtin', path: builtinTemplatePath(name, builtinDir) })
  return out
}

/**
 * Resolve a pass's `promptTemplate` (`null` → the pass name). Throws {@link PromptResolveError} for an invalid
 * name, an unreadable file, or a missing builtin.
 */
export function resolvePromptTemplate(
  name: string | null | undefined,
  o: ResolvePromptOptions,
): ResolvedPrompt {
  const requested = name ?? o.pass
  if (!TemplateNameZ.safeParse(requested).success) {
    throw new PromptResolveError(`"${String(requested)}" is not a valid prompt template name`)
  }
  for (const c of templateCandidates(requested, o)) {
    const file = readTemplateFile(c.path)
    if (file !== undefined)
      return { name: requested, path: c.path, layer: c.layer, ...file, requested, fellBack: false }
  }
  const path = builtinTemplatePath(o.pass, o.builtinDir ?? BUILTIN_PROMPTS_DIR)
  const file = readTemplateFile(path)
  if (file === undefined)
    throw new PromptResolveError(`The builtin ${o.pass} template is missing (${path})`, path)
  return { name: o.pass, path, layer: 'builtin', ...file, requested, fellBack: true }
}

/** The `resolved.json` shape (drops text and lookup details). */
export function toResolvedTemplate(p: ResolvedPrompt): ResolvedTemplate {
  return { name: p.name, path: p.path, layer: p.layer, sha256: p.sha256 }
}

/**
 * Render a pass prompt from a resolved template file; the builtin text for the pass supplies sections for
 * missing required placeholders. Re-reads `t.path` (the file may have changed since resolve).
 */
export function renderPassPrompt(
  pass: TemplatePass,
  t: Pick<ResolvedTemplate, 'path'>,
  values: TemplateValues,
  o: Omit<RenderOptions, 'template' | 'defaultText'> & { builtinDir?: string } = {},
): RenderResult & { sha256: string } {
  const file = readTemplateFile(t.path)
  if (file === undefined)
    throw new PromptResolveError(`The prompt template ${t.path} no longer exists`, t.path)
  const { builtinDir, ...rest } = o
  const result = render(file.text, values, {
    ...rest,
    template: pass,
    defaultText: readBuiltinTemplate(pass, builtinDir),
  })
  return { ...result, sha256: file.sha256 }
}

/** The optional steps' templates a run renders (resolved.json `stepTemplates`). */
export type StepTemplates = Partial<Record<StepPromptName, ResolvedTemplate>>

/**
 * Every optional step's template for a run made in `folder`: the project's override, else yours, else the built-in.
 * An override with template errors (a file edited by hand: Settings refuses to save one) is not used: the step renders
 * its built-in template, and `onInvalid` hears which file was passed over.
 */
export function resolveStepTemplates(
  o: { home: string; folder?: string; builtinDir?: string },
  onInvalid?: (name: StepPromptName, path: string) => void,
): StepTemplates {
  const out: StepTemplates = {}
  for (const name of STEP_PROMPT_NAMES) {
    const kind = stepPromptKind(name)
    const opts = {
      pass: kind,
      home: o.home,
      ...(o.folder !== undefined ? { folder: o.folder } : {}),
      ...(o.builtinDir !== undefined ? { builtinDir: o.builtinDir } : {}),
    }
    let found: ResolvedPrompt
    try {
      found = resolvePromptTemplate(name, opts)
    } catch {
      continue
    }
    if (found.layer !== 'builtin' && !validateTemplate(found.text, kind).ok) {
      onInvalid?.(name, found.path)
      const path = builtinTemplatePath(name, o.builtinDir ?? BUILTIN_PROMPTS_DIR)
      const file = readTemplateFile(path)
      if (file === undefined) continue
      out[name] = { name, path, layer: 'builtin', sha256: file.sha256 }
      continue
    }
    out[name] = toResolvedTemplate(found)
  }
  return out
}
