// Settings → Vendors: the folders a vendor is trusted in, with Revoke (trust.json `vendorFolder`; Gemini).
import { ShieldOff } from 'lucide-react'
import { useState } from 'react'
import type { Result } from '@shared/ipc.ts'
import { hasVendorGrant, REVOKE_LABEL, revokeFolderTrust } from '../../../components/recovery/folderTrust.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { invoke } from '../../../ipc/client.ts'
import { formatAgo } from '../../../lib/format.ts'
import { useTrustEpoch, composerFolderNow } from '../../../state/trust.ts'
import { loadLastFolder } from '../../dashboard/composer-model.ts'
import { useSectionData } from '../sectionData.ts'

/** One folder (its scope root, the folder trust.json keys the grant by) the vendor is trusted in. */
export interface TrustedFolder {
  folder: string
  folderKey: string
  at: number
}

/** The plain words above the list: what the grant lets the vendor do, and where it is made. */
export function trustedFoldersIntro(name: string): string {
  return `Folders where ${name} may read and act without its own trust prompt. You trust a folder from the composer's checks when a pass uses ${name}.`
}

export const NO_TRUSTED_FOLDERS = 'None yet.'

/**
 * The line before core's answer (and for none) is a row's height: with none or one trusted folder, the answer moves
 * nothing below the list (UI standard: async content never shifts the page).
 */
const STATE_LINE = 'flex min-h-7 items-center text-muted-foreground'

/**
 * Every folder Dim Factory knows of (recent runs' folders from `folders.recent`, the composer's folder now and the last
 * one it used) asked with trust.get; those holding the vendor's grant, one per scope root, newest grant first. There
 * is no command that lists trust.json itself, so a folder Dim Factory has not seen is not listed.
 */
export async function loadTrustedFolders(vendor: string): Promise<Result<TrustedFolder[]>> {
  const recent = await invoke('folders.recent')
  const candidates = [
    ...(recent.ok ? recent.value.filter((f) => f.exists).map((f) => f.folder) : []),
    composerFolderNow(),
    loadLastFolder(),
  ].filter((f): f is string => f !== null && f.trim() !== '')
  const unique = [...new Set(candidates.map((f) => f.trim()))]
  const states = await Promise.all(unique.map((folder) => invoke('trust.get', { folder })))
  const byKey = new Map<string, TrustedFolder>()
  for (const r of states) {
    if (!r.ok || !hasVendorGrant(r.value, vendor)) continue
    const at = r.value.grants.vendorFolder?.[vendor]?.at ?? 0
    const folder = r.value.scopeRoot !== '' ? r.value.scopeRoot : r.value.folder
    if (!byKey.has(r.value.folderKey))
      byKey.set(r.value.folderKey, { folder, folderKey: r.value.folderKey, at })
  }
  return { ok: true, value: [...byKey.values()].sort((a, b) => b.at - a.at) }
}

export function TrustedFolders({ vendor, name }: { vendor: string; name: string }): React.JSX.Element {
  const epoch = useTrustEpoch()
  const data = useSectionData(`trusted:${vendor}`, () => loadTrustedFolders(vendor), epoch)
  const [busy, setBusy] = useState<string | null>(null)
  const list = data.value
  const revoke = async (f: TrustedFolder): Promise<void> => {
    setBusy(f.folderKey)
    await revokeFolderTrust(vendor, f.folder, { undo: true })
    setBusy(null)
  }
  return (
    <section
      aria-labelledby={`vendor-trust-title-${vendor}`}
      data-testid={`vendor-trusted-${vendor}`}
      className="flex flex-col gap-1.5 text-xs"
    >
      <h4 id={`vendor-trust-title-${vendor}`} className="text-sm font-medium">
        Trusted folders
        {/* Accessibility: each vendor's region and heading has its own name ("Trusted folders for Gemini"); the vendor's
            card around it says which one to the eye. */}
        <span className="sr-only"> for {name}</span>
      </h4>
      <p className="text-muted-foreground">{trustedFoldersIntro(name)}</p>
      {list === null ? (
        <p className={STATE_LINE} data-testid={`vendor-trusted-${vendor}-state`}>
          {data.error !== null
            ? `Could not read the trusted folders: ${data.error}`
            : 'Reading trusted folders…'}
        </p>
      ) : list.length === 0 ? (
        <p className={STATE_LINE} data-testid={`vendor-trusted-${vendor}-state`}>
          {NO_TRUSTED_FOLDERS}
        </p>
      ) : (
        <ul aria-label={`Folders trusted for ${name}`} className="flex flex-col gap-1">
          {list.map((f) => (
            <li
              key={f.folderKey}
              data-testid={`vendor-trusted-${vendor}-row`}
              data-folder-key={f.folderKey}
              className="flex min-h-7 min-w-0 flex-wrap items-center gap-2"
            >
              <code className="min-w-0 flex-1 truncate font-mono" title={f.folder}>
                {f.folder}
              </code>
              <span className="text-muted-foreground tabular-nums">
                {f.at > 0 ? `Trusted ${formatAgo(f.at, Date.now())}` : 'Trusted'}
              </span>
              <Button
                size="sm"
                variant="outline"
                data-testid={`vendor-trusted-${vendor}-revoke-${f.folderKey}`}
                icon={<ShieldOff aria-hidden />}
                loading={busy === f.folderKey}
                disabled={busy !== null && busy !== f.folderKey}
                aria-label={`${REVOKE_LABEL}: ${name} in ${f.folder}`}
                onClick={() => void revoke(f)}
              >
                {REVOKE_LABEL}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
