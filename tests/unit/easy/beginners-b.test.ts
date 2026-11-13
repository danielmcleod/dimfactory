// Easy mode for beginners, part B (pure parts): ideas reach the right template (a plain checklist, not a runbook; a
// chore chart and a trip report are not data reports; research explains unless it is asked to choose), other
// languages get a kind and a folder name of their own, every task carries the no-invented-facts and language rule,
// a change is sized and its security decided from its words, the security advisor's scan tells sensitive diffs, a
// research memo's links are checked against Research's sources, a workbook's first sheet becomes CSV, unsaved files
// are counted, and the first memory note starts from what the project is.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZipWriter } from '@core/deploy/zip.ts'
import { readFileSync } from 'node:fs'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { readBuiltinTemplates } from '@core/templates/load.ts'
import { readBuiltinRecipes } from '@core/recipes/load.ts'
import {
  EASY_RULES_NOTE,
  DATA_CHANGE_NOTE,
  TWO_COPIES_NOTE,
  ambiguousKinds,
  changeTask,
  chooseTemplate,
  detectKind,
  easyTask,
  slugOf,
} from '@core/easy/resolve.ts'
import { changeTouchesSensitive, isSmallChange } from '@core/easy/change.ts'
import { SMALL_CHANGE_PLAN_MODEL, easyOverrides } from '@core/easy/overrides.ts'
import { changePlan, queueWarnings } from '@core/easy/service.ts'
import { sensitiveChange } from '@core/security/sensitive.ts'
import { citedLinks, linkFindings, linkKey } from '@core/grounding/links.ts'
import { xlsxToCsv } from '@core/easy/xlsx.ts'
import { countStatus } from '@core/easy/save-first.ts'
import { memorySkeleton, withRunNote } from '@core/factory/memory.ts'
import { recipeOverrides } from '@shared/recipes.ts'

const packs = readBuiltinPacks().map((v) => v.pack)
const templates = readBuiltinTemplates()
const NONE = { node: false, python: false }
const tpl = (id: string) => {
  const t = templates.find((x) => x.id === id)
  if (t === undefined) throw new Error(id)
  return t
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-easy-b-'))
  dirs.push(d)
  return d
}

