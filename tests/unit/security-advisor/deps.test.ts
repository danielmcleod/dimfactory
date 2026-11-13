// The security advisor's lockfile reading: which paths are lockfiles, every supported format parsed from a small
// realistic sample (npm v1 and v2/v3, pnpm v5/v6/v9, yarn classic and Yarn 2+, requirements.txt, poetry.lock,
// uv.lock, Pipfile.lock, Cargo.lock, go.sum, go.mod), pip name normalization, unreadable text as null, and the
// added-or-changed diff between two parses.
import { describe, expect, it } from 'vitest'
import type { DepVersions } from '@core/security/deps.ts'
import { changedDependencies, lockfileInfo, normalizeDepName, parseLockfile } from '@core/security/deps.ts'

/** A parse as a plain object of sorted versions, for readable expectations. */
function plain(deps: DepVersions | null): Record<string, string[]> | null {
  if (deps === null) return null
  return Object.fromEntries([...deps].map(([name, versions]) => [name, [...versions].sort()]))
}

const deps = (o: Record<string, string[]>): DepVersions =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]))

describe('lockfileInfo', () => {
  it.each([
    ['package-lock.json', 'npm', 'package-lock'],
    ['sub/npm-shrinkwrap.json', 'npm', 'package-lock'],
    ['pnpm-lock.yaml', 'npm', 'pnpm-lock'],
    ['yarn.lock', 'npm', 'yarn-lock'],
    ['requirements.txt', 'pip', 'requirements'],
    ['requirements-dev.txt', 'pip', 'requirements'],
    ['requirements/base.txt', 'pip', 'requirements'],
    ['poetry.lock', 'pip', 'poetry-lock'],
    ['uv.lock', 'pip', 'uv-lock'],
    ['Pipfile.lock', 'pip', 'pipfile-lock'],
    ['Cargo.lock', 'cargo', 'cargo-lock'],
    ['go.sum', 'go', 'go-sum'],
    ['a\\b\\go.mod', 'go', 'go-mod'],
  ])('%s is %s/%s', (path, ecosystem, kind) => {
    expect(lockfileInfo(path)).toEqual({ ecosystem, kind })
  })

  it.each(['package.json', 'cargo.lock', 'Pipfile', 'pyproject.toml', 'notes/requirements.md', 'reqs.txt'])(
    '%s is not a lockfile',
    (path) => {
      expect(lockfileInfo(path)).toBeNull()
    },
  )
})

describe('normalizeDepName', () => {
  it('folds pip names per PEP 503 and leaves the others alone', () => {
    expect(normalizeDepName('pip', 'Django_REST.framework')).toBe('django-rest-framework')
    expect(normalizeDepName('pip', 'zope..interface')).toBe('zope-interface')
    expect(normalizeDepName('npm', '@Scope/Name_x')).toBe('@Scope/Name_x')
    expect(normalizeDepName('cargo', 'serde_json')).toBe('serde_json')
    expect(normalizeDepName('go', 'github.com/Foo/Bar')).toBe('github.com/Foo/Bar')
  })
})

