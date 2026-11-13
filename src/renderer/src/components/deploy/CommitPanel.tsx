// "Commit to run branch" and "Create PR" in "After the run", for a project that turned them on (Settings, Deploy; both
// off by default). Core decides everything (git.commitPreview / git.prPreview): where the commit goes (only a run branch
// or an isolated copy's branch), the files (only the run's), the message (editable), and why it is not offered now.
// The commit never touches other staged changes. "Create PR" shows the copyable commands always; Dim Factory runs them
// only after the confirmation card, which names the repository and branch, and core refuses a create whose repository
// or branch changed since. A missing or signed-out gh is a note with copyable fixes, never a blocker for copying.
// UI standards: buttons keep their size; the confirmation card and results arrive below the buttons that asked for them.
import { ExternalLink, GitCommitHorizontal, GitPullRequest } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { CommitPreview, PrPreview } from '@shared/deploy.ts'
import { invoke } from '../../ipc/client.ts'
import { setRunCommit } from '../../state/runGit.ts'
import { toast } from '../../state/toasts.ts'
import { CopyCommands } from '../recovery/CopyCommands.tsx'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import { useBusy } from '../run/commands.ts'
import { PR_INTRO, commitIntro, prConfirmText } from './text.ts'

export const COMMIT_LABEL = 'Commit to run branch'
export const PR_LABEL = 'Create PR'
export const PR_CONFIRM_LABEL = 'Push and open pull request'
export const CANCEL_LABEL = 'Cancel'

/** A refusal's commands (core puts them in the error's details), for copying. */
function commandsOf(details: unknown): string[] {
  const c = (details as { commands?: unknown } | undefined)?.commands
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : []
}

interface Refusal {
  message: string
  commands: string[]
}

