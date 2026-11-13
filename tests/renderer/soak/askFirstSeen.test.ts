// Soak (AttentionPanel's countdown): an ask whose stream is not
// loaded (the Dashboard's needs-you strip) counts down from when this window first showed it. Those first sights are
// remembered by run and request, at most FIRST_SEEN_MAX of them. Before, every ask a session showed stayed in the map,
// and a request id another run had used (the vendor's id; the fakes repeat theirs) took that run's first sight.
import { describe, expect, it } from 'vitest'
import { FIRST_SEEN_MAX, firstSeenAt, firstSeenCount } from '@renderer/components/attention/AskCard.tsx'

describe('ask first sights (soak)', () => {
  it('keeps the first sight of each run and request', () => {
    expect(firstSeenAt('run-a', 'req-1', 1_000)).toBe(1_000)
    expect(firstSeenAt('run-a', 'req-1', 5_000)).toBe(1_000)
    // The same request id in another run is another ask.
    expect(firstSeenAt('run-b', 'req-1', 9_000)).toBe(9_000)
    expect(firstSeenAt('run-b', 'req-1', 12_000)).toBe(9_000)
  })

  it('remembers at most FIRST_SEEN_MAX asks, forgetting the oldest', () => {
    for (let i = 0; i < FIRST_SEEN_MAX + 50; i++) firstSeenAt(`run-${i}`, 'req-1', i)
    expect(firstSeenCount()).toBe(FIRST_SEEN_MAX)
    // The newest stay as they were first seen; the oldest start afresh.
    const newest = FIRST_SEEN_MAX + 49
    expect(firstSeenAt(`run-${newest}`, 'req-1', 99_999)).toBe(newest)
    expect(firstSeenAt('run-0', 'req-1', 77_777)).toBe(77_777)
    expect(firstSeenCount()).toBe(FIRST_SEEN_MAX)
  })
})
