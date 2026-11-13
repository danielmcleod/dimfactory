// Easy mode's "Look it over" for a website, an app or a game: an optional, read-only look at the picture of the page
// that the smoke check took (runs/<id>/preview/smoke.png), by a vendor whose adapter sends pictures
// (Adapter.acceptsImages). A game is looked at in two pictures, its title screen and a moment of play (gameplay.png, the
// game checks take it), with a game's own list of what to look for.
// What it finds becomes `[should]` findings of the run's preview check (smoke.json, source `preview`, beside the
// console errors), and the latest look is kept in visual.json for the Done screen. Only on the user's click; it never
// changes the project.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { EASY_VISUAL_FINDINGS_MAX } from '../../shared/easy.ts'
import type { EasyVisualFinding } from '../../shared/easy.ts'
import type { Finding } from '../../shared/findings.ts'
import type { PreviewSmokeView } from '../../shared/preview.ts'
import { findingId } from '../findings/parse.ts'
import { healCopy } from '../heal/parse-heal.ts'
import type { HomePaths } from '../home.ts'
import { runPreviewDir } from '../preview/smoke.ts'
import { writeFileAtomicLite } from '../proc/atomic-lite.ts'

/** About how many tokens one look takes (the cost hint): the picture, a short prompt and a short answer. */
export const VISUAL_TOKENS = 6000

export const VISUAL_LABEL = 'Look it over'
export const VISUAL_NO_VENDOR =
  'Looking at a picture of the page needs Claude, or Codex on its newer connection, signed in. Neither is ready here, so this is off.'
export const VISUAL_NO_PICTURE = 'There is no picture of the page yet. Open it once, then look it over.'
export const VISUAL_BAD_ANSWER = 'The answer could not be read, so nothing was added. You can try again.'

/** Each finding's title starts with this, so a later look replaces the earlier one's and nothing else. */
export const VISUAL_TITLE_PREFIX = 'How the page looks: '
const TITLE_MAX = 160
const DETAIL_MAX = 400

/** What a game's look is for: the HUD, the play area, the art, contrast, and nothing like a famous game's characters. */
function gameVisualPrompt(): string {
  return [
    'The attached pictures are screenshots of a browser game someone had made for them: the first is its title screen, the second a moment of play. Look at them as a careful game designer would and list what looks wrong or hard to play.',
    'Do not change or run anything, do not read files and do not use any tool.',
    '',
    'Look for: a score, lives or other HUD text that is hard to read (low contrast, too small, drawn over busy art); a play area that does not fit the window or is cut off; placeholder art (plain boxes labelled with words, missing images, "TODO" or lorem ipsum); colours that are hard to tell apart; text or buttons that overlap; and anything that looks like the characters, logo or art of a famous game (the game must use its own).',
    'Do not mention matters of taste, and do not guess at what the pictures do not show.',
    '',
    'Rules:',
    `- At most ${EASY_VISUAL_FINDINGS_MAX} findings, the most important first. None is a good answer when the game looks fine.`,
    '- Each title is one short, plain sentence a person who does not write code understands. The detail says where on the screen and what would fix it.',
    '- Output exactly one ```json fenced block and nothing else.',
    '',
    'Example:',
    '```json',
    '{"findings":[{"title":"<one sentence>","detail":"<where, and what would fix it>"}]}',
    '```',
  ].join('\n')
}

/** The look's prompt: a page's, or a game's (two pictures). */
export function visualPrompt(kind: 'page' | 'game' = 'page'): string {
  if (kind === 'game') return gameVisualPrompt()
  return [
    'The attached picture is a screenshot of a web page someone had made for them. Look at it as a careful designer would and list what looks wrong or hard to use.',
    'Do not change or run anything, do not read files and do not use any tool.',
    '',
    'Look for: text that is hard to read (low contrast, too small), things that overlap or are cut off, broken or missing images, empty areas that look unfinished, placeholder text, buttons or links that look broken, and an uneven layout.',
    'Do not mention matters of taste, and do not guess at what the picture does not show.',
    '',
    'Rules:',
    `- At most ${EASY_VISUAL_FINDINGS_MAX} findings, the most important first. None is a good answer when the page looks fine.`,
    '- Each title is one short, plain sentence a person who does not write code understands. The detail says where on the page and what would fix it.',
    '- Output exactly one ```json fenced block and nothing else.',
    '',
    'Example:',
    '```json',
    '{"findings":[{"title":"<one sentence>","detail":"<where, and what would fix it>"}]}',
    '```',
  ].join('\n')
}

