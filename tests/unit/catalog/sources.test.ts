import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_SOURCES,
  SOURCE_ORGS,
  VENDOR_SOURCE_ORG,
  isOfficialSource,
  officialHosts,
  officialSourcesText,
  sourceHostOf,
  sourceOrgOf,
  webFetchDomainRules,
} from '../../../src/core/catalog/sources.ts'
import { KNOWN_VENDORS } from '../../../src/shared/vendors.ts'

describe('official sources table', () => {
  it('holds the official hosts per publisher (plus platform.claude.com, where Anthropic pricing now lives)', () => {
    expect(OFFICIAL_SOURCES).toEqual({
      anthropic: ['docs.anthropic.com', 'www.anthropic.com', 'claude.com', 'platform.claude.com'],
      openai: ['openai.com', 'platform.openai.com', 'developers.openai.com'],
      google: ['ai.google.dev', 'cloud.google.com'],
      xai: ['docs.x.ai', 'x.ai'],
      // Meta's developer site, added with Muse.
      meta: ['dev.meta.ai'],
    })
    expect(Object.keys(OFFICIAL_SOURCES)).toEqual([...SOURCE_ORGS])
  })

  it('is frozen', () => {
    expect(Object.isFrozen(OFFICIAL_SOURCES)).toBe(true)
    expect(Object.isFrozen(OFFICIAL_SOURCES.anthropic)).toBe(true)
  })

  it('maps every known vendor to a publisher; local presets and unknown vendors have none', () => {
    for (const v of KNOWN_VENDORS) expect(SOURCE_ORGS).toContain(VENDOR_SOURCE_ORG[v])
    expect(sourceOrgOf('claude')).toBe('anthropic')
    expect(sourceOrgOf('codex')).toBe('openai')
    expect(sourceOrgOf('gemini')).toBe('google')
    expect(sourceOrgOf('grok')).toBe('xai')
    expect(sourceOrgOf('local-ollama')).toBeNull()
    expect(sourceOrgOf('acme')).toBeNull()
  })
})

describe('isOfficialSource', () => {
  it('accepts https URLs on a listed host', () => {
    expect(isOfficialSource('https://platform.claude.com/docs/en/about-claude/pricing')).toBe(true)
    expect(isOfficialSource('https://developers.openai.com/api/docs/pricing')).toBe(true)
    expect(isOfficialSource('https://CLAUDE.com/pricing#api')).toBe(true)
    expect(isOfficialSource('https://x.ai./api')).toBe(true)
  })

  it('matches hosts exactly (no implicit subdomains, no look-alikes)', () => {
    expect(isOfficialSource('https://community.openai.com/t/price-drop/1')).toBe(false)
    expect(isOfficialSource('https://evil-openai.com/pricing')).toBe(false)
    expect(isOfficialSource('https://openai.com.evil.example/pricing')).toBe(false)
    expect(isOfficialSource('https://www.x.ai/api')).toBe(false)
  })

  it('rejects non-https, credentials and garbage', () => {
    expect(isOfficialSource('http://openai.com/api/pricing')).toBe(false)
    expect(isOfficialSource('ftp://openai.com/pricing')).toBe(false)
    expect(isOfficialSource('https://user:pw@openai.com/pricing')).toBe(false)
    expect(isOfficialSource('not a url')).toBe(false)
    expect(isOfficialSource('')).toBe(false)
    expect(sourceHostOf('https://Docs.X.AI/x')).toBe('docs.x.ai')
  })

  it("with a vendor, only that vendor's publisher counts", () => {
    expect(isOfficialSource('https://platform.claude.com/docs/en/about-claude/pricing', 'claude')).toBe(true)
    expect(isOfficialSource('https://openai.com/api/pricing', 'claude')).toBe(false)
    expect(isOfficialSource('https://openai.com/api/pricing', 'codex')).toBe(true)
    expect(isOfficialSource('https://openai.com/api/pricing', 'local-ollama')).toBe(false)
    expect(isOfficialSource('https://openai.com/api/pricing', 'muse')).toBe(false)
    expect(isOfficialSource('https://dev.meta.ai/docs/coding-agents', 'muse')).toBe(true)
    expect(isOfficialSource('https://dev.meta.ai/docs/coding-agents', 'claude')).toBe(false)
  })
})

describe('derived views', () => {
  it('officialHosts: all publishers by default, de-duplicated and scoped by vendor', () => {
    expect(officialHosts()).toHaveLength(12)
    expect(officialHosts(['codex', 'claude', 'codex'])).toEqual([
      'docs.anthropic.com',
      'www.anthropic.com',
      'claude.com',
      'platform.claude.com',
      'openai.com',
      'platform.openai.com',
      'developers.openai.com',
    ])
    expect(officialHosts(['local-x'])).toEqual([])
  })

  it('webFetchDomainRules: one Claude WebFetch rule per host', () => {
    expect(webFetchDomainRules(['grok'])).toEqual(['WebFetch(domain:docs.x.ai)', 'WebFetch(domain:x.ai)'])
  })

  it('officialSourcesText: the {{officialSources}} value, publishers without hosts omitted', () => {
    // Meta has its host now (it was omitted while it had none).
    expect(officialSourcesText(['claude', 'muse'])).toBe(
      'anthropic: docs.anthropic.com, www.anthropic.com, claude.com, platform.claude.com · meta: dev.meta.ai',
    )
    expect(officialSourcesText()).toContain(
      ' · openai: openai.com, platform.openai.com, developers.openai.com',
    )
    expect(officialSourcesText(['claude'])).not.toContain('meta')
  })
})
