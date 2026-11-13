// Easy settings: where new projects go (the Documents folder's projects folder unless changed), the spending limit a
// new project and a change start with (none unless set), the time limit, whether the plan is shown before building, and
// the project permissions with Take it back (PermissionsList.tsx; also in Settings, Vendors). Each row saves through
// config.patch to the user file's `easy` section; everything else is in All settings.
// UI standards: Save and Change keep their labels; "Saved" and a row's problem are text beside them in a line that
// keeps its height.
import { FolderOpen, Settings } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { JsonPatchOp } from '@shared/failure.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { href } from '../../lib/router.ts'
import { loadExperience, useEasyState } from '../../state/experience.ts'
import { parseLimit, parseMinutes } from './model.ts'
import { PermissionsList } from './PermissionsList.tsx'
import {
  ALL_SETTINGS,
  CHANGE_FOLDER,
  CHANGE_LIMIT_LABEL,
  LIMIT_INPUT_LABEL,
  LIMIT_INVALID,
  LIMIT_NONE,
  NEW_LIMIT_LABEL,
  NO_TIME_LIMIT,
  PERMISSIONS_SETTINGS_NOTE,
  PLAN_CHECK_LABEL,
  ONEDRIVE_NOTE,
  PROJECTS_DIR_LABEL,
  SAVED,
  SAVE_LABEL,
  SETTINGS_INTRO,
  SETTINGS_TITLE,
  TIME_LIMIT_INPUT,
  TIME_LIMIT_LABEL,
  TIME_LIMIT_NOTE,
  USE_DEFAULT,
} from './text.ts'

type Key = 'projectsDir' | 'maxCostUsd' | 'changeMaxCostUsd' | 'maxMinutes' | 'skipPlanCheck'

async function save(key: Key, value: unknown): Promise<string | null> {
  const ops: JsonPatchOp[] =
    value === null ? [{ op: 'remove', path: `/easy/${key}` }] : [{ op: 'add', path: `/easy/${key}`, value }]
  const r = await invoke('config.patch', { scope: 'user', ops })
  if (!r.ok) {
    // Removing a key the file does not have is nothing to do.
    if (value === null) return null
    return r.error.message
  }
  await loadExperience()
  return null
}

function Status({ text, error }: { text: string; error: boolean }): React.JSX.Element {
  return (
    <span
      role="status"
      className={error ? 'min-h-5 text-sm text-destructive' : 'min-h-5 text-sm text-muted-foreground'}
    >
      {text}
    </span>
  )
}

function NumberRow({
  label,
  inputLabel,
  placeholder,
  note,
  value,
  parse,
  testId,
  onSave,
}: {
  label: string
  inputLabel: string
  placeholder: string
  note?: string
  value: number | null
  parse: (t: string) => number | null | undefined
  testId: string
  onSave: (v: number | null) => Promise<string | null>
}): React.JSX.Element {
  const [text, setText] = useState(value !== null ? String(value) : '')
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const id = useId()
  useEffect(() => setText(value !== null ? String(value) : ''), [value])
  const parsed = parse(text)
  return (
    <div className="flex flex-col gap-1.5 border-t py-4" data-testid={testId}>
      <h2 className="text-sm font-semibold">{label}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm">
          {inputLabel}
        </label>
        <Input
          id={id}
          inputMode="decimal"
          className="h-8 w-28"
          placeholder={placeholder}
          aria-invalid={parsed === undefined || undefined}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value)
            setStatus({ text: '', error: false })
          }}
        />
        <Button
          size="sm"
          variant="outline"
          loading={busy}
          data-testid={`${testId}-save`}
          onClick={() => {
            if (parsed === undefined) {
              setStatus({ text: LIMIT_INVALID, error: true })
              return
            }
            setBusy(true)
            void onSave(parsed).then((err) => {
              setBusy(false)
              setStatus(err === null ? { text: SAVED, error: false } : { text: err, error: true })
            })
          }}
        >
          {SAVE_LABEL}
        </Button>
        <Status {...status} />
      </div>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

