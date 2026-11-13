// "Make two and pick": who builds the two versions of an Easy idea (pure). With two vendors ready each builds one, so
// the versions differ by more than chance; with one ready it builds both ("two tries"). The builders' models are the
// vendors' own defaults, as a Head to head's are when none is named.
import { easyTwoHow } from '../../shared/easy.ts'
import type { MatchContestant } from '../../shared/match.ts'

/**
 * A match's reason for not starting, in Easy's words: the match speaks of "Side A", Easy of versions. What is left is
 * the reason itself (sign in first, the folder is busy).
 */
export function twoErrorText(message: string): string {
  return message
    .replace(/^Side [AB] cannot start\. /, '')
    .replace(/^The match could not be started: /, 'The two versions could not be started: ')
}

/** The two builders for the vendors that are ready, first version first; null when nobody is ready. */
export function twoSides(ready: {
  claude: boolean
  codex: boolean
}): readonly [MatchContestant, MatchContestant] | null {
  const how = easyTwoHow(ready)
  if (how === null) return null
  if (how === 'pair') return [{ vendor: 'claude' }, { vendor: 'codex' }]
  const vendor = ready.claude ? 'claude' : 'codex'
  return [{ vendor }, { vendor }]
}
