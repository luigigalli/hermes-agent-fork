/**
 * Read-only projection of a group room's archived past — the arrangement
 * Luigi asked for (decision 24/10, t_97e2e058): past threads collapsed on top
 * of the window, the live conversation at the bottom where he writes.
 *
 * The projection READS the store copies the renderer already holds and writes
 * NOTHING — zero migration, zero calls into the room writers (card contract).
 * The two reachable copies:
 *  - the durable renderer log `$groupChats` (localStorage `group-chats`,
 *    retention `GROUP_CHAT_LOG_RETAIN = 400` = 2 × GROUP_CHAT_HISTORY_LIMIT
 *    200);
 *  - the gateway mirror `ui_meta.hermes-bots-groups` (default profile.yaml,
 *    v3, 6 rooms; SYSTEM DEVELOPMENT TEAM = 33 entries + omitted 352,
 *    revision 1582, last entry 23/10 14:26) — reached through the EXISTING
 *    sync engine, whose read-only `profiles.list` pull
 *    (`pullGroupChatServerState` → `mergeRemoteGroupChatSnapshotIntoRooms`)
 *    unions it into `$groupChats` with dedupe by entry key.
 *
 * The third documented copy — the complete transcript of the 24 «Group:»
 * plumbing sessions in state.db (3,293 messages across them; SDT ≥10
 * sessions since 06/10, AGENT IMPROVEMENT 700, PERMANENT SUMMIT and
 * STANDARDS & PROJECTS COMMITTEE 619 via source 'tui') — is NOT reachable
 * for the renderer without a NEW read-only gateway RPC, and one is
 * deliberately not added here (gateway code takes effect on a service
 * restart): that archive stays covered by the established canon, a readable
 * export on explicit request. A room archived only in OTHER stores (e.g.
 * PERMANENT SUMMIT, 42 events, shared-state.db) simply has no local archive
 * and the pane shows that honestly.
 *
 * Thread structure comes from the fork-era utilities the old room view ran:
 * `assignLegacyThreads` (explicit thread ids keep theirs; pre-thread logs get
 * synthetic ids by the 15-minute lull rule) and `deriveGroupThreads` (the
 * collapsed index, newest activity first) — the same derivation, re-projected.
 * The archive of a legacy room receives no writes after the port, so the
 * synthetic thread ids derived here are stable across re-renders.
 */
import { assignLegacyThreads, type GroupChatRoom } from './group-chat'
import { deriveGroupThreads } from './group-thread-pane'
import type { GroupMessage } from './types'

export interface LegacyArchiveThreads {
  /** One row per thread, newest activity first (`deriveGroupThreads` order). */
  threads: ReturnType<typeof deriveGroupThreads>
  /** Entries of each thread, in arrival order. */
  entriesByThread: Map<string, GroupMessage[]>
}

/** Project the archived past of one room from its durable local copies. Pure:
 *  no atom is touched and no entry is mutated (entries may be re-keyed with a
 *  synthetic thread id, always on COPIES — `assignLegacyThreads` maps). */
export function legacyArchiveThreads(room: GroupChatRoom | undefined): LegacyArchiveThreads {
  const log: GroupMessage[] = assignLegacyThreads(room?.log || [])
  const entriesByThread = new Map<string, GroupMessage[]>()

  for (const entry of log) {
    const id = entry.thread || 'legacy'
    const entries = entriesByThread.get(id)

    if (entries) {
      entries.push(entry)
    } else {
      entriesByThread.set(id, [entry])
    }
  }

  return { threads: deriveGroupThreads(log), entriesByThread }
}