export function EasySettingsPage(): React.JSX.Element {
  const state = useEasyState()
  const [dirStatus, setDirStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false })
  const planId = useId()
  const settings = state?.settings
  const chooseDir = async (): Promise<void> => {
    const r = await invoke('dialog.pickFolder', { defaultPath: state?.projectsDir ?? '' })
    if (!r.ok || r.value === null) return
    const err = await save('projectsDir', r.value)
    setDirStatus(err === null ? { text: SAVED, error: false } : { text: err, error: true })
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-8" data-testid="easy-settings">
      <h1 className="text-2xl font-semibold">{SETTINGS_TITLE}</h1>
      <p className="text-sm text-muted-foreground">{SETTINGS_INTRO}</p>
      {state === null || settings === undefined ? null : (
        <>
          <div className="flex flex-col gap-1.5 border-t py-4" data-testid="easy-settings-dir">
            <h2 className="text-sm font-semibold">{PROJECTS_DIR_LABEL}</h2>
            <code className="truncate font-mono text-xs" title={state.projectsDir}>
              {state.projectsDir}
            </code>
            {settings.projectsDir === null && state.defaultProjectsReason === 'onedrive' && (
              <p className="text-sm text-muted-foreground" role="note" data-testid="easy-settings-onedrive">
                {ONEDRIVE_NOTE}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                icon={<FolderOpen aria-hidden />}
                onClick={() => void chooseDir()}
              >
                {CHANGE_FOLDER}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={settings.projectsDir === null}
                onClick={() => {
                  void save('projectsDir', null).then((err) =>
                    setDirStatus(err === null ? { text: SAVED, error: false } : { text: err, error: true }),
                  )
                }}
              >
                {USE_DEFAULT}
              </Button>
              <Status {...dirStatus} />
            </div>
          </div>
          <NumberRow
            label={NEW_LIMIT_LABEL}
            inputLabel={LIMIT_INPUT_LABEL}
            placeholder={LIMIT_NONE}
            value={settings.maxCostUsd}
            parse={parseLimit}
            testId="easy-settings-limit"
            onSave={(v) => save('maxCostUsd', v)}
          />
          <NumberRow
            label={CHANGE_LIMIT_LABEL}
            inputLabel={LIMIT_INPUT_LABEL}
            placeholder={LIMIT_NONE}
            value={settings.changeMaxCostUsd}
            parse={parseLimit}
            testId="easy-settings-change-limit"
            onSave={(v) => save('changeMaxCostUsd', v)}
          />
          <NumberRow
            label={TIME_LIMIT_LABEL}
            inputLabel={TIME_LIMIT_INPUT}
            placeholder={NO_TIME_LIMIT}
            note={TIME_LIMIT_NOTE}
            value={settings.maxMinutes}
            parse={parseMinutes}
            testId="easy-settings-time"
            onSave={(v) => save('maxMinutes', v)}
          />
          <div className="flex items-center gap-3 border-t py-4" data-testid="easy-settings-plan">
            <Switch
              id={planId}
              checked={!settings.skipPlanCheck}
              onCheckedChange={(on) => void save('skipPlanCheck', on ? null : true)}
            />
            <label htmlFor={planId} className="text-sm font-semibold">
              {PLAN_CHECK_LABEL}
            </label>
          </div>
          <div className="flex flex-col gap-1 border-t py-4">
            <PermissionsList />
            <p className="text-xs text-muted-foreground">{PERMISSIONS_SETTINGS_NOTE}</p>
          </div>
          <div className="border-t pt-4">
            <Button asChild variant="outline" data-testid="easy-all-settings">
              <a href={href({ name: 'settings' })}>
                <Settings aria-hidden />
                {ALL_SETTINGS}
              </a>
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