describe('parseLockfile: npm', () => {
  it('reads package-lock v1 nested dependencies', () => {
    const text = JSON.stringify({
      name: 'app',
      lockfileVersion: 1,
      dependencies: {
        mkdirp: { version: '0.5.1', dependencies: { minimist: { version: '0.0.8' } } },
        minimist: { version: '1.2.0' },
      },
    })
    expect(plain(parseLockfile('package-lock.json', text))).toEqual({
      mkdirp: ['0.5.1'],
      minimist: ['0.0.8', '1.2.0'],
    })
  })

  it('reads package-lock v2/v3 packages: last node_modules segment, root and links skipped, aliases by name', () => {
    const text = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/@babel/core': { version: '7.22.5' },
        'node_modules/a/node_modules/lodash': { version: '4.17.20' },
        'node_modules/@scope/b/node_modules/@babel/core': { version: '7.0.0' },
        'node_modules/local-lib': { resolved: 'packages/local-lib', link: true },
        'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' },
        'packages/local-lib': { name: 'local-lib', version: '0.1.0' },
      },
    })
    expect(plain(parseLockfile('package-lock.json', text))).toEqual({
      lodash: ['4.17.20', '4.17.21'],
      '@babel/core': ['7.0.0', '7.22.5'],
      'string-width': ['4.2.3'],
    })
  })

  it('returns null for text that is not a package-lock', () => {
    expect(parseLockfile('package-lock.json', '{ not json')).toBeNull()
    expect(parseLockfile('package-lock.json', '[1,2]')).toBeNull()
    expect(parseLockfile('package-lock.json', '{"name":"x"}')).toBeNull()
  })

  it('reads pnpm-lock v5 keys', () => {
    const text = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  lodash: ^4.17.21',
      '',
      'dependencies:',
      '  lodash: 4.17.21',
      '',
      'packages:',
      '',
      '  /lodash/4.17.21:',
      '    resolution: {integrity: sha512-x}',
      '    dev: false',
      '',
      '  /@babel/core/7.12.3:',
      '    resolution: {integrity: sha512-y}',
      '',
      '  /react-dom/18.2.0_react@18.2.0:',
      '    resolution: {integrity: sha512-z}',
    ].join('\n')
    expect(plain(parseLockfile('pnpm-lock.yaml', text))).toEqual({
      lodash: ['4.17.21'],
      '@babel/core': ['7.12.3'],
      'react-dom': ['18.2.0'],
    })
  })

  it('reads pnpm-lock v6 keys, scoped and with peer suffixes', () => {
    const text = [
      "lockfileVersion: '6.0'",
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        specifier: ^4.17.21',
      '        version: 4.17.21',
      '',
      'packages:',
      '',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: sha512-x}',
      '',
      '  /@babel/core@7.22.5:',
      '    resolution: {integrity: sha512-y}',
      '',
      "  '/@testing-library/react@14.0.0(react-dom@18.2.0)(react@18.2.0)':",
      '    resolution: {integrity: sha512-z}',
    ].join('\n')
    expect(plain(parseLockfile('pnpm-lock.yaml', text))).toEqual({
      lodash: ['4.17.21'],
      '@babel/core': ['7.22.5'],
      '@testing-library/react': ['14.0.0'],
    })
  })

  it('reads pnpm-lock v9 packages and snapshots', () => {
    const text = [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '',
      'packages:',
      '',
      '  lodash@4.17.21:',
      '    resolution: {integrity: sha512-x}',
      '',
      "  '@types/node@20.11.0':",
      '    resolution: {integrity: sha512-y}',
      '',
      '  react@18.2.0:',
      '    resolution: {integrity: sha512-z}',
      '',
      'snapshots:',
      '',
      '  lodash@4.17.21: {}',
      '',
      "  '@testing-library/react@14.0.0(react-dom@18.2.0(react@18.2.0))(react@18.2.0)':",
      '    dependencies:',
      '      react: 18.2.0',
    ].join('\n')
    expect(plain(parseLockfile('pnpm-lock.yaml', text))).toEqual({
      lodash: ['4.17.21'],
      '@types/node': ['20.11.0'],
      react: ['18.2.0'],
      '@testing-library/react': ['14.0.0'],
    })
  })

  it('returns null for a pnpm-lock with no lockfileVersion', () => {
    expect(parseLockfile('pnpm-lock.yaml', 'hello: world\n')).toBeNull()
  })

  it('reads yarn.lock classic', () => {
    const text = [
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
      '# yarn lockfile v1',
      '',
      '',
      '"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":',
      '  version "7.12.13"',
      '  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#abc"',
      '  dependencies:',
      '    "@babel/highlight" "^7.12.13"',
      '',
      'lodash@^4.17.15, lodash@^4.17.20:',
      '  version "4.17.21"',
      '',
      'lodash@^3.0.0:',
      '  version "3.10.1"',
    ].join('\n')
    expect(plain(parseLockfile('yarn.lock', text))).toEqual({
      '@babel/code-frame': ['7.12.13'],
      lodash: ['3.10.1', '4.17.21'],
    })
  })

  it('reads yarn.lock berry (Yarn 2+), skipping the metadata and workspaces', () => {
    const text = [
      '# This file is generated by running "yarn install" inside your project.',
      '',
      '__metadata:',
      '  version: 6',
      '  cacheKey: 8',
      '',
      '"@types/node@npm:*, @types/node@npm:^20.0.0":',
      '  version: 20.11.0',
      '  resolution: "@types/node@npm:20.11.0"',
      '  languageName: node',
      '',
      '"lodash@npm:^4.17.21":',
      '  version: 4.17.21',
      '  resolution: "lodash@npm:4.17.21"',
      '',
      '"my-app@workspace:.":',
      '  version: 0.0.0-use.local',
      '  resolution: "my-app@workspace:."',
    ].join('\n')
    expect(plain(parseLockfile('yarn.lock', text))).toEqual({
      '@types/node': ['20.11.0'],
      lodash: ['4.17.21'],
    })
  })
})