const AnswerZ = z.object({
  findings: z.array(z.object({ title: z.string(), detail: z.string().optional() })).max(50),
})

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/

/** The findings of an answer (the first ones, cleaned); null when it is not the expected JSON. */
export function parseVisualAnswer(text: string): EasyVisualFinding[] | null {
  const src = text.replace(/\r\n?/g, '\n')
  const block = FENCE.exec(src)
  const body =
    block !== null
      ? (block[2] ?? '')
      : src.indexOf('{') !== -1 && src.lastIndexOf('}') > src.indexOf('{')
        ? src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)
        : null
  if (body === null) return null
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const r = AnswerZ.safeParse(json)
  if (!r.success) return null
  const out: EasyVisualFinding[] = []
  const seen = new Set<string>()
  for (const f of r.data.findings) {
    if (out.length >= EASY_VISUAL_FINDINGS_MAX) break
    const title = healCopy(f.title, TITLE_MAX)
    if (title === '' || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    const id = findingId('preview', `${VISUAL_TITLE_PREFIX}${title}`)
    out.push({ id, title, detail: healCopy(f.detail ?? '', DETAIL_MAX) })
  }
  return out
}

/** The look's findings as the preview check's `[should]` findings. */
export function visualFindings(list: readonly EasyVisualFinding[]): Finding[] {
  return list.map((f, i) => ({
    id: f.id,
    n: i + 1,
    severity: 'should',
    source: 'preview',
    title: `${VISUAL_TITLE_PREFIX}${f.title}`,
    body: f.detail,
    flags: [],
    round: 1,
  }))
}

/** Where a game run's picture of a moment of play is (the game checks take it; it may not be there yet). */
export function gameplayPicture(paths: HomePaths, runId: string): string {
  return join(runPreviewDir(paths, runId), 'gameplay.png')
}

/** Where the run's picture of the page is (the smoke check writes it; it may not be there yet). */
export function smokePicture(paths: HomePaths, runId: string): string {
  return join(runPreviewDir(paths, runId), 'smoke.png')
}

const VisualFileZ = z.object({
  at: z.number(),
  vendor: z.string(),
  findings: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string() })),
})

/** visual.json: the latest look (null: none, or unreadable). */
export async function readVisual(
  paths: HomePaths,
  runId: string,
): Promise<{ at: number; vendor: string; findings: EasyVisualFinding[] } | null> {
  try {
    const r = VisualFileZ.safeParse(
      JSON.parse(await readFile(join(runPreviewDir(paths, runId), 'visual.json'), 'utf8')),
    )
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/**
 * Keep a look: visual.json, and its findings in smoke.json in place of an earlier look's (the console errors' findings
 * stay first, everything renumbered). Answers smoke.json's findings as written (null: there is no smoke check to add
 * them to), so the run's findings can take them.
 */
export async function recordVisual(
  paths: HomePaths,
  runId: string,
  o: { at: number; vendor: string; findings: readonly EasyVisualFinding[] },
): Promise<Finding[] | null> {
  const dir = runPreviewDir(paths, runId)
  await writeFileAtomicLite(
    join(dir, 'visual.json'),
    `${JSON.stringify({ at: o.at, vendor: o.vendor, findings: o.findings }, null, 2)}\n`,
  )
  let smoke: PreviewSmokeView | null
  try {
    smoke = JSON.parse(await readFile(join(dir, 'smoke.json'), 'utf8')) as PreviewSmokeView
  } catch {
    smoke = null
  }
  if (smoke === null || !Array.isArray(smoke.findings)) return null
  const own = smoke.findings.filter((f) => !f.title.startsWith(VISUAL_TITLE_PREFIX))
  const findings = [...own, ...visualFindings(o.findings)].map((f, i) => ({ ...f, n: i + 1 }))
  await writeFileAtomicLite(join(dir, 'smoke.json'), `${JSON.stringify({ ...smoke, findings }, null, 2)}\n`)
  return findings
}
