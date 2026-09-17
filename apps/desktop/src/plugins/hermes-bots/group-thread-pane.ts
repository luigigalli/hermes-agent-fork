/**
 * Thread pane for group rooms: the list of open threads (ordered by last
 * activity), each row with head text, reply count, last-activity time and an
 * unread badge (messages arrived since the user last looked at that thread).
 * Clicking a row focuses that thread's reply box (reply-in-thread), the same
 * intent the existing inline link expresses — the pane just makes the threads
 * VISIBLE instead of only reachable by scrolling.
 *
 * Non-destructive by design (#3a7bf7455f invariant kept): the main timeline
 * still renders every entry in arrival order — the pane is additive, nothing
 * is folded or hidden. The agent-side counterpart (thread digest in the
 * member prompt) rides the same derivation below.
 */
import { atom } from '@hermes/plugin-sdk'
import type { GroupChat, GroupMessage } from './types'

export interface GroupThreadSummary {
  /** Canonical thread id (`groupThreadOf`). */
  id: string
  /** First entry's text — the topic head. */
  head: string
  /** Total entries in the thread. */
  count: number
  /** Newest entry timestamp (ms). */
  lastAt: number
  /** Last entry's plain text (for the preview line). */
  lastText: string
  /** Whether the room's latest activity lives in this thread. */
  isActive: boolean
}

/** Derive one row per thread from the room log, newest activity first. Pure.
 *  `groupThreadOf` is imported by the caller to keep a single id policy. */
export function deriveGroupThreads(log: GroupMessage[], activeThreadId?: string): GroupThreadSummary[] {
  const byId = new Map<string, { head: string; count: number; lastAt: number; lastText: string }>()

  for (const entry of log || []) {
    const id = entry?.thread || 'legacy'
    const current = byId.get(id)
    if (!current) {
      byId.set(id, { head: entry.text || '', count: 1, lastAt: entry.at || 0, lastText: entry.text || '' })
    } else {
      current.count += 1
      current.lastText = entry.text || current.lastText
      current.lastAt = Math.max(current.lastAt, entry.at || 0)
    }
  }

  return [...byId.entries()]
    .map(([id, agg]) => ({ id, ...agg, isActive: id === activeThreadId }))
    .sort((a, b) => b.lastAt - a.lastAt)
}

/** Renderer-side unread tracking: one atom holds, per room key, the last-seen
 *  timestamp per thread. Scope key = room id; the store is ephemeral by design
 *  (unread state that survives restarts would nag about stale topics). */
export const $groupThreadReads = atom<Record<string, Record<string, number>>>({})

/** Count entries in a thread newer than the last-seen watermark. */
export function groupThreadUnread(
  watermark: number | undefined,
  entries: GroupMessage[]
): number {
  if (watermark === undefined) return 0
  return entries.filter(entry => (entry.at || 0) > watermark).length
}

/** Mark a thread read: stamp the room's watermark for that thread to now. */
export function markGroupThreadRead(roomKey: string, threadId: string, atMs: number) {
  $groupThreadReads.set(prev => ({
    ...prev,
    [roomKey]: { ...(prev[roomKey] || {}), [threadId]: atMs }
  }))
}

/** The thread digest line for a member prompt — agent-side visibility into
 *  the OTHER open threads of the room, so a member can choose to intervene.
 *  Bounded: newest 6 threads, 1 line each, excludes the member's own current
 *  thread (that one is already in the delta). */
export function groupThreadDigest(
  log: GroupMessage[],
  currentThreadId: string | null | undefined,
  _room: Partial<GroupChat> = {}
): string {
  const threads = deriveGroupThreads(log, currentThreadId || undefined)
    .filter(t => t.id !== (currentThreadId || 'legacy'))
    .slice(0, 6)

  if (!threads.length) return ''

  const lines = threads
    .filter(thread => thread.count > 0)
    .map(thread => {
      const label = (thread.head || thread.lastText || '').replace(/\s+/g, ' ').slice(0, 60)
      return `  · thread ${thread.id}: “${label}” · ${thread.count} msgs · last ${new Date(
        thread.lastAt
      ).toLocaleTimeString()}`
    })

  return lines.length ? `Other open threads in this room:\n${lines.join('\n')}` : ''
}