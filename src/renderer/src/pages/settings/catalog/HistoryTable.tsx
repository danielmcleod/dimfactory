// Settings → Catalog's update history (each apply keeps a combined backup in catalog/history/, 20 kept): the last
// 20 changes to the prices, newest first, from core. Only the change
// catalog.undo would put back now (core's `undoId`) has Undo; the older entries are a record and read-only.
import { Undo2 } from 'lucide-react'
import { useState } from 'react'
import type { CatalogState } from '@shared/catalog.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { cn } from '../../../lib/cn.ts'
import { undoCatalog } from '../../../state/catalog.ts'
import { SETTINGS_TABLE } from '../kit.tsx'
import { historySource, priceCount, undoableId } from './model.ts'

/** Core keeps 20 (catalog/history/); never more are listed. */
export const HISTORY_MAX = 20
export const HISTORY_EMPTY = 'No changes yet.'
export const UNDO_LAST_LABEL = 'Undo the last change'
const COLUMNS = ['When', 'What changed', 'Prices'] as const

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function HistoryTable({ state }: { state: CatalogState }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const history = Array.isArray(state.history) ? state.history.slice(0, HISTORY_MAX) : []
  const undoId = undoableId({ history, ...(state.undoId !== undefined ? { undoId: state.undoId } : {}) })
  return (
    <div className={SETTINGS_TABLE.frame}>
      <table aria-label="Update history" data-testid="catalog-history" className={SETTINGS_TABLE.table}>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {COLUMNS.map((c, i) => (
              <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium', i === 2 && 'w-1/5')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="px-2 py-3 text-muted-foreground">
                {HISTORY_EMPTY}
              </td>
            </tr>
          ) : (
            history.map((h) => (
              <tr
                key={h.id}
                data-testid={`catalog-history-${h.id}`}
                data-undoable={h.id === undoId || undefined}
                className="border-t"
              >
                <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>{when(h.at)}</td>
                <td className={SETTINGS_TABLE.cell}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      {historySource(h.source)}
                      {h.undone === true && <span className="text-muted-foreground"> (undone)</span>}
                    </span>
                    {h.id === undoId && (
                      <span data-setting-field="undoUpdate" className="contents">
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="catalog-history-undo"
                          aria-label={UNDO_LAST_LABEL}
                          title="Put back the prices from before this change"
                          icon={<Undo2 aria-hidden />}
                          loading={busy}
                          onClick={() => {
                            setBusy(true)
                            void undoCatalog().finally(() => setBusy(false))
                          }}
                        >
                          Undo
                        </Button>
                      </span>
                    )}
                  </span>
                </td>
                <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>{priceCount(h.entries)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