describe('parseLockfile: pip', () => {
  it('reads requirements.txt: pins, extras, markers, hashes, unpinned as *, options and comments ignored', () => {
    const text = [
      '# production dependencies',
      '-r base.txt',
      '--index-url https://pypi.example.invalid/simple',
      'Django==4.2.1  # pinned',
      'requests[socks,security]==2.31.0 ; python_version >= "3.8"',
      'Flask>=2.0',
      'urllib3==2.0.7 \\',
      '    --hash=sha256:abc',
      'black==23.*',
      'numpy',
      'mylib @ https://example.invalid/mylib-1.0.tar.gz',
      'git+https://example.invalid/repo.git#egg=other',
      '-e ./local',
    ].join('\n')
    expect(plain(parseLockfile('requirements.txt', text))).toEqual({
      django: ['4.2.1'],
      requests: ['2.31.0'],
      flask: ['*'],
      urllib3: ['2.0.7'],
      black: ['*'],
      numpy: ['*'],
      mylib: ['*'],
    })
    expect(plain(parseLockfile('requirements-dev.txt', 'pytest==7.4.0\n'))).toEqual({ pytest: ['7.4.0'] })
  })

  it('reads poetry.lock [[package]] blocks, not their sub-tables', () => {
    const text = [
      '# This file is automatically @generated by Poetry 1.7.1 and should not be changed by hand.',
      '',
      '[[package]]',
      'name = "Certifi"',
      'version = "2023.7.22"',
      'description = "Python package for providing Mozilla\'s CA Bundle."',
      'optional = false',
      'python-versions = ">=3.6"',
      'files = [',
      '    {file = "certifi-2023.7.22-py3-none-any.whl", hash = "sha256:abc"},',
      ']',
      '',
      '[[package]]',
      'name = "requests"',
      'version = "2.31.0"',
      '',
      '[package.dependencies]',
      'certifi = ">=2017.4.17"',
      '',
      '[package.extras]',
      'socks = ["PySocks (>=1.5.6,!=1.5.7)"]',
      '',
      '[metadata]',
      'lock-version = "2.0"',
      'python-versions = "^3.11"',
      'content-hash = "abc"',
    ].join('\n')
    expect(plain(parseLockfile('poetry.lock', text))).toEqual({
      certifi: ['2023.7.22'],
      requests: ['2.31.0'],
    })
  })

  it('reads uv.lock, skipping the editable project itself', () => {
    const text = [
      'version = 1',
      'requires-python = ">=3.11"',
      '',
      '[[package]]',
      'name = "my-app"',
      'version = "0.1.0"',
      'source = { editable = "." }',
      'dependencies = [',
      '    { name = "requests" },',
      ']',
      '',
      '[package.metadata]',
      'requires-dist = [{ name = "requests", specifier = ">=2.31" }]',
      '',
      '[[package]]',
      'name = "requests"',
      'version = "2.31.0"',
      'source = { registry = "https://pypi.org/simple" }',
      'dependencies = [',
      '    { name = "charset-normalizer" },',
      ']',
      '',
      '[[package]]',
      'name = "charset_normalizer"',
      'version = "3.3.2"',
      'source = { registry = "https://pypi.org/simple" }',
    ].join('\n')
    expect(plain(parseLockfile('uv.lock', text))).toEqual({
      requests: ['2.31.0'],
      'charset-normalizer': ['3.3.2'],
    })
  })

  it('reads Pipfile.lock default and develop', () => {
    const text = JSON.stringify({
      _meta: {
        hash: { sha256: 'abc' },
        'pipfile-spec': 6,
        requires: { python_version: '3.11' },
        sources: [],
      },
      default: {
        requests: { hashes: ['sha256:abc'], index: 'pypi', version: '==2.31.0' },
        Some_Lib: { git: 'https://example.invalid/some-lib.git', ref: 'abc' },
      },
      develop: { pytest: { version: '==7.4.0' } },
    })
    expect(plain(parseLockfile('Pipfile.lock', text))).toEqual({
      requests: ['2.31.0'],
      'some-lib': ['*'],
      pytest: ['7.4.0'],
    })
    expect(parseLockfile('Pipfile.lock', '{"x":1}')).toBeNull()
  })
})

