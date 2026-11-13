// `open_docs` targets of the failure recovery rows (https only, and only
// allowlisted hosts). Every URL here passes shared/external-links.ts; a vendor without a page for a topic gets none,
// and the action is left out rather than pointing somewhere vague.
import { allowedExternalUrl } from '../../shared/external-links.ts'
import { docsUrlFor } from '../heal/commands.ts'

export type DocTopic = 'install' | 'billing' | 'limits' | 'proxy'

const TOPICS: Readonly<Record<string, Partial<Record<Exclude<DocTopic, 'install'>, string>>>> = {
  claude: {
    billing: 'https://claude.ai/settings/billing',
    limits: 'https://docs.anthropic.com/en/api/rate-limits',
    proxy: 'https://docs.anthropic.com/en/docs/claude-code/corporate-proxy',
  },
  codex: {
    billing: 'https://platform.openai.com/settings/organization/billing',
    limits: 'https://platform.openai.com/docs/guides/rate-limits',
    proxy: 'https://github.com/openai/codex',
  },
  gemini: {
    limits: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    proxy: 'https://github.com/google-gemini/gemini-cli',
  },
}

/** The page for a vendor and topic (install = the vendor's setup docs), checked against the host allowlist. */
export function docsLink(vendor: string | undefined, topic: DocTopic): string | null {
  if (vendor === undefined) return null
  const url = topic === 'install' ? docsUrlFor(vendor) : (TOPICS[vendor]?.[topic] ?? null)
  return url === null ? null : allowedExternalUrl(url)
}
