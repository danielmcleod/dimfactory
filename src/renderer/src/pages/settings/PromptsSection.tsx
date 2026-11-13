// Settings → Prompts (tabs; placeholder chips; Implement word count; user/project scope; diff vs default; reset
// with undo; template lookup: project `.dimfactory/prompts/<pass>.md` → your
// `prompts/<pass>.md` → built-in). One tab per pass. "Applies to" picks whose template is edited: yours (every project
// without its own) or one project's (chosen from recent folders or a folder dialog; saved in the project, so it travels
// with it). The text is core's (prompts.get, once the section has been open for LOAD_DELAY_MS, and again after any
// config change); a save goes through prompts.save, which refuses a text with template errors and names their lines,
// and every save or reset offers Undo (what the scope held before). Unsaved edits are kept per pass, scope and project
// while the app runs. Deep links `#/settings/prompts/<pass>?folder=…` (and core's `?field=/passes/<pass>/…`) open that
// tab for that project; nothing scrolls on its own.
import { useCallback, useEffect, useId, useState } from 'react'
import type { EditablePromptName, PromptIssue, PromptView } from '@shared/ipc.ts'
import { STEP_PROMPT_NAMES } from '@shared/prompt-names.ts'
import { PASS_NAMES } from '@shared/run.ts'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs.tsx'
import { invoke } from '../../ipc/client.ts'
import { useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { LOAD_DELAY_MS, ProjectFolder } from './general/ProjectFolder.tsx'
import { settingFieldProps } from './index.ts'
import { Group } from './kit.tsx'
import {
  isEditablePromptName,
  issuesFromError,
  previousText,
  promptKey,
  promptLabel,
  resetResult,
  SCOPE_LABEL,
} from './prompts/model.ts'
import type { PromptScope } from './prompts/model.ts'
import { PromptPanel } from './prompts/PromptPanel.tsx'

const UNDO_TOAST = 'prompts-undo'

export const LOOKUP_TEXT =
  "Dim Factory uses the first template it finds: the project's own (in the project's .dimfactory/prompts folder), then yours, then the built-in one."

// ---- unsaved edits (kept while the app runs, per pass, scope and project) ------------------------------------------

const drafts = new Map<string, string>()

export function resetPromptDraftsForTests(): void {
  drafts.clear()
}

// ---- deep links -----------------------------------------------------------------------------------------------------

interface Initial {
  pass: EditablePromptName
  scope: PromptScope
  folder: string | null
}

/** The tab, scope and project a route opens: `#/settings/prompts/<pass>?folder=…[&scope=user]`, or core's `?field=`. */
export function promptsLink(route: Route): Initial {
  if (route.name !== 'settings') return { pass: 'plan', scope: 'user', folder: null }
  const sub = route.subpath[0]
  const field = /^\/passes\/([^/]+)/.exec(route.query['field'] ?? '')?.[1]
  const pass: EditablePromptName = isEditablePromptName(sub)
    ? sub
    : isEditablePromptName(field)
      ? field
      : 'plan'
  const raw = route.query['folder'] ?? ''
  const folder = raw !== '' ? raw : null
  const asked = route.query['scope']
  const scope: PromptScope =
    asked === 'user' ? 'user' : asked === 'project' || folder !== null ? 'project' : 'user'
  return { pass, scope, folder }
}

function linkKey(route: Route): string {
  if (route.name !== 'settings') return ''
  return `${route.subpath.join('/')}?${new URLSearchParams(route.query).toString()}`
}

export function PromptsSection(): React.JSX.Element {
  const route = useRoute()
  return <PromptsBody key={linkKey(route)} initial={promptsLink(route)} />
}

// ---- the section ----------------------------------------------------------------------------------------------------

function PromptsBody({ initial }: { initial: Initial }): React.JSX.Element {
  const epoch = useConfigEpoch()
  const scopeName = useId()
  const [pass, setPass] = useState<EditablePromptName>(initial.pass)
  const [scope, setScope] = useState<PromptScope>(initial.scope)
  const [folder, setFolder] = useState<string | null>(initial.folder)
  const [views, setViews] = useState<Readonly<Record<string, PromptView>>>({})
  const [loadErrors, setLoadErrors] = useState<Readonly<Record<string, string>>>({})
  const [issues, setIssues] = useState<Readonly<Record<string, PromptIssue[]>>>({})
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<{ key: string; what: 'save' | 'reset' } | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [, setDraftVersion] = useState(0)

  const key = promptKey(pass, scope, folder)
  const needsFolder = scope === 'project' && folder === null
  const project = folder !== null ? folderBaseName(folder) : 'This project'

  useEffect(() => {
    if (needsFolder) return
    let alive = true
    const t = setTimeout(() => {
      void invoke(
        'prompts.get',
        scope === 'project' && folder !== null ? { name: pass, folder } : { name: pass },
      ).then((r) => {
        if (!alive) return
        if (r.ok) {
          setViews((v) => ({ ...v, [key]: r.value }))
          setLoadErrors((e) => {
            if (e[key] === undefined) return e
            const { [key]: _gone, ...rest } = e
            return rest
          })
        } else setLoadErrors((e) => ({ ...e, [key]: r.error.message }))
      })
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [key, pass, scope, folder, needsFolder, epoch, nonce])

  const view = needsFolder ? null : (views[key] ?? null)
  const loadError = loadErrors[key] ?? null
  const draft = drafts.get(key)
  const text = draft ?? view?.text ?? ''
  const dirty = view !== null && draft !== undefined && draft !== view.text

  const setDraft = useCallback((k: string, next: string | null): void => {
    if (next === null) drafts.delete(k)
    else drafts.set(k, next)
    setDraftVersion((n) => n + 1)
  }, [])

  const setView = (k: string, v: PromptView): void => setViews((cur) => ({ ...cur, [k]: v }))
  const setIssuesFor = (k: string, list: PromptIssue[] | null): void =>
    setIssues((cur) => {
      if (list === null) {
        if (cur[k] === undefined) return cur
        const { [k]: _gone, ...rest } = cur
        return rest
      }
      return { ...cur, [k]: list }
    })
  const markSaved = (k: string, on: boolean): void =>
    setSaved((cur) => {
      if (cur.has(k) === on) return cur
      const next = new Set(cur)
      if (on) next.add(k)
      else next.delete(k)
      return next
    })

  /** prompts.save for one pass as one scope sees it (the Undo uses the same target). */
  const saveText = (
    target: { pass: EditablePromptName; scope: PromptScope; folder: string | null },
    value: string | null,
  ) =>
    invoke('prompts.save', {
      name: target.pass,
      scope: target.scope,
      ...(target.scope === 'project' && target.folder !== null ? { folder: target.folder } : {}),
      text: value,
    })

  const write = async (what: 'save' | 'reset'): Promise<void> => {
    const before = view
    if (before === null) return
    const k = key
    const target = { pass, scope, folder }
    const where = target.scope === 'project' ? project : null
    setBusy({ key: k, what })
    const r = await saveText(target, what === 'save' ? text : null)
    setBusy(null)
    if (!r.ok) {
      if (r.error.code === 'VALIDATION') setIssuesFor(k, issuesFromError(r.error.details, r.error.message))
      else toast({ level: 'error', message: r.error.message })
      return
    }
    const after = r.value
    setView(k, after)
    setDraft(k, null)
    setIssuesFor(k, null)
    markSaved(k, what === 'save')
    const label = promptLabel(target.pass)
    const message =
      what === 'save'
        ? where !== null
          ? `Saved the ${label} prompt for ${where}. Runs there use it now.`
          : `Saved your ${label} prompt. Projects without their own use it now.`
        : where !== null
          ? `Removed ${where}'s ${label} prompt. Runs there use ${resetResult('project', after)} now.`
          : `Removed your ${label} prompt. The built-in one is used again.`
    const undoTo = previousText(before, after, target.scope)
    toast({
      id: UNDO_TOAST,
      level: 'info',
      message,
      action: {
        label: 'Undo',
        onClick: async () => {
          const u = await saveText(target, undoTo)
          if (!u.ok) {
            toast({ level: 'error', message: u.error.message })
            return
          }
          setView(k, u.value)
          markSaved(k, false)
        },
      },
    })
  }

  return (
    <div className="flex flex-col gap-6" data-testid="settings-prompts">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          The instructions Dim Factory gives the vendor for each pass and for the optional steps (Clarify,
          Research, the acceptance review, Explain, Deploy). Change one for yourself, in every project, or for
          one project only.
        </p>
        <p className="text-xs text-muted-foreground" data-testid="prompts-lookup">
          {LOOKUP_TEXT}
        </p>
      </div>

      <Group title="Applies to" description="Whose template you edit here.">
        <div {...settingFieldProps('scope')}>
          <div
            role="radiogroup"
            aria-label="Prompt scope"
            data-testid="prompts-scope"
            className="flex flex-wrap gap-x-5 gap-y-2"
          >
            {(['user', 'project'] as const).map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={scopeName}
                  value={s}
                  checked={scope === s}
                  data-testid={`prompts-scope-${s}`}
                  onChange={() => {
                    setScope(s)
                    setShowDiff(false)
                  }}
                  className="size-4 shrink-0 accent-primary"
                />
                {SCOPE_LABEL[s]}
              </label>
            ))}
          </div>
        </div>
        {scope === 'project' && (
          <>
            <ProjectFolder folder={folder} onChange={setFolder} testId="prompts-folder" />
            <p className="text-xs text-muted-foreground" data-testid="prompts-project-note">
              {folder === null
                ? "Choose the project. Its template is saved in the project's .dimfactory/prompts folder, and only runs in that project use it."
                : `Saved in ${project}'s .dimfactory/prompts folder. Only runs in ${project} use it; commit it to share it with your team.`}
            </p>
          </>
        )}
      </Group>

      <Tabs
        value={pass}
        onValueChange={(v) => {
          if (isEditablePromptName(v)) {
            setPass(v)
            setShowDiff(false)
          }
        }}
      >
        <TabsList aria-label="Prompt templates" className="h-auto min-h-9 flex-wrap">
          {PASS_NAMES.map((p) => (
            <TabsTrigger key={p} value={p} data-testid={`prompts-tab-${p}`}>
              {promptLabel(p)}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* The optional steps' templates, a row of their own under the passes' (always there: nothing moves). */}
        <TabsList
          aria-label="Step prompt templates"
          className="mt-1 h-auto min-h-9 flex-wrap"
          data-testid="prompts-step-tabs"
        >
          {STEP_PROMPT_NAMES.map((p) => (
            <TabsTrigger key={p} value={p} data-testid={`prompts-tab-${p}`}>
              {promptLabel(p)}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Only the open tab's panel is made (a section switch stays quick, performance.spec.ts). */}
        <TabsContent key={pass} value={pass} className="pt-2">
          <PromptPanel
            pass={pass}
            scope={scope}
            project={project}
            view={view}
            unavailable={
              needsFolder
                ? `Choose the project whose ${promptLabel(pass)} prompt you want to change.`
                : loadError !== null && view === null
                  ? `The template could not be read: ${loadError}`
                  : null
            }
            text={text}
            dirty={dirty}
            busy={busy !== null && busy.key === key ? busy.what : null}
            saved={saved.has(key)}
            issues={issues[key] ?? null}
            showDiff={showDiff}
            onText={(next) => {
              setDraft(key, view !== null && next === view.text ? null : next)
              setIssuesFor(key, null)
              markSaved(key, false)
            }}
            onSave={() => void write('save')}
            onDiscard={() => {
              setDraft(key, null)
              setIssuesFor(key, null)
            }}
            onReset={() => void write('reset')}
            onToggleDiff={() => setShowDiff((v) => !v)}
          />
        </TabsContent>
      </Tabs>
      {loadError !== null && view !== null && (
        <p role="alert" className="text-xs text-destructive">
          The template could not be read again: {loadError}{' '}
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={() => setNonce((n) => n + 1)}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  )
}
