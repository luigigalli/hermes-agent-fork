import { expect, it } from 'vitest'

import { legacyArchiveThreads } from './canonical-group-legacy-archive'
import { type GroupChatRoom } from './group-chat'
import type { GroupMessage } from './types'

const entry = (at: number, text: string, kind: 'member' | 'user', thread?: string): GroupMessage => ({
  at,
  from: { kind, name: kind === 'user' ? 'You' : 'Merk' },
  ...(thread ? { thread } : {}),
  text
})

const room = (log: GroupMessage[]): GroupChatRoom => ({ epoch: 0, log, running: false, watermarks: {} })

it('keeps explicit thread ids and splits only threadless stretches by the 15-minute lull (the fork-era derivation)', () => {
  const t0 = 1_700_000_000_000
  const log = [
    entry(t0, 'Kick off', 'user'),
    entry(t0 + 60_000, 'Building', 'member'),
    entry(t0 + 60_000 + 16 * 60_000, 'Next topic', 'user')
  ]

  const { threads, entriesByThread } = legacyArchiveThreads(room(log))

  // Synthetic ids are stable for a frozen archive: gap-split + user restart.
  expect(threads.map(thread => thread.id)).toEqual(['legacy-1', 'legacy-0'])
  expect(threads.map(thread => thread.count)).toEqual([1, 2])
  // Index order = newest activity first, as the old thread pane listed them.
  expect(threads[0].head).toBe('Next topic')
  expect(threads[1].head).toBe('Kick off')
  // Entry buckets stay in arrival order.
  expect((entriesByThread.get('legacy-0') || []).map(message => message.text)).toEqual(['Kick off', 'Building'])
  expect((entriesByThread.get('legacy-1') || []).map(message => message.text)).toEqual(['Next topic'])
})

it('keeps fork-era explicit thread ids and buckets their entries', () => {
  const t0 = 1_700_000_000_000
  const log = [
    entry(t0, 'Thread A head', 'user', 't1abc'),
    entry(t0 + 5_000, 'Reply in A', 'member', 't1abc'),
    entry(t0 + 10_000, 'Thread B head', 'user', 't2def')
  ]

  const { threads, entriesByThread } = legacyArchiveThreads(room(log))

  expect(threads.map(thread => thread.id)).toEqual(['t2def', 't1abc'])
  expect(threads[1].head).toBe('Thread A head')
  expect((entriesByThread.get('t1abc') || []).map(message => message.text)).toEqual(['Thread A head', 'Reply in A'])
})

it('never writes: the input entries are re-keyed on copies only', () => {
  const t0 = 1_700_000_000_000
  const log = [entry(t0, 'Plain entry', 'user')]
  const frozen = room([Object.freeze({ ...log[0] })])

  const snapshot = JSON.stringify(frozen.log)
  const first = legacyArchiveThreads(room(log))
  const again = legacyArchiveThreads(frozen)

  expect(first.threads[0].id).toBe('legacy-0')
  expect(again.threads[0].id).toBe('legacy-0')
  expect(JSON.stringify(frozen.log)).toBe(snapshot)
  // The input entry itself never gains a synthetic thread key.
  expect(log[0].thread).toBeUndefined()
})

it('an absent or empty room projects nothing', () => {
  expect(legacyArchiveThreads(undefined)).toMatchObject({ threads: [] })
  expect(legacyArchiveThreads(room([])).threads).toEqual([])
})
