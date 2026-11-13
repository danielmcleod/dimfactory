// Settings → Vendors: one card per built vendor from the probe views
// in the store (vendors.list, probe events), with the path, version, default model, checks with fixes and Test;
// vendors not in this version are named. Codex's card is live (its modes and its Windows sandbox) and the local
// models (presets run through Codex) are added, edited, tested and removed here (vendors/LocalPresetsGroup.tsx).
// Gemini has a card of its own once built, with the folders it is trusted in (vendors/TrustedFolders.tsx). A
// deep link (`#/settings/vendors/<id>?field=path`, or core's `?field=/vendors/<id>/path`) scrolls to the card and
// focuses the field. The user's vendor settings are read only when there is a card to show them in; the local models once the
// section has been open a moment (sectionData.ts, performance.spec.ts: a section switch costs no IPC). Last, beside the trusted folders:
// Easy mode's project permissions, each with Take it back (pages/easy/PermissionsList.tsx; last, so its arrival moves
// nothing above it).
import { useProbes } from '../../state/selectors.ts'
import { currentHash, useRoute } from '../../lib/router.ts'
import { vendorTarget } from './vendors/deepLink.ts'
import { LocalPresetsGroup } from './vendors/LocalPresetsGroup.tsx'
import { useVendorUserConfig } from './vendors/userConfig.ts'
import { VendorCard } from './vendors/VendorCard.tsx'
import { PermissionsList } from '../easy/PermissionsList.tsx'
import { SECTION_LOAD_DELAY_MS } from './sectionData.ts'

export function VendorsSection(): React.JSX.Element {
  const probes = useProbes()
  const route = useRoute()
  const built = probes.filter((p) => p.built)
  const later = probes.filter((p) => !p.built)
  const { vendors, reload } = useVendorUserConfig(built.length > 0)
  const target = vendorTarget(route)
  const focusKey = currentHash()
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The vendor CLIs Dim Factory runs: where each was found, its version, and the checks it passes before a
        run.
      </p>
      {built.length === 0 ? (
        <p className="text-sm text-muted-foreground">No vendor information yet.</p>
      ) : (
        built.map((p) => (
          <VendorCard
            key={p.vendor}
            view={p}
            config={vendors === null ? null : (vendors[p.vendor] ?? {})}
            focus={target?.vendor === p.vendor ? target.field : undefined}
            focusKey={focusKey}
            onConfigSaved={reload}
          />
        ))
      )}
      {later.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not in this version: {later.map((p) => p.displayName).join(', ')}.
        </p>
      )}
      <LocalPresetsGroup />
      <div className="rounded-lg border p-4">
        <PermissionsList heading="h4" testId="settings-easy-permissions" deferMs={SECTION_LOAD_DELAY_MS} />
      </div>
    </div>
  )
}
