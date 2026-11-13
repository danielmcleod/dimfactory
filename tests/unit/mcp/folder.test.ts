// The folder an outside agent names (request_run, get_estimate): absolute only, and on Windows a local drive path,
// refused before anything touches the disk when it is a UNC path (Windows would connect to that host and offer it the
// user's sign-in), a device path or an alternate data stream.
import { describe, expect, it } from 'vitest'
import { normalizeAgentFolder } from '../../../src/core/mcp/tools.ts'

const refused = (folder: string, platform: NodeJS.Platform): string => {
  try {
    normalizeAgentFolder(folder, platform)
  } catch (err) {
    return (err as { code?: string }).code ?? 'THROWN'
  }
  return 'accepted'
}

describe('normalizeAgentFolder', () => {
  it('Windows: a local drive path, resolved', () => {
    expect(normalizeAgentFolder('C:\\code\\app', 'win32')).toBe('C:\\code\\app')
    expect(normalizeAgentFolder('C:/code/app/', 'win32')).toBe('C:\\code\\app')
    expect(normalizeAgentFolder('d:\\code\\..\\app', 'win32')).toBe('d:\\app')
  })

  it.each([
    ['a UNC share', '\\\\attacker.example\\share\\x'],
    ['a UNC share with slashes', '//attacker.example/share/x'],
    ['an administrative share', '\\\\127.0.0.1\\C$\\Windows'],
    ['a device path', '\\\\?\\C:\\Windows'],
    ['a device UNC path', '\\\\?\\UNC\\attacker.example\\share'],
    ['the device namespace', '\\\\.\\C:\\Windows'],
    ['an alternate data stream', 'C:\\code\\app:evil'],
    ['a folder index stream', 'C:\\Windows::$INDEX_ALLOCATION'],
    ['a relative path', 'code\\app'],
    ['a drive-relative path', 'C:code\\app'],
    ['a rooted path with no drive', '\\code\\app'],
    ['a NUL', 'C:\\code\\a\u0000b'],
  ])('Windows refuses %s', (_what, folder) => {
    expect(refused(folder, 'win32')).toBe('VALIDATION')
  })

  it('POSIX: an absolute path, resolved; a relative one or a NUL refused', () => {
    expect(normalizeAgentFolder('/home/me/app/../web', 'linux')).toBe('/home/me/web')
    expect(normalizeAgentFolder('/Users/me/app', 'darwin')).toBe('/Users/me/app')
    expect(refused('app', 'linux')).toBe('VALIDATION')
    expect(refused('/home/me/a\u0000b', 'linux')).toBe('VALIDATION')
  })
})
