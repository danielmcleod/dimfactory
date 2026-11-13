// Deps detection corpus (isolated run deps detection): one fixture folder per row
// of the detection table, package.json#packageManager winning over the lockfile's kind (corepack for pnpm/yarn), yarn 1
// versus berry, the search from the folder up to the scope root, the table's order within a folder, and
// installCommand replacing detection (decideDeps, planFromCommand).
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decideDeps,
  detectDeps,
  planCommands,
  planFromCommand,
} from '../../../../src/core/prepare/detectDeps.ts'
import type { DepsPlan } from '../../../../src/core/prepare/detectDeps.ts'
import { removeDir, tempDir, writeFiles } from '../../verify/helpers.ts'
import type { Files } from '../../verify/helpers.ts'

let root = ''
beforeEach(() => {
  root = tempDir('dim-factory-deps-')
})
afterEach(() => removeDir(root))

const pkgJson = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ name: 'fixture', version: '1.0.0', ...extra }, null, 2)}\n`

async function detect(
  files: Files,
  o: { sub?: string; platform?: NodeJS.Platform } = {},
): Promise<DepsPlan | null> {
  writeFiles(root, files)
  const folder = o.sub !== undefined ? join(root, o.sub) : root
  return detectDeps(folder, { scopeRoot: root, platform: o.platform ?? 'linux' })
}

describe('detectDeps: the detection table, one row each', () => {
  const rows: {
    name: string
    files: Files
    argv: string[]
    manager: DepsPlan['manager']
    lockfile: string | null
    sources: string[]
  }[] = [
    {
      name: 'pnpm-lock',
      files: { 'package.json': pkgJson(), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      manager: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      sources: ['pnpm-lock.yaml', 'package.json'],
    },
    {
      name: 'package-lock',
      files: { 'package.json': pkgJson(), 'package-lock.json': '{"lockfileVersion":3}\n' },
      argv: ['npm', 'ci'],
      manager: 'npm',
      lockfile: 'package-lock.json',
      sources: ['package-lock.json', 'package.json'],
    },
    {
      name: 'npm-shrinkwrap',
      files: { 'package.json': pkgJson(), 'npm-shrinkwrap.json': '{"lockfileVersion":3}\n' },
      argv: ['npm', 'ci'],
      manager: 'npm',
      lockfile: 'npm-shrinkwrap.json',
      sources: ['npm-shrinkwrap.json', 'package.json'],
    },
    {
      name: 'yarn.lock (v1)',
      files: { 'package.json': pkgJson(), 'yarn.lock': '# yarn lockfile v1\n\n' },
      argv: ['yarn', 'install', '--frozen-lockfile'],
      manager: 'yarn',
      lockfile: 'yarn.lock',
      sources: ['yarn.lock', 'package.json'],
    },
    {
      name: 'yarn.lock (berry)',
      files: { 'package.json': pkgJson(), 'yarn.lock': '__metadata:\n  version: 8\n' },
      argv: ['yarn', 'install', '--immutable'],
      manager: 'yarn',
      lockfile: 'yarn.lock',
      sources: ['yarn.lock', 'package.json'],
    },
    {
      name: 'bun.lock',
      files: { 'package.json': pkgJson(), 'bun.lock': '{}\n' },
      argv: ['bun', 'install', '--frozen-lockfile'],
      manager: 'bun',
      lockfile: 'bun.lock',
      sources: ['bun.lock', 'package.json'],
    },
    {
      name: 'bun.lockb',
      files: { 'package.json': pkgJson(), 'bun.lockb': '\u0000bin' },
      argv: ['bun', 'install', '--frozen-lockfile'],
      manager: 'bun',
      lockfile: 'bun.lockb',
      sources: ['bun.lockb', 'package.json'],
    },
    {
      name: 'uv.lock',
      files: { 'pyproject.toml': '[project]\nname="x"\n', 'uv.lock': 'version = 1\n' },
      argv: ['uv', 'sync', '--frozen'],
      manager: 'uv',
      lockfile: 'uv.lock',
      sources: ['uv.lock', 'pyproject.toml'],
    },
    {
      name: 'poetry.lock',
      files: { 'pyproject.toml': '[tool.poetry]\n', 'poetry.lock': '# poetry\n' },
      argv: ['poetry', 'install', '--no-interaction'],
      manager: 'poetry',
      lockfile: 'poetry.lock',
      sources: ['poetry.lock', 'pyproject.toml'],
    },
    {
      name: 'Pipfile.lock',
      files: { Pipfile: '[packages]\n', 'Pipfile.lock': '{}\n' },
      argv: ['pipenv', 'sync'],
      manager: 'pipenv',
      lockfile: 'Pipfile.lock',
      sources: ['Pipfile.lock', 'Pipfile'],
    },
    {
      name: 'Cargo.lock',
      files: { 'Cargo.toml': '[package]\n', 'Cargo.lock': 'version = 3\n' },
      argv: ['cargo', 'fetch', '--locked'],
      manager: 'cargo',
      lockfile: 'Cargo.lock',
      sources: ['Cargo.lock', 'Cargo.toml'],
    },
    {
      name: 'go.sum',
      files: { 'go.mod': 'module x\n', 'go.sum': 'x v1 h1:abc\n' },
      argv: ['go', 'mod', 'download'],
      manager: 'go',
      lockfile: 'go.sum',
      sources: ['go.sum', 'go.mod'],
    },
    {
      name: 'dotnet',
      files: { 'App.csproj': '<Project />\n', 'App.sln': '\n' },
      argv: ['dotnet', 'restore'],
      manager: 'dotnet',
      lockfile: null,
      sources: ['App.csproj', 'App.sln'],
    },
    {
      name: 'dotnet with packages.lock.json',
      files: { 'App.csproj': '<Project />\n', 'packages.lock.json': '{}\n', 'global.json': '{}\n' },
      argv: ['dotnet', 'restore'],
      manager: 'dotnet',
      lockfile: 'packages.lock.json',
      sources: ['App.csproj', 'packages.lock.json', 'global.json'],
    },
    {
      name: 'maven',
      files: { 'pom.xml': '<project />\n' },
      argv: ['mvn', '-B', '-q', 'dependency:resolve'],
      manager: 'maven',
      lockfile: null,
      sources: ['pom.xml'],
    },
    {
      name: 'maven with the wrapper',
      files: {
        'pom.xml': '<project />\n',
        mvnw: '#!/bin/sh\n',
        'mvnw.cmd': '@echo off\n',
        '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=x\n',
      },
      argv: ['./mvnw', '-B', '-q', 'dependency:resolve'],
      manager: 'maven',
      lockfile: null,
      sources: ['pom.xml', 'mvnw', 'mvnw.cmd', '.mvn/wrapper/maven-wrapper.properties'],
    },
    {
      name: 'gradle',
      files: { 'build.gradle.kts': 'plugins {}\n', 'settings.gradle.kts': '\n' },
      argv: ['gradle', '--no-daemon', 'dependencies'],
      manager: 'gradle',
      lockfile: null,
      sources: ['settings.gradle.kts', 'build.gradle.kts'],
    },
    {
      name: 'gradle with the wrapper and a lockfile',
      files: {
        'build.gradle': '\n',
        'gradle.lockfile': 'x=1\n',
        'gradlew.bat': '@echo off\n',
        'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=x\n',
      },
      argv: ['./gradlew', '--no-daemon', 'dependencies'],
      manager: 'gradle',
      lockfile: 'gradle.lockfile',
      sources: ['build.gradle', 'gradle.lockfile', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.properties'],
    },
  ]
  for (const row of rows) {
    it(row.name, async () => {
      const plan = await detect(row.files)
      expect(plan).toMatchObject({
        manager: row.manager,
        argv: row.argv,
        cwdRel: '.',
        lockfile: row.lockfile,
        sources: row.sources,
        tools: [row.argv[0]],
      })
      expect(plan?.setup).toBeUndefined()
    })
  }

  it('requirements.txt: a virtual environment first, then pip through its python (per OS)', async () => {
    const files = { 'requirements.txt': 'requests==2.32.0\n' }
    const win = await detect(files, { platform: 'win32' })
    expect(win).toMatchObject({
      manager: 'pip',
      setup: [['py', '-3', '-m', 'venv', '.venv']],
      argv: ['.venv/Scripts/python', '-m', 'pip', 'install', '-r', 'requirements.txt'],
      lockfile: 'requirements.txt',
      sources: ['requirements.txt'],
      tools: ['py'],
    })
    const posix = await detectDeps(root, { platform: 'linux' })
    expect(posix).toMatchObject({
      setup: [['python3', '-m', 'venv', '.venv']],
      argv: ['.venv/bin/python', '-m', 'pip', 'install', '-r', 'requirements.txt'],
      tools: ['python3'],
    })
    expect(planCommands(posix ?? { argv: [] })).toEqual([
      ['python3', '-m', 'venv', '.venv'],
      ['.venv/bin/python', '-m', 'pip', 'install', '-r', 'requirements.txt'],
    ])
  })

  it('nothing it installs from → null (a manifest alone is not a signal)', async () => {
    expect(await detect({ 'README.md': '# x\n' })).toBeNull()
    expect(await detect({ 'package.json': pkgJson() })).toBeNull()
    expect(await detect({ 'go.mod': 'module x\n', 'Cargo.toml': '[package]\n' })).toBeNull()
  })
})

describe('detectDeps: package.json#packageManager wins', () => {
  it('its own lockfile: frozen, and corepack may run pnpm', async () => {
    const plan = await detect({
      'package.json': pkgJson({ packageManager: 'pnpm@10.28.0' }),
      'pnpm-lock.yaml': '\n',
    })
    expect(plan).toMatchObject({
      manager: 'pnpm',
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      via: 'packageManager',
      corepack: true,
    })
  })

  it('another manager’s lockfile: the named manager installs without the frozen flag, with a note', async () => {
    const plan = await detect({
      'package.json': pkgJson({ packageManager: 'pnpm@10.28.0' }),
      'package-lock.json': '{}\n',
    })
    expect(plan).toMatchObject({ manager: 'pnpm', argv: ['pnpm', 'install'], lockfile: null, corepack: true })
    expect(plan?.sources).toEqual(['package.json'])
    expect(plan?.note).toContain('package-lock.json')
  })

  it('npm named over a pnpm lockfile: npm install', async () => {
    const plan = await detect({
      'package.json': pkgJson({ packageManager: 'npm@10.9.0' }),
      'pnpm-lock.yaml': '\n',
    })
    expect(plan).toMatchObject({ manager: 'npm', argv: ['npm', 'install'], via: 'packageManager' })
    expect(plan?.corepack).toBeUndefined()
  })

  it('the field alone (no lockfile anywhere) installs where it is set', async () => {
    const plan = await detect({ 'package.json': pkgJson({ packageManager: 'yarn@1.22.22' }) })
    expect(plan).toMatchObject({ manager: 'yarn', argv: ['yarn', 'install'], lockfile: null, corepack: true })
  })

  it('yarn’s version comes from the field: yarn@4 is berry even with a v1 header', async () => {
    const plan = await detect({
      'package.json': pkgJson({ packageManager: 'yarn@4.5.0' }),
      'yarn.lock': '# yarn lockfile v1\n',
    })
    expect(plan?.argv).toEqual(['yarn', 'install', '--immutable'])
    const v1 = await detect({
      'package.json': pkgJson({ packageManager: 'yarn@1.22.22' }),
      'yarn.lock': '__metadata:\n  version: 8\n',
    })
    expect(v1?.argv).toEqual(['yarn', 'install', '--frozen-lockfile'])
  })

  it('.yarnrc.yml marks berry when the lockfile does not say', async () => {
    const plan = await detect({
      'package.json': pkgJson(),
      'yarn.lock': '\n',
      '.yarnrc.yml': 'nodeLinker: pnp\n',
    })
    expect(plan?.argv).toEqual(['yarn', 'install', '--immutable'])
  })
})

describe('detectDeps: where it looks', () => {
  it('a package folder of a workspace installs at the root, where the lockfile is', async () => {
    const plan = await detect(
      {
        'package.json': pkgJson({ packageManager: 'pnpm@10.28.0' }),
        'pnpm-lock.yaml': '\n',
        'packages/app/package.json': pkgJson(),
      },
      { sub: 'packages/app' },
    )
    expect(plan).toMatchObject({ manager: 'pnpm', cwdRel: '.', lockfile: 'pnpm-lock.yaml', corepack: true })
  })

  it('the nearest folder with a signal wins, with its paths relative to the scope root', async () => {
    const plan = await detect(
      {
        'pnpm-lock.yaml': '\n',
        'package.json': pkgJson(),
        'tools/py/uv.lock': '\n',
        'tools/py/pyproject.toml': '\n',
      },
      { sub: 'tools/py' },
    )
    expect(plan).toMatchObject({
      manager: 'uv',
      cwdRel: 'tools/py',
      lockfile: 'tools/py/uv.lock',
      sources: ['tools/py/uv.lock', 'tools/py/pyproject.toml'],
    })
  })

  it('a field set in a package folder without a lockfile defers to that manager’s lockfile above', async () => {
    const plan = await detect(
      {
        'pnpm-lock.yaml': '\n',
        'package.json': pkgJson(),
        'packages/app/package.json': pkgJson({ packageManager: 'pnpm@10.0.0' }),
      },
      { sub: 'packages/app' },
    )
    expect(plan).toMatchObject({ cwdRel: '.', argv: ['pnpm', 'install', '--frozen-lockfile'] })
  })

  it('the table’s order within a folder: JavaScript lockfiles first, pnpm before npm, uv before pip', async () => {
    expect(
      (await detect({ 'package.json': pkgJson(), 'pnpm-lock.yaml': '\n', 'package-lock.json': '{}' }))
        ?.manager,
    ).toBe('pnpm')
    removeDir(root)
    root = tempDir('dim-factory-deps-')
    expect((await detect({ 'package-lock.json': '{}', 'requirements.txt': 'x\n' }))?.manager).toBe('npm')
    removeDir(root)
    root = tempDir('dim-factory-deps-')
    expect((await detect({ 'uv.lock': '\n', 'requirements.txt': 'x\n' }))?.manager).toBe('uv')
  })

  it('never looks above the scope root', async () => {
    writeFiles(root, { 'pnpm-lock.yaml': '\n', 'inner/README.md': '\n' })
    expect(await detectDeps(join(root, 'inner'), { scopeRoot: join(root, 'inner') })).toBeNull()
  })
})

describe('installCommand replaces detection', () => {
  it('planFromCommand: argv from a line, run where detection would install, covering its files', async () => {
    writeFiles(root, { 'package.json': pkgJson(), 'pnpm-lock.yaml': '\n' })
    const r = await planFromCommand('pnpm install --prefer-offline', root, { scopeRoot: root })
    expect(r.plan).toMatchObject({
      manager: 'custom',
      argv: ['pnpm', 'install', '--prefer-offline'],
      cwdRel: '.',
      lockfile: 'pnpm-lock.yaml',
      sources: ['pnpm-lock.yaml', 'package.json'],
      via: 'config',
      tools: ['pnpm'],
    })
    const list = await planFromCommand(['node', 'scripts/setup.mjs'], root, { scopeRoot: root })
    expect(list.plan?.argv).toEqual(['node', 'scripts/setup.mjs'])
  })

  it('shell syntax is refused as an install command (never sh -c)', async () => {
    const r = await planFromCommand('npm ci && npm run build', root)
    expect(r.plan).toBeNull()
    expect(r.error).toMatch(/install command|package script|shell/i)
    expect(r.error).not.toMatch(/verify command/)
  })

  it('decideDeps: never, none, invalid, and the command over detection', async () => {
    writeFiles(root, { 'package.json': pkgJson(), 'package-lock.json': '{}\n' })
    expect(await decideDeps({ install: 'never', installCommand: 'npm ci' }, root)).toEqual({ kind: 'never' })
    expect(await decideDeps({ install: 'ask', installCommand: 'a | b' }, root)).toMatchObject({
      kind: 'invalid',
    })
    const cmd = await decideDeps({ install: 'auto', installCommand: ['npm', 'install'] }, root)
    expect(cmd).toMatchObject({ kind: 'plan', plan: { manager: 'custom', argv: ['npm', 'install'] } })
    const detected = await decideDeps({ install: 'ask', installCommand: null }, root)
    expect(detected).toMatchObject({ kind: 'plan', plan: { manager: 'npm', argv: ['npm', 'ci'] } })
    const empty = tempDir('dim-factory-deps-empty-')
    try {
      expect(await decideDeps({ install: 'ask', installCommand: null }, empty)).toEqual({ kind: 'none' })
    } finally {
      removeDir(empty)
    }
  })
})
