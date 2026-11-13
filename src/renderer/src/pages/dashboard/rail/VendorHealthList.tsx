// Vendor health in the Dashboard rail (with [Re-probe]): each
// built vendor's health from core's ProbeView (vendors.list, probe events, dashboard.get), its version and failing
// checks, and Re-probe = a forced probe with "Checking…" until it answers.
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { ProbeView } from '@shared/vendors.ts'
import {
  failingCheckTitles,
  HealthDot,
  probeVersion,
  reprobe,
} from '../../../components/shell/VendorHealth.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { href } from '../../../lib/router.ts'
import { useProbes } from '../../../state/selectors.ts'

function VendorRow({ probe }: { probe: ProbeView }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const version = probeVersion(probe)
  const failing = failingCheckTitles(probe)
  const checking = busy || probe.checking
  const run = async (): Promise<void> => {
    setBusy(true)
    await reprobe(probe.vendor)
    setBusy(false)
  }
  return (
    <li
      data-testid={`vendor-health-${probe.vendor}`}
      data-health={probe.health}
      className="flex flex-col gap-1 py-2"
    >
      <div className="flex items-center gap-2">
        <HealthDot health={checking ? 'checking' : probe.health} />
        <a
          href={href({ name: 'settings', section: 'vendors', subpath: [probe.vendor] })}
          className="text-sm font-medium hover:underline"
        >
          {probe.displayName}
        </a>
        {version !== null && <span className="text-xs text-muted-foreground tabular-nums">{version}</span>}
        <Button
          size="sm"
          variant="ghost"
          loading={checking}
          onClick={() => void run()}
          className="ml-auto"
          data-testid={`vendor-reprobe-${probe.vendor}`}
          aria-label={`Re-probe ${probe.displayName}`}
          icon={<RefreshCw aria-hidden />}
        >
          Re-probe
        </Button>
      </div>
      <p className="pl-4 text-xs text-muted-foreground" aria-live="polite">
        {checking ? 'Checking…' : probe.healthDetail}
      </p>
      {!checking && failing.length > 0 && (
        <ul className="pl-4 text-xs text-destructive">
          {failing.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function VendorHealthList(): React.JSX.Element {
  const probes = useProbes().filter((p) => p.built)
  return (
    <section aria-labelledby="vendors-heading" className="flex flex-col gap-1">
      <h2 id="vendors-heading" className="text-sm font-semibold">
        Vendors
      </h2>
      {probes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No vendor checks yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {probes.map((p) => (
            <VendorRow key={p.vendor} probe={p} />
          ))}
        </ul>
      )}
    </section>
  )
}