export function CommitPanel({ runId }: { runId: string }): React.JSX.Element | null {
  const [commit, setCommit] = useState<CommitPreview | null>(null)
  const [pr, setPr] = useState<PrPreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [done, setDone] = useState<{ sha: string; branch: string; notes: string[] } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [busy, run] = useBusy()

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([
      invoke('git.commitPreview', { runId }),
      invoke('git.prPreview', { runId }),
    ])
    if (c.ok) {
      setCommit(c.value)
      if (c.value.committed !== undefined) setRunCommit(runId, c.value.committed.sha)
    }
    if (p.ok) setPr(p.value)
  }, [runId])
  useEffect(() => {
    void load()
  }, [load])

  if (commit === null || (!commit.enabled && pr?.enabled !== true)) return null

  const doCommit = (): void =>
    run('commit', async () => {
      setRefusal(null)
      const text = message ?? commit.message
      const r = await invoke('git.commit', { runId, ...(text !== commit.message ? { message: text } : {}) })
      if (!r.ok) {
        setRefusal({ message: r.error.message, commands: commandsOf(r.error.details) })
        return
      }
      setDone(r.value)
      setRunCommit(runId, r.value.sha)
      toast({ level: 'info', message: `Committed as ${r.value.sha.slice(0, 7)} on ${r.value.branch}.` })
      await load()
    })

  const doCreate = (): void =>
    run('pr', async () => {
      if (pr === null || pr.remote === null || pr.repo === null || pr.branch === null) return
      setPrError(null)
      const r = await invoke('git.prCreate', {
        runId,
        confirm: { remote: pr.remote, repo: pr.repo, branch: pr.branch },
      })
      setConfirming(false)
      if (!r.ok) {
        setPrError(r.error.message)
        await load()
        return
      }
      setOpened(r.value.url)
      await load()
    })

  const committedSha = done?.sha ?? commit.committed?.sha
  const commitButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<GitCommitHorizontal aria-hidden />}
      loading={busy === 'commit'}
      disabled={commit.blocked !== undefined || (busy !== null && busy !== 'commit')}
      data-testid="commit-button"
      onClick={doCommit}
    >
      {COMMIT_LABEL}
    </Button>
  )
  const prBlocked = pr?.blocked
  const prButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<GitPullRequest aria-hidden />}
      loading={busy === 'pr'}
      disabled={prBlocked !== undefined || confirming || (busy !== null && busy !== 'pr')}
      data-testid="pr-button"
      onClick={() => setConfirming(true)}
    >
      {PR_LABEL}
    </Button>
  )
  const openedUrl = opened ?? pr?.opened?.url ?? null

  return (
    <section aria-label="Commit and pull request" data-testid="commit-panel" className="flex flex-col gap-3">
      {commit.enabled && (
        <div className="flex flex-col gap-2" data-testid="commit-section">
          <p className="text-sm" data-testid="commit-intro">
            {committedSha !== undefined
              ? `Committed as ${committedSha.slice(0, 7)} on ${done?.branch ?? commit.committed?.branch ?? commit.branch ?? ''}.`
              : commitIntro(commit)}
          </p>
          {committedSha === undefined && commit.paths.length > 0 && (
            <>
              <label htmlFor={`commit-message-${runId}`} className="text-xs text-muted-foreground">
                Commit message
              </label>
              <Textarea
                id={`commit-message-${runId}`}
                data-testid="commit-message"
                mono
                rows={6}
                value={message ?? commit.message}
                disabled={commit.blocked !== undefined}
                onChange={(e) => setMessage(e.target.value)}
              />
            </>
          )}
          {committedSha === undefined && (
            <div className="flex flex-wrap items-center gap-2">
              {commit.blocked !== undefined ? (
                <DisabledHint reason={commit.blocked}>{commitButton}</DisabledHint>
              ) : (
                commitButton
              )}
              {commit.blocked !== undefined && (
                <p
                  className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground"
                  data-testid="commit-blocked"
                >
                  {commit.blocked}
                </p>
              )}
            </div>
          )}
          <div role="status" className="flex flex-col gap-1.5">
            {done !== null &&
              done.notes.map((n, i) => (
                <p key={i} className="text-xs text-muted-foreground" data-testid="commit-note">
                  {n}
                </p>
              ))}
            {refusal !== null && (
              <div data-testid="commit-refused" className="flex flex-col gap-1.5">
                <p className="text-sm break-words">{refusal.message}</p>
                <CopyCommands commands={refusal.commands} testId="commit-commands" />
              </div>
            )}
          </div>
        </div>
      )}
      {pr !== null && pr.enabled && (
        <div className="flex flex-col gap-2" data-testid="pr-section">
          <p className="text-sm">{PR_INTRO}</p>
          {openedUrl !== null ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="pr-opened">
              <p className="min-w-0 flex-1 basis-64 text-sm break-all">Opened {openedUrl}</p>
              <Button
                size="sm"
                variant="outline"
                icon={<ExternalLink aria-hidden />}
                data-testid="pr-open-link"
                onClick={() => void invoke('shell.open', { target: 'url', url: openedUrl })}
              >
                Open
              </Button>
            </div>
          ) : (
            <>
              {pr.commands.length > 0 && (
                <CopyCommands
                  commands={pr.commands.map((c) => c.command).filter((c): c is string => c !== undefined)}
                  testId="pr-commands"
                />
              )}
              {(!pr.gh.installed || !pr.gh.authenticated) && (
                <div className="flex flex-col gap-1.5" data-testid="pr-gh">
                  <p className="text-xs text-muted-foreground">{pr.gh.problem}</p>
                  <CopyCommands
                    commands={pr.gh.fixes.map((f) => f.command).filter((c): c is string => c !== undefined)}
                    testId="pr-gh-fixes"
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {prBlocked !== undefined ? (
                  <DisabledHint reason={prBlocked}>{prButton}</DisabledHint>
                ) : (
                  prButton
                )}
                {prBlocked !== undefined && (
                  <p
                    className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground"
                    data-testid="pr-blocked"
                  >
                    {prBlocked}
                  </p>
                )}
              </div>
              {confirming && prBlocked === undefined && (
                <div
                  role="alertdialog"
                  aria-label="Confirm the pull request"
                  data-testid="pr-confirm"
                  className="flex flex-col gap-2 rounded-md border border-primary p-3"
                >
                  <p className="text-sm" data-testid="pr-confirm-text">
                    {prConfirmText(pr)}
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                    <dt className="text-muted-foreground">Repository</dt>
                    <dd data-testid="pr-confirm-repo">{pr.repo}</dd>
                    <dt className="text-muted-foreground">Branch</dt>
                    <dd data-testid="pr-confirm-branch">{pr.branch}</dd>
                    <dt className="text-muted-foreground">Remote</dt>
                    <dd>{pr.remoteUrl}</dd>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      icon={<GitPullRequest aria-hidden />}
                      loading={busy === 'pr'}
                      disabled={busy !== null && busy !== 'pr'}
                      data-testid="pr-confirm-button"
                      onClick={doCreate}
                    >
                      {PR_CONFIRM_LABEL}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      data-testid="pr-cancel"
                      onClick={() => setConfirming(false)}
                    >
                      {CANCEL_LABEL}
                    </Button>
                  </div>
                </div>
              )}
              {prError !== null && (
                <p role="status" className="text-sm break-words" data-testid="pr-error">
                  {prError}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
