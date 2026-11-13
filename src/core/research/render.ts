// Research's renderings: research.md (Dim Factory's own rendering of the parsed, cited answer, never the model's
// text) and `{{research}}`, the items the user kept at the research card as the Plan prompt reads them.
import type { ResearchLens, ResearchResult } from '../../shared/research.ts'

const cite = (sources: readonly string[]): string => (sources.length > 0 ? ` (${sources.join(', ')})` : '')

/** research.md: every section of the parsed answer, its lenses, and how many uncited claims were dropped. */
export function renderResearchMd(
  r: ResearchResult,
  o: { lenses: readonly Pick<ResearchLens, 'label' | 'web'>[]; web: boolean },
): string {
  const out: string[] = ['# Research', '']
  out.push(
    `Lenses: ${o.lenses.map((l) => l.label).join(', ')}.`,
    o.web ? 'Web search was on; web content is untrusted input.' : 'No web search: this repository only.',
    '',
  )
  if (r.summary.length > 0) out.push('## Summary', '', ...r.summary.map((l) => `- ${l}`), '')
  if (r.features.length > 0) {
    out.push('## Features', '', '| Feature | Priority | Seen in |', '| --- | --- | --- |')
    for (const f of r.features)
      out.push(`| ${f.feature.replace(/\|/g, '\\|')} | ${f.priority} | ${f.sources.join(', ')} |`)
    out.push('')
  }
  if (r.standards.length > 0) {
    out.push('## Standards and practices', '')
    for (const s of r.standards)
      out.push(`- ${s.standard}${s.why !== undefined ? `: ${s.why}` : ''}${cite(s.sources)}`)
    out.push('')
  }
  if (r.options.length > 0) {
    out.push('## Options', '')
    for (const op of r.options) {
      out.push(`### ${op.topic}`, '')
      if (op.options.length > 0) out.push(`Options: ${op.options.join(', ')}.`, '')
      out.push(
        `Recommendation: ${op.recommendation}.${op.rationale !== '' ? ` ${op.rationale}` : ''}${cite(op.sources)}`,
        '',
      )
    }
  }
  if (r.risks.length > 0)
    out.push('## Risks and pitfalls', '', ...r.risks.map((x) => `- ${x.risk}${cite(x.sources)}`), '')
  if (r.questions.length > 0)
    out.push('## Open questions', '', ...r.questions.map((q) => `- ${q.question}`), '')
  if (r.sources.length > 0)
    out.push(
      '## Sources',
      '',
      ...r.sources.map((s) => `- ${s.title !== undefined ? `${s.title}: ` : ''}${s.url}`),
      '',
    )
  if (r.dropped > 0)
    out.push(
      r.dropped === 1
        ? 'One claim was left out because it cited no source.'
        : `${r.dropped} claims were left out because they cited no source.`,
      '',
    )
  return `${out.join('\n').trimEnd()}\n`
}

/**
 * `{{research}}`: the summary, the features, standards and recommendations the user kept (`chosen` ids), the risks,
 * and the answers to open questions, each with its sources. Empty when nothing was kept and nothing answered.
 */
export function researchForPlan(
  r: ResearchResult,
  chosen: readonly string[],
  answers: Readonly<Record<string, string>> = {},
): string {
  const keep = new Set(chosen)
  const features = r.features.filter((f) => keep.has(f.id))
  const standards = r.standards.filter((s) => keep.has(s.id))
  const options = r.options.filter((o) => keep.has(o.id))
  const answered = r.questions.filter((q) => (answers[q.id] ?? '').trim() !== '')
  if (features.length + standards.length + options.length + answered.length === 0) return ''
  const out: string[] = []
  if (r.summary.length > 0) out.push('Summary:', ...r.summary.map((l) => `- ${l}`), '')
  if (features.length > 0)
    out.push(
      'Features to include:',
      ...features.map((f) => `- [${f.priority}] ${f.feature}${cite(f.sources)}`),
      '',
    )
  if (standards.length > 0) {
    out.push(
      'Standards and practices to follow:',
      ...standards.map((s) => `- ${s.standard}${s.why !== undefined ? `: ${s.why}` : ''}${cite(s.sources)}`),
      '',
    )
  }
  if (options.length > 0) {
    out.push(
      'Recommended choices:',
      ...options.map((o) => {
        const weighed = o.options.length > 0 ? ` (weighed: ${o.options.join(', ')})` : ''
        return `- ${o.topic}: ${o.recommendation}.${o.rationale !== '' ? ` ${o.rationale}` : ''}${weighed}${cite(o.sources)}`
      }),
      '',
    )
  }
  if (r.risks.length > 0)
    out.push('Risks research found:', ...r.risks.map((x) => `- ${x.risk}${cite(x.sources)}`), '')
  if (answered.length > 0) {
    out.push('Answers to research questions:')
    for (const q of answered)
      out.push(`- ${q.question}`, `  Answer: ${(answers[q.id] ?? '').replace(/\s+/g, ' ').trim()}`)
  }
  return out.join('\n').trimEnd()
}
