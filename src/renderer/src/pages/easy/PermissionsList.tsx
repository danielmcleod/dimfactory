// The project permissions (Easy mode's "Allow these for this project"): every project folder that has one, with when it
// was given and how often it was used, and Take it back (core stops it covering anything at once, a running run
// included). Shown in Easy settings and in Settings, Vendors, beside the Trusted folders.
// UI standards: the line before core's answer is a row's height; Take it back keeps its label (busy shows a spinner).
import { ShieldOff } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { formatAgo } from '../../lib/format.ts'
import { revokeEasyPermission, useEasyPermissions } from '../../state/easyPermission.ts'
import { baseName } from './model.ts'
import {
  PERMISSIONS_INTRO,
  PERMISSIONS_LOADING,
  PERMISSIONS_NONE,
  PERMISSIONS_TITLE,
  REVOKE_PERMISSION,
  permissionSinceText,
  permissionUsesText,
} from './text.ts'

const STATE_LINE = 'flex min-h-9 items-center text-sm text-muted-foreground'

export function PermissionsList({
  heading = 'h2',
  testId = 'easy-permissions',
  deferMs = 0,
}: {
  heading?: 'h2' | 'h4'
  testId?: string
  /** Read core only once shown this long (Settings sections). */
  deferMs?: number
}): React.JSX.Element {
  const { list, error } = useEasyPermissions(deferMs)
  const [busy, setBusy] = useState<string | null>(null)
  const headingId = useId()
  const H = heading
  return (
    <section aria-labelledby={headingId} data-testid={testId} className="flex flex-col gap-1.5">
      <H id={headingId} className="text-sm font-semibold">
        {PERMISSIONS_TITLE}
      </H>
      <p className="text-xs text-muted-foreground">{PERMISSIONS_INTRO}</p>
      {list === null ? (
        <p className={STATE_LINE} data-testid={`${testId}-state`}>
          {error ?? PERMISSIONS_LOADING}
        </p>
      ) : list.length === 0 ? (
        <p className={STATE_LINE} data-testid={`${testId}-state`}>
          {PERMISSIONS_NONE}
        </p>
      ) : (
        <ul aria-label={PERMISSIONS_TITLE} className="flex flex-col gap-1">
          {list.map((p) => (
            <li
              key={p.folder}
              data-testid={`${testId}-row`}
              data-folder={p.folder}
              className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" title={p.folder}>
                  {baseName(p.folder)}
                </span>
                <span className="truncate text-xs text-muted-foreground tabular-nums">
                  {permissionSinceText(formatAgo(p.at, Date.now()))} · {permissionUsesText(p.uses)}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                icon={<ShieldOff aria-hidden />}
                loading={busy === p.folder}
                disabled={busy !== null && busy !== p.folder}
                aria-label={`${REVOKE_PERMISSION}: ${baseName(p.folder)}`}
                data-testid={`${testId}-revoke`}
                onClick={() => {
                  setBusy(p.folder)
                  void revokeEasyPermission(p.folder).finally(() => setBusy(null))
                }}
              >
                {REVOKE_PERMISSION}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
