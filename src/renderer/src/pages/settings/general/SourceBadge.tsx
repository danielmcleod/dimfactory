// Where a General setting's value comes from (core's provenance map): the built-in default, your settings, or
// (with a project chosen) that project's settings. Core's provenance map is the only source; the badge formats it. It
// sits in a box of one fixed width, there before the values arrive, so its arrival or a change of source moves nothing
// beside it. The full sentence is its title and accessible name.
import type { Provenance } from '@shared/config-schema.ts'

export type ValueSource = 'default' | 'user' | 'project'

export const SOURCE_LABEL: Readonly<Record<ValueSource, string>> = {
  default: 'Default',
  user: 'Yours',
  project: 'Project',
}

/** The three sources a General value can have (anything else core names counts as the default). */
export function valueSource(p: Provenance | undefined): ValueSource {
  return p?.source === 'user' ? 'user' : p?.source === 'project' ? 'project' : 'default'
}

function where(p: Provenance | undefined): string {
  if (p?.file === undefined) return ''
  return p.line !== undefined ? `: ${p.file}, line ${p.line}` : `: ${p.file}`
}

export function sourceTitle(p: Provenance | undefined): string {
  switch (valueSource(p)) {
    case 'default':
      return 'Built-in default'
    case 'user':
      return `Your settings${where(p)}`
    case 'project':
      return `This project's settings${where(p)}`
  }
}

const BOX = 'inline-flex w-14 shrink-0'
const BADGE =
  'inline-flex items-center whitespace-nowrap rounded-md border px-1 text-[10px] leading-4 font-normal'

export function SourceBadge({
  provenance,
  loading = false,
  testId,
}: {
  provenance: Provenance | undefined
  /** The values are not read yet: the box is kept, empty. */
  loading?: boolean
  testId?: string
}): React.JSX.Element {
  if (loading) return <span aria-hidden className={BOX} />
  const source = valueSource(provenance)
  const title = sourceTitle(provenance)
  return (
    <span
      data-testid={testId}
      data-source={source}
      title={title}
      aria-label={`${SOURCE_LABEL[source]}: ${title}`}
      className={BOX}
    >
      <span
        className={
          source === 'project'
            ? `${BADGE} border-info/50 text-info`
            : `${BADGE} border-border text-muted-foreground`
        }
      >
        {SOURCE_LABEL[source]}
      </span>
    </span>
  )
}
