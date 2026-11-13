// `dimf new`'s arguments: its own flags (--template, --task, --no-run, --list-templates, --home) are read, everything
// else is `dimf run`'s and handed on in order (a value flag keeps its value, so a value is never taken for the folder);
// runArgv puts the created folder, the task and the template's recipe in front of them.
import { describe, expect, it } from 'vitest'
import { parseNewArgs, runArgv, templatesText } from '../../../src/cli/commands/new.ts'

describe('dimf new arguments', () => {
  it('reads its own flags and hands the rest to dimf run', () => {
    expect(
      parseNewArgs([
        'apps/hello',
        '--template',
        'vite-react',
        '--task=A tip calculator',
        '--profile',
        'balanced',
        '--auto',
        '--set',
        'review.model=opus',
        '--home',
        'h',
      ]),
    ).toEqual({
      folder: 'apps/hello',
      template: 'vite-react',
      task: 'A tip calculator',
      noRun: false,
      list: false,
      home: 'h',
      runArgs: ['--profile', 'balanced', '--auto', '--set', 'review.model=opus', '--home', 'h'],
    })
    expect(parseNewArgs(['--list-templates'])).toMatchObject({ list: true, runArgs: [] })
    expect(parseNewArgs(['x', '--template', 't', '--no-run'])).toMatchObject({ folder: 'x', noRun: true })
  })

  it('refuses a second folder and a flag without its value', () => {
    expect(() => parseNewArgs(['a', 'b', '--template', 't'])).toThrow('one folder only')
    expect(() => parseNewArgs(['a', '--template'])).toThrow('--template needs a value')
  })

  it("runArgv: the folder and the task first, then the template's recipe, then the run flags", () => {
    const created = {
      folder: '/p/hello',
      template: { id: 'vite-react', label: 'Vite' },
      brief: { category: 'software', fields: {} },
      task: 'Scaffold it.',
      recipe: 'new-web-app',
    }
    expect(runArgv(created, ['--auto'])).toEqual([
      '/p/hello',
      'Scaffold it.',
      '--recipe',
      'new-web-app',
      '--auto',
    ])
    // A recipe the user names wins over the template's.
    expect(runArgv(created, ['--recipe', 'bug-fix'])).toEqual([
      '/p/hello',
      'Scaffold it.',
      '--recipe',
      'bug-fix',
    ])
    expect(runArgv(created, ['--recipe=bug-fix'])).toEqual(['/p/hello', 'Scaffold it.', '--recipe=bug-fix'])
  })

  it('templatesText lists by category and names skipped files', () => {
    const lines = templatesText({
      packs: [{ id: 'software', label: 'Software' }],
      templates: [
        {
          layer: 'user',
          template: {
            id: 'mine',
            version: 1,
            pack: 'software',
            label: 'Mine',
            description: 'Ours.',
            brief: { fields: {} },
            task: 't',
            recipe: 'new-web-app',
          },
        },
      ],
      issues: [{ file: 'x.json', message: 'Not valid JSON' }],
    })
    expect(lines).toEqual([
      'Software:',
      `  ${'mine'.padEnd(16)} Mine: Ours. (yours)`,
      'Skipped x.json: Not valid JSON',
    ])
  })
})
