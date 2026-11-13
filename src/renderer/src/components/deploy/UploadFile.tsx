// "Make an upload file" (the Deploy panel's Drag and drop section, for a static site, single-page app or docs site;
// Easy mode's Share it shows the same panel): core zips the served folder next to the project, with the secret scanner
// read over every file first (a hit refuses it, with the list). Show the file shows the zip in the file manager; Open
// Netlify Drop opens that one page in the browser, only on a click. Nothing is uploaded and nothing opens on its own.
// A site that is built first (a React site's dist/) also gets "Get it ready to share": core runs the project's own build
// script, as Verify runs it (trusted already, or by Easy's project permission); otherwise it asks here first, with the
// script behind "Show what will run". When it built, the panel reads the folder again so the upload file is ready.
// Raw data files (a report's data/*.csv) stay out of the zip unless the user includes them, with what was left out.
// UI standards: the buttons keep their labels and widths; the status lines keep their height (the refusal list, the
// build's output and its question appear under them only after a click).
import { ExternalLink, FileArchive, FolderOpen, Hammer } from 'lucide-react'
import { useId, useState } from 'react'
import type { DeployBuildResult, DeployClass, DeployUploadResult, DeployUploadView } from '@shared/deploy.ts'
import { NETLIFY_DROP_URL } from '@shared/deploy.ts'
import { invoke } from '../../ipc/client.ts'
import { toast } from '../../state/toasts.ts'
import { useBusy } from '../run/commands.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import type { DeployTargetProps } from './DeployPanel.tsx'
import {
  BUILD_CANCELLED,
  BUILD_LABEL,
  BUILD_RUNNING,
  BUILD_TRUST_CANCEL,
  BUILD_TRUST_NO_SCRIPT,
  BUILD_TRUST_OK,
  BUILD_TRUST_SHOW,
  buildDoneLine,
  buildIntro,
  buildTrustText,
  DATA_INCLUDED,
  dataLeftOutText,
  INCLUDE_DATA,
  UPLOAD_LOCAL,
  UPLOAD_MAKE,
  UPLOAD_NETLIFY,
  UPLOAD_PUBLIC,
  UPLOAD_SHOW,
  UPLOAD_SHOW_FIRST,
  UPLOAD_TITLE,
  uploadIntro,
  uploadMadeLine,
  uploadSteps,
} from './text.ts'

/**
 * "Get it ready to share": run the project's build, asking first when it is not trusted yet. `onBuilt`: the folder
 * was built (the panel reads it again).
 */
