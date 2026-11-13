// Settings → Deploy: the Deploy step at the end of a run (`passes.implement.deploy`, and the target it writes config
// for, `passes.implement.deployTarget`; for one project, or your default for every project), and commit and pull
// request at the end of a run (`git.commit`, `git.pullRequest`: project only, both off by default). The values are
// core's resolved ones (config.resolve), a value just written shows at once until core's next answer, and each control
// writes one config.patch with Undo (writeConfig). Dim Factory never runs a deploy command, never signs in to a
// provider and never stores a token: the Deploy panel's commands are copied.
import { useEffect, useState } from 'react'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { writeConfig } from './general/configWrite.ts'
import type { ConfigTarget } from './general/configWrite.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { SourceBadge } from './general/SourceBadge.tsx'
import { Group, SettingRow } from './kit.tsx'
import { useSectionData } from './sectionData.ts'

const UNDO_TOAST = 'deploy-undo'
export const DEPLOY_STEP_LABEL = 'Write deploy config'
export const DEPLOY_TARGET_LABEL = 'Deploy target'
export const COMMIT_LABEL = 'Offer Commit to run branch'
export const PR_LABEL = 'Offer Create PR'
export const AUTO_TARGET = 'auto'
export const AUTO_TARGET_LABEL = 'Let Dim Factory pick'
export const NEEDS_PROJECT = 'Choose a project above: commit and pull request are turned on per project.'

export interface DeploySettings {
  deploy: boolean
  deployTarget: string | null
  commit: boolean
  pullRequest: boolean
  remote: string
}

/** The deploy settings as core resolved them (an older core may leave keys out: their defaults), pending writes shown. */
export function deploySettingsOf(
  view: ResolvedWithProvenance | null,
  pending: Readonly<Record<string, unknown>>,
): DeploySettings | null {
  if (view === null) return null
  const c = view.config as Partial<ResolvedConfig>
  const impl = (c.passes as Partial<Record<string, Record<string, unknown>>> | undefined)?.['implement'] ?? {}
  const git = (c.git ?? {}) as Partial<ResolvedConfig['git']>
  const at = <T,>(key: string, cur: T): T => (key in pending ? (pending[key] as T) : cur)
  return {
    deploy: at('/passes/implement/deploy', impl['deploy'] === true),
    deployTarget: at(
      '/passes/implement/deployTarget',
      typeof impl['deployTarget'] === 'string' ? impl['deployTarget'] : null,
    ),
    commit: at('/git/commit', git.commit === true),
    pullRequest: at('/git/pullRequest', git.pullRequest === true),
    remote: git.remote ?? 'origin',
  }
}

