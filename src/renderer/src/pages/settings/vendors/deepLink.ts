// Deep links into Settings → Vendors (e.g. `#/settings/vendors/codex?field=path`).
// Core's settings_link routes carry the JSON pointer instead (`#/settings/vendors?field=/vendors/codex/path`); both
// name a vendor card and the field to focus.
import type { Route } from '../../../lib/router.ts'

export type VendorField = 'path' | 'defaultModel'

export interface VendorTarget {
  vendor: string
  /** null: the card itself. */
  field: VendorField | null
}

const FIELD_NAMES: Readonly<Record<string, VendorField>> = {
  path: 'path',
  defaultModel: 'defaultModel',
  model: 'defaultModel',
}

/** The vendor card (and field) a Settings route points at, or null. */
export function vendorTarget(route: Route): VendorTarget | null {
  if (route.name !== 'settings' || route.section !== 'vendors') return null
  const field = route.query['field'] ?? ''
  const pointer = /^\/vendors\/([^/]+)(?:\/([^/]+))?/.exec(field)
  if (pointer !== null) {
    const vendor = pointer[1] ?? ''
    return { vendor, field: FIELD_NAMES[pointer[2] ?? ''] ?? null }
  }
  const vendor = route.subpath[0]
  if (vendor === undefined || vendor === '') return null
  return { vendor, field: FIELD_NAMES[field] ?? null }
}
