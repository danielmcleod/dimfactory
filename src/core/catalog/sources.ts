// Official pricing/model-documentation sources: the ONE table that the
// Claude refresh job's WebFetch domain rules, the `{{officialSources}}` prompt value and the `unofficial` diff flag
// all read. Hosts match exactly (no implicit subdomains), the same way a `WebFetch(domain:<host>)` rule does.
import { isKnownVendor } from '../../shared/vendors.ts'
import type { KnownVendor, VendorId } from '../../shared/vendors.ts'

export const SOURCE_ORGS = ['anthropic', 'openai', 'google', 'xai', 'meta'] as const
/** The company that publishes a vendor's models and prices. */
export type SourceOrg = (typeof SOURCE_ORGS)[number]

/**
 * Official hosts per publisher. `platform.claude.com` is listed explicitly: Anthropic's API docs and pricing page
 * moved there from docs.anthropic.com, and hosts never match by suffix. Meta's developer site (dev.meta.ai), where
 * Muse Code and the Meta Model API are documented, arrives with Muse.
 */
export const OFFICIAL_SOURCES: Readonly<Record<SourceOrg, readonly string[]>> = deepFreeze({
  anthropic: ['docs.anthropic.com', 'www.anthropic.com', 'claude.com', 'platform.claude.com'],
  openai: ['openai.com', 'platform.openai.com', 'developers.openai.com'],
  google: ['ai.google.dev', 'cloud.google.com'],
  xai: ['docs.x.ai', 'x.ai'],
  meta: ['dev.meta.ai'],
})

/** Dim Factory vendor → the publisher whose pages are official for its prices. */
export const VENDOR_SOURCE_ORG: Readonly<Record<KnownVendor, SourceOrg>> = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  grok: 'xai',
  muse: 'meta',
})

/** Publisher for a vendor id; null for `local-*` presets and unknown vendors. */
export function sourceOrgOf(vendor: VendorId): SourceOrg | null {
  return isKnownVendor(vendor) ? VENDOR_SOURCE_ORG[vendor] : null
}

function orgsFor(vendors: readonly VendorId[] | undefined): SourceOrg[] {
  if (vendors === undefined) return [...SOURCE_ORGS]
  const wanted = new Set<SourceOrg>()
  for (const v of vendors) {
    const org = sourceOrgOf(v)
    if (org !== null) wanted.add(org)
  }
  return SOURCE_ORGS.filter((o) => wanted.has(o))
}

/** Official hosts for `vendors` (every publisher when omitted), de-duplicated, in table order. */
export function officialHosts(vendors?: readonly VendorId[]): string[] {
  const out: string[] = []
  for (const org of orgsFor(vendors)) for (const h of OFFICIAL_SOURCES[org]) if (!out.includes(h)) out.push(h)
  return out
}

/** Lower-cased host of an https URL, else null (http, other schemes, credentials in the URL, unparsable). */
export function sourceHostOf(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null
  return u.hostname.toLowerCase().replace(/\.$/, '')
}

/**
 * True when `url` is https on an official host. With `vendor`, only that vendor's publisher counts (an Anthropic
 * price sourced from openai.com is unofficial); a vendor without a publisher (local preset) has no official host.
 */
export function isOfficialSource(url: string, vendor?: VendorId): boolean {
  const host = sourceHostOf(url)
  if (host === null) return false
  return officialHosts(vendor === undefined ? undefined : [vendor]).includes(host)
}

/** Claude `--allowedTools` entries for the refresh job: one `WebFetch(domain:<host>)` per official host. */
export function webFetchDomainRules(vendors?: readonly VendorId[]): string[] {
  return officialHosts(vendors).map((h) => `WebFetch(domain:${h})`)
}

/** The `{{officialSources}}` prompt value, e.g. `anthropic: docs.anthropic.com, … · openai: openai.com, …`. */
export function officialSourcesText(vendors?: readonly VendorId[]): string {
  return orgsFor(vendors)
    .filter((org) => OFFICIAL_SOURCES[org].length > 0)
    .map((org) => `${org}: ${OFFICIAL_SOURCES[org].join(', ')}`)
    .join(' · ')
}

function deepFreeze<T extends Record<string, readonly string[]>>(o: T): T {
  for (const v of Object.values(o)) Object.freeze(v)
  return Object.freeze(o)
}