function GetReady({
  target,
  command,
  dir,
  onBuilt,
}: {
  target: DeployTargetProps
  command: string
  dir: string
  onBuilt: () => void
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [result, setResult] = useState<DeployBuildResult | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const questionId = useId()
  const build = (trustHash?: string): void =>
    run(trustHash !== undefined ? 'trust' : 'build', async () => {
      setCancelled(false)
      const r = await invoke('deploy.build', { ...target, ...(trustHash !== undefined ? { trustHash } : {}) })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      setResult(r.value)
      if (r.value.status === 'built') onBuilt()
    })
  const asking = result?.status === 'trust' ? result : null
  const status =
    busy !== null
      ? BUILD_RUNNING
      : cancelled
        ? BUILD_CANCELLED
        : result === null || result.status === 'trust'
          ? buildIntro(command, dir)
          : result.status === 'built'
            ? buildDoneLine(result.dir, result.durationMs)
            : result.reason
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-build">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={<Hammer aria-hidden />}
          loading={busy === 'build'}
          disabled={busy !== null || asking !== null}
          data-testid="deploy-build-run"
          onClick={() => build()}
        >
          {BUILD_LABEL}
        </Button>
      </div>
      <p
        role="status"
        className="min-h-5 text-sm break-words"
        data-testid="deploy-build-status"
        data-state={busy !== null ? 'running' : (result?.status ?? 'idle')}
      >
        {status}
      </p>
      {result?.status === 'failed' && result.excerpt !== '' && (
        <pre
          className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
          data-testid="deploy-build-output"
        >
          {result.excerpt}
        </pre>
      )}
      {asking !== null && (
        <section
          aria-labelledby={questionId}
          className="flex flex-col gap-2 rounded-md border border-st-waiting/50 p-3"
          data-testid="deploy-build-trust"
        >
          <p id={questionId} className="text-sm font-medium">
            {buildTrustText(asking.command)}
          </p>
          <details>
            <summary className="cursor-pointer text-sm">{BUILD_TRUST_SHOW}</summary>
            <pre
              className="mt-1 max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
              data-testid="deploy-build-script"
            >
              {asking.body ?? BUILD_TRUST_NO_SCRIPT}
            </pre>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={busy === 'trust'}
              disabled={busy !== null}
              data-testid="deploy-build-trust-ok"
              onClick={() => build(asking.hash)}
            >
              {BUILD_TRUST_OK}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              data-testid="deploy-build-trust-cancel"
              onClick={() => {
                setResult(null)
                setCancelled(true)
              }}
            >
              {BUILD_TRUST_CANCEL}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

export function UploadFile({
  target,
  upload,
  cls,
  onBuilt,
}: {
  target: DeployTargetProps
  upload: DeployUploadView
  /** The class the user picked (the zip follows it). */
  cls: DeployClass | undefined
  /** "Get it ready to share" built the folder (the panel reads it again). */
  onBuilt?: () => void
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [result, setResult] = useState<DeployUploadResult | null>(null)
  const made = result?.status === 'made' ? result : null

  const make = (includeData?: boolean): void =>
    run(includeData === true ? 'include' : 'make', async () => {
      const r = await invoke('deploy.uploadFile', {
        ...target,
        ...(cls !== undefined ? { cls } : {}),
        ...(includeData === true ? { includeData: true } : {}),
      })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      setResult(r.value)
    })
  const show = (): void =>
    run('show', async () => {
      if (made === null) return
      const r = await invoke('shell.open', { target: 'uploadFile', path: made.path })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
    })
  const drop = (): void =>
    run('drop', async () => {
      const r = await invoke('shell.open', { target: 'url', url: NETLIFY_DROP_URL })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
    })

  const status =
    result === null
      ? UPLOAD_LOCAL
      : result.status === 'made'
        ? uploadMadeLine(result)
        : `No upload file was made. ${result.reason}`

  const makeButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<FileArchive aria-hidden />}
      loading={busy === 'make'}
      disabled={!upload.ready || (busy !== null && busy !== 'make')}
      data-testid="deploy-upload-make"
      onClick={() => make()}
    >
      {UPLOAD_MAKE}
    </Button>
  )
  const showButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<FolderOpen aria-hidden />}
      loading={busy === 'show'}
      disabled={made === null || (busy !== null && busy !== 'show')}
      data-testid="deploy-upload-show"
      onClick={show}
    >
      {UPLOAD_SHOW}
    </Button>
  )

  return (
    <section
      aria-label={UPLOAD_TITLE}
      data-testid="deploy-upload"
      data-ready={upload.ready ? 'true' : 'false'}
      className="flex flex-col gap-2"
    >
      <h4 className="text-xs font-semibold text-muted-foreground uppercase">{UPLOAD_TITLE}</h4>
      {upload.build !== undefined && (
        <GetReady
          target={target}
          command={upload.build.command}
          dir={upload.dir}
          onBuilt={() => onBuilt?.()}
        />
      )}
      <p className="text-sm" data-testid="deploy-upload-intro">
        {uploadIntro(upload.dir)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {upload.ready ? (
          makeButton
        ) : (
          <DisabledHint reason={upload.problem ?? UPLOAD_LOCAL}>{makeButton}</DisabledHint>
        )}
        {made === null ? <DisabledHint reason={UPLOAD_SHOW_FIRST}>{showButton}</DisabledHint> : showButton}
        <Button
          size="sm"
          variant="ghost"
          icon={<ExternalLink aria-hidden />}
          loading={busy === 'drop'}
          disabled={busy !== null && busy !== 'drop'}
          data-testid="deploy-upload-netlify"
          onClick={drop}
        >
          {UPLOAD_NETLIFY}
        </Button>
      </div>
      {!upload.ready && upload.problem !== undefined && (
        <p className="text-xs text-warning" data-testid="deploy-upload-problem">
          {upload.problem}
        </p>
      )}
      <p
        role="status"
        className="min-h-5 text-sm break-words"
        data-testid="deploy-upload-status"
        data-state={result?.status ?? 'idle'}
        title={made?.path}
      >
        {status}
      </p>
      {made?.warning !== undefined && (
        <div className="flex flex-col gap-1" data-testid="deploy-upload-warning">
          <p className="text-sm text-warning" role="note">
            {made.warning}
          </p>
          <ul className="flex flex-col gap-0.5 font-mono text-xs break-all">
            {(made.warnings ?? []).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {made?.dataLeftOut !== undefined && made.dataLeftOut.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="deploy-upload-data">
          <p className="text-sm text-warning" role="note">
            {dataLeftOutText(made.dataLeftOut.length)}
          </p>
          <ul className="flex flex-col gap-0.5 font-mono text-xs break-all">
            {made.dataLeftOut.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <div>
            <Button
              size="sm"
              variant="outline"
              loading={busy === 'include'}
              disabled={busy !== null && busy !== 'include'}
              data-testid="deploy-upload-include-data"
              onClick={() => make(true)}
            >
              {INCLUDE_DATA}
            </Button>
          </div>
        </div>
      )}
      {made?.dataIncluded === true && (
        <p className="text-sm font-medium" role="note" data-testid="deploy-upload-data-included">
          {DATA_INCLUDED}
        </p>
      )}
      {result?.status === 'refused' && result.evidence.length > 0 && (
        <ul
          className="flex flex-col gap-0.5 font-mono text-xs break-all text-destructive"
          data-testid="deploy-upload-evidence"
        >
          {result.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm" data-testid="deploy-upload-steps">
        {uploadSteps(upload.game).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="text-sm font-medium" data-testid="deploy-upload-public">
        {UPLOAD_PUBLIC}
      </p>
    </section>
  )
}