describe('parseLockfile: cargo and go', () => {
  it('reads Cargo.lock', () => {
    const text = [
      '# This file is automatically @generated by Cargo.',
      '# It is not intended for manual editing.',
      'version = 3',
      '',
      '[[package]]',
      'name = "my-crate"',
      'version = "0.1.0"',
      'dependencies = [',
      ' "serde",',
      ']',
      '',
      '[[package]]',
      'name = "serde"',
      'version = "1.0.193"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'checksum = "abc"',
      '',
      '[[package]]',
      'name = "syn"',
      'version = "1.0.109"',
      '',
      '[[package]]',
      'name = "syn"',
      'version = "2.0.39"',
    ].join('\n')
    expect(plain(parseLockfile('Cargo.lock', text))).toEqual({
      'my-crate': ['0.1.0'],
      serde: ['1.0.193'],
      syn: ['1.0.109', '2.0.39'],
    })
    expect(parseLockfile('Cargo.lock', 'this is not toml at all\n')).toBeNull()
  })

  it('reads go.sum, dropping /go.mod and keeping the v prefix', () => {
    const text = [
      'golang.org/x/crypto v0.14.0 h1:abc=',
      'golang.org/x/crypto v0.14.0/go.mod h1:def=',
      'golang.org/x/net v0.17.0/go.mod h1:ghi=',
      'github.com/pkg/errors v0.9.1 h1:jkl=',
    ].join('\n')
    expect(plain(parseLockfile('go.sum', text))).toEqual({
      'golang.org/x/crypto': ['v0.14.0'],
      'golang.org/x/net': ['v0.17.0'],
      'github.com/pkg/errors': ['v0.9.1'],
    })
    expect(parseLockfile('go.sum', 'garbage line\n')).toBeNull()
  })

  it('reads go.mod require lines and blocks', () => {
    const text = [
      'module example.com/app',
      '',
      'go 1.22',
      '',
      'require github.com/pkg/errors v0.9.1',
      '',
      'require (',
      '\tgolang.org/x/crypto v0.14.0',
      '\tgolang.org/x/net v0.17.0 // indirect',
      ')',
      '',
      'replace golang.org/x/net => golang.org/x/net v0.18.0',
    ].join('\n')
    expect(plain(parseLockfile('go.mod', text))).toEqual({
      'github.com/pkg/errors': ['v0.9.1'],
      'golang.org/x/crypto': ['v0.14.0'],
      'golang.org/x/net': ['v0.17.0'],
    })
    expect(parseLockfile('go.mod', 'require x v1\n')).toBeNull()
  })

  it('ignores a byte order mark', () => {
    const bom = String.fromCharCode(0xfeff)
    expect(plain(parseLockfile('requirements.txt', `${bom}six==1.16.0\n`))).toEqual({ six: ['1.16.0'] })
    expect(plain(parseLockfile('Pipfile.lock', `${bom}{"default":{"six":{"version":"==1.16.0"}}}`))).toEqual({
      six: ['1.16.0'],
    })
  })

  it('returns null for an unknown file name', () => {
    expect(parseLockfile('README.md', 'lodash==1')).toBeNull()
  })
})

describe('changedDependencies', () => {
  const before = deps({ lodash: ['4.17.20'], react: ['18.2.0'], left: ['1.0.0'], multi: ['1.0.0', '2.0.0'] })

  it('reports added and bumped names, not unchanged or removed-only ones, sorted by name', () => {
    const after = deps({
      lodash: ['4.17.21'],
      react: ['18.2.0'],
      zod: ['3.22.4'],
      axios: ['1.6.0'],
      multi: ['1.0.0'],
    })
    expect(changedDependencies(before, after)).toEqual([
      { name: 'axios', from: [], to: ['1.6.0'] },
      { name: 'lodash', from: ['4.17.20'], to: ['4.17.21'] },
      { name: 'zod', from: [], to: ['3.22.4'] },
    ])
  })

  it('reports a name that gained a second version', () => {
    const after = deps({ lodash: ['4.17.20', '4.17.21'], react: ['18.2.0'] })
    expect(changedDependencies(before, after)).toEqual([
      { name: 'lodash', from: ['4.17.20'], to: ['4.17.20', '4.17.21'] },
    ])
  })

  it('sorts versions numerically', () => {
    const after = deps({ multi: ['10.0.0', '9.0.0', '1.0.0'] })
    expect(changedDependencies(before, after)[0]?.to).toEqual(['1.0.0', '9.0.0', '10.0.0'])
  })

  it('treats everything as added with no before', () => {
    expect(changedDependencies(null, deps({ b: ['2'], a: ['1'] }))).toEqual([
      { name: 'a', from: [], to: ['1'] },
      { name: 'b', from: [], to: ['2'] },
    ])
  })

  it('is empty when nothing changed', () => {
    expect(changedDependencies(before, before)).toEqual([])
  })
})