describe('no invented facts', () => {
  it('every Easy task and change carries the rule: marked [Fill in: ...] slots, listed; the language of the request', () => {
    expect(EASY_RULES_NOTE).toMatch(/Never invent facts/)
    expect(EASY_RULES_NOTE).toMatch(/\[Fill in: what goes here\]/)
    expect(EASY_RULES_NOTE).toMatch(/Things to fill in/)
    expect(EASY_RULES_NOTE).toMatch(/language this request is written in/)
    expect(EASY_RULES_NOTE).toMatch(/<html lang>/)
    expect(easyTask(tpl('landing-page'), 'A page for my bakery')).toContain(EASY_RULES_NOTE)
    expect(changeTask('Add our opening hours')).toContain(EASY_RULES_NOTE)
  })

  it('docs-simple allows listed fill-ins and no lorem ipsum, and says to change it through Make a change', () => {
    const t = tpl('docs-simple').task
    expect(t).toMatch(/No lorem ipsum/)
    expect(t).toMatch(/\[Fill in: what goes here\]/)
    expect(t).toMatch(/Things to fill in/)
    expect(t).not.toMatch(/no placeholder text may be left/)
    expect(t).toMatch(/Make a change in Dim Factory, which keeps both in step/)
  })

  it('both landing pages have a testimonial slot that is never made up', () => {
    for (const id of ['landing-page', 'landing-react'])
      expect(tpl(id).task, id).toMatch(/\[Fill in: a customer's words\] \(never made up\)/)
  })

  it('both Explain prompts end with Things to fill in, Where things are and Changing it yourself, in the user language', () => {
    for (const f of ['explain.md', 'explain-easy.md']) {
      const text = readFileSync(join('src/core/prompts/defaults', f), 'utf8')
      for (const h of ['## Things to fill in', '## Where things are', '## Changing it yourself'])
        expect(text, `${f} ${h}`).toContain(h)
      expect(text, f).toMatch(/Write "Nothing to fill in\." when there is none/)
      expect(text, f).toMatch(/language the request is written in/)
    }
  })

  it('Clarify may ask for the details only the owner knows, and asks in their language', () => {
    const text = readFileSync('src/core/prompts/defaults/clarify-easy.md', 'utf8')
    expect(text).toContain('"Do you have the details (hours, prices, policies) to paste?"')
    expect(text).toMatch(/language the request is written in/)
  })
})

describe('routing', () => {
  it('a checklist is a plain printable checklist; a runbook only for servers and deploys', () => {
    const idea = 'Checklist for opening my cafe each morning'
    expect(detectKind(idea, packs).kind).toBe('checklist')
    expect(chooseTemplate('checklist', idea, NONE).templateId).toBe('checklist')
    expect(chooseTemplate('checklist', 'A checklist for deploying our web server', NONE).templateId).toBe(
      'runbook',
    )
    expect(chooseTemplate('checklist', 'A runbook for our database', NONE).templateId).toBe('runbook')
    const t = tpl('checklist')
    expect(t.pack).toBe('operations')
    expect(t.task).toMatch(/localStorage/)
    expect(t.task).toMatch(/print/)
    expect(t.task).toMatch(/no services, servers, deploy or roll-back steps, scripts or incident templates/)
    expect(t.checks?.map((c) => c.run)).toEqual([['dimf:pageload', 'checklist.html']])
  })

  it('"chart" and "report from" mean data only alongside data words', () => {
    expect(detectKind('A chore chart for my kids', packs).kind).toBe('checklist')
    expect(detectKind('A seating chart for our wedding', packs).kind).not.toBe('data')
    expect(detectKind('A report from our school trip to the museum', packs).kind).toBe('document')
    expect(detectKind('A report from our sales numbers this year', packs).kind).toBe('data')
    expect(detectKind('A chart of our monthly sales', packs).kind).toBe('data')
    expect(detectKind('Graphs of our revenue over time', packs).kind).toBe('data')
    expect(ambiguousKinds('A chore chart for my kids', packs)).toEqual([])
  })

  it('the research template explains unless the words ask to choose', () => {
    expect(chooseTemplate('research', 'Research how sourdough starters work', NONE).templateId).toBe(
      'explainer-memo',
    )
    expect(
      chooseTemplate('research', 'A research memo comparing three booking tools, with a recommendation', NONE)
        .templateId,
    ).toBe('decision-memo')
    expect(chooseTemplate('research', 'Which CRM should my team use?', NONE).templateId).toBe('decision-memo')
    expect(chooseTemplate('research', 'Pros and cons of solar panels', NONE).templateId).toBe('decision-memo')
    expect(tpl('explainer-memo').brief?.fields['questionType']?.choices).toEqual(['explain'])
    expect(tpl('explainer-memo').task).toMatch(/Do not score options or recommend a choice/)
  })
})

describe('other languages', () => {
  it.each([
    ['Un juego de memoria para mis alumnos', 'game'],
    ['Un site web pour ma boulangerie', 'website'],
    ['Eine Checkliste für den Umzug', 'checklist'],
    ['Um guia para os clientes da minha loja', 'document'],
    ['Un foglio di calcolo delle vendite', 'data'],
    ['我的面包店网站', 'website'],
    ['子供向けのゲーム', 'game'],
  ] as const)('%s -> %s', (idea, kind) => {
    expect(detectKind(idea, packs)).toEqual({ kind, source: 'words' })
  })

  it('a folder name keeps letters of other scripts instead of "my-project"', () => {
    expect(slugOf('パン屋のサイト')).toBe('パン屋のサイト')
    expect(slugOf('Сайт для пекарни')).toBe('сайт-для-пекарни')
    expect(slugOf('Café menu')).toBe('cafe-menu')
    expect(slugOf('¿¡!?')).toBe('my-project')
    expect([...slugOf('長'.repeat(80))].length).toBeLessThanOrEqual(40)
  })

  it('the web templates set <html lang> to the language of the request', () => {
    for (const id of [
      'static-site',
      'landing-page',
      'react-site',
      'landing-react',
      'docs-simple',
      'checklist',
    ])
      expect(tpl(id).task, id).toMatch(/<html lang>/)
  })
})

describe('games feel good to play', () => {
  it('every Easy game template asks for feedback, a gentle ramp and a quick replay', () => {
    for (const id of [
      'game-canvas',
      'game-board',
      'game-story',
      'game-phaser',
      'game-tool',
      'game-vite',
      'game-3d-lite',
    ])
      expect(tpl(id).task, id).toMatch(/Make it feel good to play: every action gets clear feedback/)
  })
})

describe('data reports', () => {
  it('security is on for data reports, with a focus on keeping people out of the page', () => {
    const recipe = readBuiltinRecipes().find((v) => v.recipe.id === 'easy-data')?.recipe
    expect(recipe !== undefined && recipeOverrides(recipe).passes?.security?.enabled).toBe(true)
    const data = packs.find((p) => p.id === 'data')
    expect(data?.security?.focus.join('\n')).toMatch(/never names, email addresses/)
    expect(data?.security?.focus.join('\n')).toMatch(/js\/data\.js/)
  })

  it('the report has an Example data banner, regenerates its data copy and says to swap data with a change', () => {
    const t = tpl('data-report-web').task
    expect(t).toMatch(/"Example data" banner/)
    expect(t).toMatch(/whenever the data in data\/ changes, write it again/)
    expect(t).toMatch(/ask for a change in Dim Factory/)
    expect(t).toMatch(/never names, email addresses/)
    expect(changeTask('Use my new file', { kind: 'data' })).toContain(DATA_CHANGE_NOTE)
    expect(changeTask('Fix a typo', { kind: 'document' })).toContain(TWO_COPIES_NOTE)
    expect(changeTask('Use my file', { kind: 'data', attached: ['data/new.csv'] })).toContain(
      '- data/new.csv',
    )
  })
})

describe('a change, sized and checked from its words', () => {
  it.each([
    ['Make the buttons bigger', true],
    ['Change the title colour to dark green', true],
    ['Fix the typo in the footer', true],
    ['Add a page for our menu with prices', false],
    ['Add a sign in so members can log in', false],
    ['Redesign the whole site', false],
    ['', false],
    ['Make the buttons bigger. '.repeat(10), false],
  ] as const)('small(%j) = %s', (change, small) => {
    expect(isSmallChange(change)).toBe(small)
  })

  it('the full security review when the words name keys or people data; the scan alone otherwise', () => {
    expect(changeTouchesSensitive('Add a weather widget, my key is sk-abc123def456ghi')).toBe(true)
    expect(changeTouchesSensitive('Save the email addresses people enter')).toBe(true)
    expect(changeTouchesSensitive('Take payments with Stripe')).toBe(true)
    expect(changeTouchesSensitive('Make the buttons bigger')).toBe(false)
    expect(changeTouchesSensitive('Swap in my new data file', { kind: 'data' })).toBe(true)
    expect(changePlan('Make the buttons bigger', 'website', 0)).toEqual({ small: true, review: 'sensitive' })
    expect(changePlan('Make the buttons bigger', 'data', 1)).toEqual({ small: false, review: 'always' })
    expect(changePlan('Add my API key for the weather', 'app', 0)).toEqual({ small: false, review: 'always' })
  })

  it('a small change plans on a lighter model with no Critic; every change has the secret scan', () => {
    const base = { skipPlanCheck: false, limits: { maxCostUsd: null, maxMinutes: null } }
    const small = easyOverrides({
      ...base,
      profile: 'balanced',
      change: { small: true, review: 'sensitive' },
    })
    expect(small.passes?.plan?.model).toBe(SMALL_CHANGE_PLAN_MODEL)
    expect(small.passes?.critic?.enabled).toBe(false)
    expect(small.passes?.security).toMatchObject({ enabled: true, review: 'sensitive' })
    const codex = easyOverrides({
      ...base,
      profile: 'codex-only',
      change: { small: true, review: 'sensitive' },
    })
    expect(codex.passes?.plan?.model).toBeUndefined()
    expect(codex.passes?.critic?.enabled).toBe(false)
    const big = easyOverrides({ ...base, profile: 'balanced', change: { small: false, review: 'always' } })
    expect(big.passes?.plan?.model).toBeUndefined()
    expect(big.passes?.critic?.enabled).toBeUndefined()
    expect(big.passes?.security).toMatchObject({ enabled: true, review: 'always' })
    // A new project keeps its recipe's security switch (nothing set here).
    expect(easyOverrides({ ...base, profile: 'balanced' }).passes?.security).toEqual({ extensions: 'none' })
  })
})

describe('the scan reads whether a diff is sensitive', () => {
  const patch = (file: string, ...lines: string[]): string =>
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -0,0 +1 @@',
      ...lines.map((l) => `+${l}`),
    ].join('\n')
  it.each([
    [patch('styles.css', 'button { padding: 1rem; }'), false],
    [patch('index.html', '<h1>Bramble &amp; Rye</h1>'), false],
    [patch('src/api.ts', "const r = await fetch('https://api.example.com')"), true],
    [patch('src/config.ts', 'const key = import.meta.env.VITE_MAPS_KEY'), true],
    [patch('src/save.ts', "localStorage.setItem('list', JSON.stringify(items))"), true],
    [patch('contact.html', '<form action="/thanks" method="post">'), true],
    [patch('data/people.csv', 'name,score'), true],
    [patch('netlify/functions/ai.ts', 'export default async () => {}'), true],
  ])('%#', (p, sensitive) => {
    expect(sensitiveChange(p)).toBe(sensitive)
  })
})

describe("a research memo's links against Research's sources", () => {
  it('flags links Research did not find, once per file, as [should]', () => {
    const added = new Map([
      [
        'memo.md',
        [
          'See [the guide](https://www.example.org/guide/) and https://made-up.example.com/page.',
          'Also https://example.org/guide#part.',
        ],
      ],
      ['src/app.ts', ['// https://not-a-memo.example.com']],
    ])
    expect(citedLinks(added).get('memo.md')).toEqual([
      'https://www.example.org/guide/',
      'https://made-up.example.com/page',
    ])
    expect(linkKey('https://WWW.Example.org/guide/#x')).toBe('example.org/guide')
    const f = linkFindings(added, ['https://example.org/guide'])
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ severity: 'should', source: 'grounding' })
    expect(f[0]?.title).toBe('`memo.md`: a link that Research did not find')
    expect(f[0]?.body).toContain('https://made-up.example.com/page')
    expect(linkFindings(added, ['https://example.org/guide', 'https://made-up.example.com/page'])).toEqual([])
  })
})

