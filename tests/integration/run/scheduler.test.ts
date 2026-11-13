// Folder-lock scheduler: FIFO inside a conflict set, ancestor/descendant conflicts,
// unrelated folders in parallel, holders restored at relaunch.
import { describe, expect, it } from 'vitest'
import { FolderScheduler } from '../../../src/core/supervisor/scheduler.ts'

const posix = (): FolderScheduler => new FolderScheduler({ platform: 'linux', now: () => 1 })

describe('FolderScheduler', () => {
  it('grants a free folder at once and queues conflicting runs FIFO', () => {
    const s = posix()
    const granted: string[] = []
    expect(s.request('a', '/w/repo', () => granted.push('a'))).toBe('granted')
    expect(s.request('b', '/w/repo', () => granted.push('b'))).toBe('queued')
    expect(s.request('c', '/w/repo', () => granted.push('c'))).toBe('queued')
    expect(granted).toEqual(['a'])
    expect(s.blockedBy('b')).toMatchObject({ runId: 'a', state: 'holder' })
    expect(s.blockedBy('c')).toMatchObject({ runId: 'a', state: 'holder' })
    s.release('a')
    expect(granted).toEqual(['a', 'b'])
    expect(s.blockedBy('c')).toMatchObject({ runId: 'b' })
    s.release('b')
    expect(granted).toEqual(['a', 'b', 'c'])
  })

  it('treats ancestors and descendants as conflicts and unrelated folders as parallel', () => {
    const s = posix()
    const granted: string[] = []
    s.request('root', '/w/mono', () => granted.push('root'))
    s.request('child', '/w/mono/pkg', () => granted.push('child'))
    s.request('other', '/w/other', () => granted.push('other'))
    s.request('sibling', '/w/mono-2', () => granted.push('sibling'))
    expect(granted).toEqual(['root', 'other', 'sibling'])
    expect(s.blockedBy('child')).toMatchObject({ runId: 'root' })
    s.release('root')
    expect(granted).toContain('child')
  })

  it('keeps FIFO order across a conflict set: a later run never jumps an earlier conflicting one', () => {
    const s = posix()
    const granted: string[] = []
    s.request('a', '/w/mono/pkg-a', () => granted.push('a'))
    s.request('b', '/w/mono', () => granted.push('b')) // waits for a (ancestor)
    s.request('c', '/w/mono/pkg-c', () => granted.push('c')) // free of a, but b (earlier) conflicts
    expect(granted).toEqual(['a'])
    expect(s.blockedBy('c')).toMatchObject({ runId: 'b', state: 'queued' })
    s.release('a')
    expect(granted).toEqual(['a', 'b'])
    s.release('b')
    expect(granted).toEqual(['a', 'b', 'c'])
  })

  it('restores holders at relaunch and lets a queued run leave the queue', () => {
    const s = posix()
    s.restoreHolder('old', '/w/repo', 5)
    const granted: string[] = []
    s.request('new', '/w/repo', () => granted.push('new'))
    s.request('later', '/w/repo', () => granted.push('later'))
    expect(s.blockerFor('/w/repo')).toMatchObject({ runId: 'old', state: 'holder', since: 5 })
    expect(s.blockerFor('/w/repo', 'old')).toMatchObject({ runId: 'new', state: 'queued' })
    s.release('new')
    expect(s.isQueued('new')).toBe(false)
    s.release('old')
    expect(granted).toEqual(['later'])
  })

  it('folds case on win32 keys the way lockKey produced them', () => {
    const s = new FolderScheduler({ platform: 'win32' })
    const granted: string[] = []
    s.request('a', 'c:\\work\\repo', () => granted.push('a'))
    s.request('b', 'c:\\work\\repo\\sub', () => granted.push('b'))
    expect(granted).toEqual(['a'])
  })
})
