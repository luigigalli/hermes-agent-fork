import { expect, it } from 'vitest'

import type { CanonicalGroupEvent } from './canonical-group-history'
import {
  canonicalEventToLogEntry,
  canonicalGroupLog,
  canonicalThreadIdOf,
  canonicalThreadUnread,
  groupMessageSections,
  untetheredNotices
} from './canonical-group-threads'

const event = (
  seq: number,
  kind: string,
  payload: CanonicalGroupEvent['payload'],
  created_at = 1000
): CanonicalGroupEvent => ({
  created_at,
  kind,
  payload,
  seq
})

it('thread ids default to the legacy sentinel and map onto the shared projection', () => {
  expect(canonicalThreadIdOf(event(1, 'message.user', { text: 'Hi', thread_id: 'a' }))).toBe('a')
  expect(canonicalThreadIdOf(event(2, 'message.user', { text: 'No thread' }))).toBe('legacy')

  const entry = canonicalEventToLogEntry(event(3, 'message.user', { text: 'Hello', thread_id: 'a' }, 1792152001.5))

  expect(entry).toMatchObject({
    at: 1792152001500,
    from: { kind: 'user' },
    // With no event_id the fallback id is the entry's own thread id.
    id: 'a',
    text: 'Hello',
    thread: 'a'
  })

  const member = canonicalEventToLogEntry({
    actor: { display_name: 'Historical Helper', id: 'helper', kind: 'member' },
    created_at: 1792152002,
    kind: 'message.member',
    payload: { member_id: 'helper', text: 'Done', thread_id: 'a' },
    seq: 4
  })

  expect(member).toMatchObject({ at: 1792152002000, from: { kind: 'member', name: 'Historical Helper' }, thread: 'a' })

  const bare = canonicalEventToLogEntry({ created_at: NaN, kind: 'message', payload: { text: 'Old' }, seq: 5 })

  expect(bare).toMatchObject({ at: 0, from: { kind: 'member' }, thread: 'legacy' })
})

it('groups only the message kinds into creation-ordered per-thread sections', () => {
  const events = [
    event(1, 'message.member', { text: 'Build done', thread_id: 'a' }),
    event(2, 'turn.failed', { error: 'boom', thread_id: 'a' }),
    event(3, 'message.user', { text: 'Release request', thread_id: 'b' }),
    event(4, 'room.activity', { status: 'settled' }),
    event(5, 'message.user', { text: 'Build request', thread_id: 'a' }, 900)
  ]

  const sections = groupMessageSections(events)

  // First-seen order: 'a' opened the room, 'b' arrived after; timestamps do not reorder.
  expect(sections.map(section => section.threadId)).toEqual(['a', 'b'])
  expect(sections[0]).toMatchObject({ count: 2, head: 'Build done', lastAtMs: 1000000 })
  expect(sections[0].notices.map(notice => notice.seq)).toEqual([2])
  expect(sections[1]).toMatchObject({ count: 1, head: 'Release request' })
  // turn/room/system events never enter the thread flow…
  expect(canonicalGroupLog(events)).toHaveLength(3)
  // …and thread-less notices stay OUT of every section.
  expect(untetheredNotices(events).map(notice => notice.kind)).toEqual(['room.activity'])
})

it('canonicalThreadUnread counts only entries newer than the last-seen watermark', () => {
  const events = [
    event(1, 'message.user', { text: 'one', thread_id: 'a' }, 1000),
    event(2, 'message.member', { text: 'two', thread_id: 'a' }, 2000),
    event(3, 'message.member', { text: 'three', thread_id: 'a' }, 3000)
  ]

  const section = groupMessageSections(events)[0]

  expect(canonicalThreadUnread(undefined, section)).toBe(0)
  expect(canonicalThreadUnread(0, section)).toBe(3)
  expect(canonicalThreadUnread(2000000, section)).toBe(1)
  expect(canonicalThreadUnread(3000000, section)).toBe(0)
})