/** A small .xlsx workbook: shared strings, an inline string, numbers, a skipped column and a skipped row. */
async function workbook(path: string): Promise<void> {
  const z = await ZipWriter.create(path)
  const add = (name: string, text: string): Promise<void> =>
    z.add({ name, data: Buffer.from(text, 'utf8'), mtime: new Date(2026, 0, 1) })
  await add(
    'xl/workbook.xml',
    '<workbook xmlns:r="r"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  await add(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  await add(
    'xl/sharedStrings.xml',
    '<sst><si><t>Month</t></si><si><t>Sales, total</t></si><si><r><t>Jan</t></r><r><t>uary</t></r></si><si><t>Tom &amp; "Jo"</t></si></sst>',
  )
  await add(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200.5</v></c><c r="D2" t="inlineStr"><is><t>note</t></is></c></row>' +
      '<row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4" t="b"><v>1</v></c></row>' +
      '</sheetData></worksheet>',
  )
  await z.finish('test')
}

describe('an Excel file becomes CSV when it is added', () => {
  it('reads the first sheet offline: shared and inline strings, numbers, gaps kept, quotes escaped', async () => {
    const p = join(temp(), 'sales.xlsx')
    await workbook(p)
    const r = xlsxToCsv(readFileSync(p))
    expect(r.rows).toBe(4)
    expect(r.cut).toBe(false)
    expect(r.csv).toBe('Month,"Sales, total",,\nJanuary,1200.5,,note\n,,,\n"Tom & ""Jo""",TRUE,,\n')
  })

  it('refuses what is not a workbook', () => {
    expect(() => xlsxToCsv(Buffer.from('not a zip'))).toThrow(/not a readable/)
  })
})