export function DeploySection(): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(null)
  const epoch = useConfigEpoch()
  const resolved = useSectionData(
    `resolve\u0000${folder ?? ''}`,
    () => invoke('config.resolve', folder !== null ? { folder } : {}),
    epoch,
  )
  // The targets for the picker: every pack's (the software pack's first), from brief.detect.
  const briefCtx = useSectionData('brief-detect', () => invoke('brief.detect', {}), epoch)
  const target: ConfigTarget = folder !== null ? { scope: 'project', folder } : { scope: 'user' }
  const [pending, setPending] = useState<Readonly<Record<string, unknown>>>({})
  useEffect(() => setPending({}), [resolved.value])
  const [busy, setBusy] = useState<string | null>(null)
  const s = deploySettingsOf(resolved.value, pending)
  const provenance = resolved.value?.provenance
  const loading = s === null
  const where = folder !== null ? folderBaseName(folder) : null

  const targets: { id: string; label: string }[] = []
  for (const v of briefCtx.value?.packs ?? []) {
    for (const t of v.pack.deploy?.targets ?? []) {
      if (!targets.some((x) => x.id === t.id)) targets.push({ id: t.id, label: t.label })
    }
  }

  const write = async (key: string, ops: JsonPatchOp[], message: string, shown: unknown): Promise<void> => {
    setPending((p) => ({ ...p, [key]: shown }))
    setBusy(key)
    const res = await writeConfig({
      target: key.startsWith('/git/') && folder !== null ? { scope: 'project', folder } : target,
      ops,
      message,
      toastId: UNDO_TOAST,
      onSettled: () => resolved.reload(),
    })
    setBusy(null)
    if (res === null)
      setPending((p) => {
        const { [key]: _gone, ...rest } = p
        return rest
      })
  }

  const toggle = (
    ptr: string,
    label: string,
    value: boolean | undefined,
    on: string,
    off: string,
    disabled = false,
  ) => (
    <>
      <SourceBadge provenance={provenance?.[ptr]} loading={loading} testId={`setting-source-${ptr}`} />
      <Switch
        data-testid={`setting-${ptr}`}
        aria-label={label}
        checked={value === true}
        disabled={loading || disabled || busy === ptr}
        onCheckedChange={(v) => void write(ptr, [{ op: 'replace', path: ptr, value: v }], v ? on : off, v)}
      />
    </>
  )

  return (
    <div className="flex flex-col gap-6" data-testid="settings-deploy" aria-busy={loading || undefined}>
      <p className="text-sm text-muted-foreground">
        The Deploy helper says what a project ships as, where it could go, what to check first and the
        commands to copy. Dim Factory never runs a deploy command, never signs in to a provider and never
        stores a token.
      </p>
      {resolved.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The settings could not be read: {resolved.error}
        </p>
      )}
      <Group
        title="Project"
        description="With a project chosen, changes here are saved to its settings; without one, the Deploy step's defaults are saved to your settings. Commit and pull request are always a project's."
      >
        <ProjectFolder folder={folder} onChange={setFolder} testId="deploy-settings-folder" />
        <p role="status" data-testid="deploy-scope" className="min-h-4 text-xs text-muted-foreground">
          {where !== null
            ? `Saved to ${where}'s dimfactory.json.`
            : 'Saved to your settings, for every project.'}
        </p>
      </Group>
      <Group
        title="Deploy step"
        description="At the end of a run that completed without failures, an editing pass on the Implement model writes the config files the deploy target needs (a Dockerfile, netlify.toml, vercel.json, fly.toml, a GitHub Actions workflow, .env.example). You review them in the Diff tab like any change. It never deploys."
      >
        <SettingRow field="/passes/implement/deploy" label={DEPLOY_STEP_LABEL}>
          {toggle(
            '/passes/implement/deploy',
            DEPLOY_STEP_LABEL,
            s?.deploy,
            'The Deploy step writes deploy config at the end of a run',
            'The Deploy step is off',
          )}
        </SettingRow>
        <SettingRow field="/passes/implement/deployTarget" label={DEPLOY_TARGET_LABEL}>
          <SourceBadge
            provenance={provenance?.['/passes/implement/deployTarget']}
            loading={loading}
            testId="setting-source-/passes/implement/deployTarget"
          />
          <Select
            value={s?.deployTarget ?? AUTO_TARGET}
            disabled={loading || busy === '/passes/implement/deployTarget'}
            onValueChange={(v) => {
              const next = v === AUTO_TARGET ? null : v
              void write(
                '/passes/implement/deployTarget',
                [{ op: 'replace', path: '/passes/implement/deployTarget', value: next }],
                next === null ? 'Dim Factory picks the deploy target' : `Deploy target: ${next}`,
                next,
              )
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-56"
              aria-label={DEPLOY_TARGET_LABEL}
              data-testid="setting-deploy-target"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_TARGET}>{AUTO_TARGET_LABEL}</SelectItem>
              {targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </Group>
      <Group
        title="Commit and pull request"
        description={`Off by default, and turned on per project. "Commit to run branch" commits a finished run's changes on its run branch or its isolated copy's branch, never on a branch you work on, and leaves your other staged changes alone. "Create PR" gives the commands to copy, or pushes and opens the pull request with the GitHub CLI after you confirm the repository and branch. Pull requests push to the remote named in git.remote (now ${s?.remote ?? 'origin'}).`}
      >
        {folder === null && (
          <p className="text-xs text-muted-foreground" data-testid="deploy-git-needs-project">
            {NEEDS_PROJECT}
          </p>
        )}
        <SettingRow field="/git/commit" label={COMMIT_LABEL}>
          {toggle(
            '/git/commit',
            COMMIT_LABEL,
            s?.commit,
            'Commit to run branch is offered for this project',
            'Commit to run branch is off for this project',
            folder === null,
          )}
        </SettingRow>
        <SettingRow field="/git/pullRequest" label={PR_LABEL}>
          {toggle(
            '/git/pullRequest',
            PR_LABEL,
            s?.pullRequest,
            'Create PR is offered for this project',
            'Create PR is off for this project',
            folder === null,
          )}
        </SettingRow>
      </Group>
    </div>
  )
}
