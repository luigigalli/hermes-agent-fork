/**
 * Thread view state for canonical rooms (fork UX re-landed on the v0.22.4
 * canonical protocol, deposit-spec 19/10): the timeline keeps threads DISTINCT
 * — grouped under per-thread headers, the index ordered by CREATION — and
 * folding is only a view affordance, never a log mutation. The canonical
 * protocol already makes `thread_id` resident in every `message.*` payload
 * (the desktop send mints it, the discussion driver stamps member replies),
 * so the shared pane/prompt utilities (`group-thread-pane.ts`) drive off the
 * same derivation, projected from the room log.
 */
import type { CanonicalGroupEvent } from './canonical-group-history'
import type { GroupMessage } from './types'

/** Events a thread pane folds on: the three message kinds (the owner surface
 *  may emit bare `message` rows). */
const MESSAGE_KINDS = new Set(['message', 'message.user', 'message.member'])

export function isCanonicalMessageEvent(event: CanonicalGroupEvent): boolean {
  return MESSAGE_KINDS.has(event.kind)
}

/** A message predating threading carries the `'legacy'` sentinel thread. */
export function canonicalThreadIdOf(event: CanonicalGroupEvent): string {
  return String(event.payload?.thread_id || '').trim() || 'legacy'
}

/** `groups.log` created_at is Unix seconds; the shared pane/prompt utilities
 *  work in milliseconds. A clock the gateway did not fill stays 0 and shows
 *  the same "unread=everything" shape the local log gives an unfilled clock. */
export function canonicalEventAtMs(event: CanonicalGroupEvent): number {
  const at = event.created_at

  return typeof at === 'number' && Number.isFinite(at) ? at * 1000 : 0
}

export function canonicalEventToLogEntry(event: CanonicalGroupEvent): GroupMessage {
  return {
    at: canonicalEventAtMs(event),
    from: {
      kind: event.kind === 'message.user' ? 'user' : 'member',
      name: event.actor?.display_name || event.actor?.id || event.payload?.member_id || ''
    },
    id: event.event_id || canonicalThreadIdOf(event),
    text: event.payload?.text || '',
    thread: canonicalThreadIdOf(event)
  }
}

/** The message events, in arrival order, shaped for the shared pane/prompt
 *  utilities (`room.log consumers`). Non-message kinds (turn/room/system) are
 *  excluded: they never enter the thread flow. */
export function canonicalGroupLog(events: CanonicalGroupEvent[]): GroupMessage[] {
  return (events || []).filter(isCanonicalMessageEvent).map(canonicalEventToLogEntry)
}

export interface CanonicalThreadSection {
  threadId: string
  /** First entry's text — the topic head (may be empty for attachment-only opens). */
  head: string
  count: number
  /** Newest entry, milliseconds. */
  lastAtMs: number
  /** Message events in arrival order. */
  entries: CanonicalGroupEvent[]
  /** Notice events (turn.*, room.*) addressed to this thread, in arrival order. */
  notices: CanonicalGroupEvent[]
}

/** One section per thread, ordered by CREATION (first-seen seq) so the index
 *  and the timeline read the same list; entries stay in arrival order. Pure. */
export function groupMessageSections(events: CanonicalGroupEvent[]): CanonicalThreadSection[] {
  const byThread = new Map<string, CanonicalThreadSection>()

  for (const event of events || []) {
    const notice = !isCanonicalMessageEvent(event)
    const threadId = canonicalThreadIdOf(event)

    if (notice && threadId === 'legacy') {
      // A thread-less notice belongs to the trailing flow, never to a
      // spurious "thread" section.
      continue
    }

    let section = byThread.get(threadId)

    if (!section) {
      section = { threadId, head: '', count: 0, lastAtMs: 0, entries: [], notices: [] }
      byThread.set(threadId, section)
    }

    if (notice) {
      section.notices.push(event)

      continue
    }

    if (section.count === 0) {
      section.head = event.payload?.text || ''
    }

    section.count += 1
    section.lastAtMs = Math.max(section.lastAtMs, canonicalEventAtMs(event))
    section.entries.push(event)
  }

  return [...byThread.values()]
}

/** Notice events with no thread attachment: they render in their own trailing
 *  flow (disband/stop/authority notices arrive after the topics they end). */
export function untetheredNotices(events: CanonicalGroupEvent[]): CanonicalGroupEvent[] {
  return (events || []).filter(event => !isCanonicalMessageEvent(event) && !event.payload?.thread_id)
}

/** Thread unread for one room: counts the section's entries newer than the
 *  last-seen watermark (group-thread-pane's rule, canonical event clocks). */
export function canonicalThreadUnread(watermark: number | undefined, section: CanonicalThreadSection): number {
  if (watermark === undefined) {
    return 0
  }

  return section.entries.filter(event => canonicalEventAtMs(event) > watermark).length
}