describe('a folder with unsaved files', () => {
  it('counts each changed or new file once (a rename once)', () => {
    expect(countStatus('')).toBe(0)
    expect(countStatus(' M index.html\0?? notes.txt\0R  new.css\0old.css\0')).toBe(3)
  })
})

describe('the first memory note', () => {
  it('starts with what the project is when the app knows it', () => {
    const seed = { conventions: ['What it is: a bakery page.'], decisions: ['It was asked for as: "x"'] }
    const text = withRunNote(null, '- note', seed)
    expect(text).toContain('## Conventions\n\n- What it is: a bakery page.')
    expect(text).toContain('## Decisions\n\n- It was asked for as: "x"')
    expect(text.trimEnd().endsWith('- note')).toBe(true)
    expect(memorySkeleton()).toContain('- (How this project is built')
  })
})

describe('the overnight list warnings', () => {
  it('a data report has no file, a game skips research, a guessed vague idea is said', () => {
    expect(queueWarnings({ idea: 'A report from my sales spreadsheet', kind: 'data' }, packs)).toEqual([
      { kind: 'exampleData' },
    ])
    expect(queueWarnings({ idea: 'A snake game', kind: 'game' }, packs)).toEqual([{ kind: 'noResearch' }])
    expect(queueWarnings({ idea: 'Something for my bakery', kind: 'app', guessed: true }, packs)).toEqual([
      { kind: 'vague', candidates: ['website', 'app'] },
    ])
    expect(queueWarnings({ idea: 'Something for my bakery', kind: 'app' }, packs)).toEqual([])
  })
})
