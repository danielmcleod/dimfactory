// Settings → Isolation & Verify: the verify commands of a project with their trust state (trust.json). One row per
// command (model.ts verifyRows): the command and where it runs, its trust state (Trusted / Not trusted / Changed since
// you trusted it, with what changed in its script under the row), whether a run uses it, and Trust or Untrust and
// Remove. The table fits its column and never scrolls (one scroll region per screen); every button keeps one width
// (Trust and Untrust share a reserved label; a busy button's spinner takes its icon slot).
import { ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { BodyDiff, scriptDiff } from '../../../components/cards/TrustBody.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { cn } from '../../../lib/cn.ts'
import { SETTINGS_TABLE } from '../kit.tsx'
import { sourceText, TRUST_TEXT } from './model.ts'
import type { VerifyRow } from './model.ts'

const COLUMNS = ['Command', 'Trust', 'Runs', 'Actions'] as const
const TRUST_LABELS: readonly string[] = ['Trust', 'Untrust']

const TRUST_TONE: Readonly<Record<VerifyRow['trust'], string>> = {
  trusted: 'text-st-done',
  untrusted: 'text-muted-foreground',
  changed: 'text-warning',
  invalid: 'text-destructive',
  unknown: 'text-muted-foreground',
}

export interface VerifyCommandsProps {
  rows: readonly VerifyRow[]
  /** What the table says instead of rows (no project chosen, still reading, nothing found). */
  empty: string
  /** The row a write is in flight for (its controls wait). */
  busy: string | null
  /** Why the controls cannot be used now (the list is being read), or null. */
  disabledReason: string | null
  onEnable: (row: VerifyRow, enabled: boolean) => void
  onTrust: (row: VerifyRow, trusted: boolean) => void
  onRemove: (row: VerifyRow) => void
}

/** Where a row runs, relative to the project folder (the row's `cwd`). */
function where(cwd: string): string {
  return cwd === '.' || cwd === '' ? 'Project folder' : cwd
}

export function VerifyCommands({
  rows,
  empty,
  busy,
  disabledReason,
  onEnable,
  onTrust,
  onRemove,
}: VerifyCommandsProps): React.JSX.Element {
  const off = disabledReason !== null
  return (
    <div className={SETTINGS_TABLE.frame}>
      <table
        aria-label="Verify commands"
        data-testid="verify-commands-table"
        className={SETTINGS_TABLE.table}
      >
        <colgroup>
          <col className="w-[46%]" />
          <col className="w-[22%]" />
          <col className="w-[12%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={COLUMNS.length}
                className="px-2 py-3 text-muted-foreground"
                data-testid="verify-commands-empty"
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.flatMap((r) => {
              const waiting = busy === r.key
              const trusted = r.trust === 'trusted'
              const canTrust = r.trust !== 'invalid' && r.trust !== 'unknown'
              const out = [
                <tr
                  key={r.key}
                  data-testid={`verify-row-${r.name}`}
                  data-trust={r.trust}
                  className="border-t"
                >
                  <td className={SETTINGS_TABLE.cell}>
                    <span className="block font-medium">{r.name}</span>
                    <code className="block font-mono break-all text-muted-foreground">{r.line}</code>
                    <span className="block text-muted-foreground">
                      {where(r.cwd)} · {sourceText(r.source)}
                    </span>
                    {r.error !== null && <span className="block text-destructive">{r.error}</span>}
                    {r.error === null && r.notFound && (
                      <span className="block text-warning" data-testid={`verify-row-${r.name}-not-found`}>
                        {r.argv[0] ?? r.name} was not found on this computer.
                      </span>
                    )}
                    {r.body !== null && r.body !== '' && r.trust !== 'changed' && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-muted-foreground select-none">Script</summary>
                        <pre className="stream-text mt-0.5 break-words whitespace-pre-wrap">{r.body}</pre>
                      </details>
                    )}
                  </td>
                  <td
                    className={cn(SETTINGS_TABLE.cell, TRUST_TONE[r.trust])}
                    data-testid={`verify-row-${r.name}-trust`}
                  >
                    {TRUST_TEXT[r.trust]}
                  </td>
                  <td className={SETTINGS_TABLE.cell}>
                    <Switch
                      data-testid={`verify-row-${r.name}-enabled`}
                      aria-label={`Run ${r.name}`}
                      checked={r.enabled}
                      disabled={off || waiting || (!r.enabled && r.error !== null)}
                      onCheckedChange={(v) => onEnable(r, v)}
                    />
                  </td>
                  <td className={SETTINGS_TABLE.cell}>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`verify-row-${r.name}-trust-button`}
                        aria-label={`${trusted ? 'Untrust' : 'Trust'} ${r.name}`}
                        icon={trusted ? <ShieldOff aria-hidden /> : <ShieldCheck aria-hidden />}
                        labels={TRUST_LABELS}
                        loading={waiting}
                        disabled={off || !canTrust}
                        onClick={() => onTrust(r, !trusted)}
                      >
                        {trusted ? 'Untrust' : 'Trust'}
                      </Button>
                      {r.configIndex !== null && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          data-testid={`verify-row-${r.name}-remove`}
                          aria-label={`Remove ${r.name}`}
                          title={`Remove ${r.name}`}
                          disabled={off || waiting}
                          onClick={() => onRemove(r)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>,
              ]
              if (r.trust === 'changed') {
                const diff = scriptDiff([], r.grantedBody, r.body)
                out.push(
                  <tr key={`${r.key}:diff`} data-testid={`verify-row-${r.name}-changed`}>
                    <td colSpan={COLUMNS.length} className={cn(SETTINGS_TABLE.cell, 'pt-0')}>
                      <span className="mb-0.5 block text-muted-foreground">What changed in its script:</span>
                      {diff.some((l) => l.op !== 'same') ? (
                        <BodyDiff lines={diff} testId={`verify-row-${r.name}-diff`} />
                      ) : (
                        <span className="text-muted-foreground">Dim Factory could not show the change.</span>
                      )}
                    </td>
                  </tr>,
                )
              }
              return out
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
