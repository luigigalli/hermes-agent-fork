/**
 * The collapsed past of a group room, rendered as a READ-ONLY projection
 * (decision 24/10, t_97e2e058): the pane mounts collapsed on top of the
 * window — the room's old threads under foldable headers, the live
 * conversation still at the bottom where the user writes.
 *
 * Zero writes, by the card contract: entries come from `legacyArchiveThreads`
 * (durable `$groupChats` + the mirror the sync engine already unions into
 * it), folding/expanding is component-local state, no thread of the archive
 * is marked read, no room writer and no RPC runs from this surface.
 */
import { Codicon } from '@hermes/plugin-sdk'
import { useState } from 'react'

import { legacyArchiveThreads } from './canonical-group-legacy-archive'
import { useBots } from './i18n'
import type { GroupChatRoom } from './group-chat'
import type { GroupMessage } from './types'

/** One archived thread: its rows in arrival order, read-only. Images ride the
 *  durable entries as data URLs (`Attachment.data`) and render inline; the
 *  mirror projection strips them, so only locally-kept entries show them. */
function ArchiveThreadRows({ entries }: { entries: GroupMessage[] }) {
  return (
    <div className="grid gap-0.5 border-l border-(--ui-stroke-secondary) pl-2">
      {entries.map((entry, index) => {
        const images = (Array.isArray(entry.images) ? entry.images : []).filter(
          image => typeof image?.data === 'string' && image.data
        )

        return (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 py-0.5" key={`${entry.at}:${entry.thread}:${index}`}>
            <div className="flex items-center gap-2">
              <strong className="min-w-0 truncate text-[0.7rem] font-semibold text-(--ui-accent)">
                {entry.from?.name}
              </strong>
              <span className="shrink-0 text-[0.625rem] text-(--ui-text-quaternary)">
                {entry.at ? new Date(entry.at).toLocaleString() : ''}
              </span>
              {entry.truncated && <span className="shrink-0 text-[0.6rem] text-(--ui-text-quaternary)">…</span>}
            </div>
            <div
              className="min-w-0 whitespace-pre-wrap break-words text-xs text-(--ui-text-secondary)"
              data-selectable-text="true"
            >
              {entry.text}
            </div>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {images.map((image, imageIndex) => (
                  /* Data URLs straight from the durable log — read-only display, no download port. */
                  <img
                    alt={image.name || `image-${imageIndex + 1}`}
                    className="max-h-24 rounded-md"
                    key={`img-${index}-${imageIndex}`}
                    src={image.data}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function CanonicalGroupLegacyHistory({
  room,
  showWhenEmpty = false
}: {
  /** The room's durable record (`$groupChats` by room name). */
  room: GroupChatRoom | undefined
  /** The gate page always mounts the pane (the room's only history surface);
   *  a live canonical room with no archived past renders nothing. */
  showWhenEmpty?: boolean
}) {
  const b = useBots()
  const [paneOpen, setPaneOpen] = useState(false)
  const [openThreads, setOpenThreads] = useState<ReadonlySet<string>>(() => new Set())

  if (!room || !room.log?.length) {
    if (!showWhenEmpty) {
      return null
    }

    return (
      <div className="border-b border-(--ui-stroke-secondary)">
        <div className="px-2.5 py-1 text-[0.7rem] text-(--ui-text-quaternary)">{b.canonical.archiveTitle}</div>
        <p className="px-2.5 pb-1.5 text-xs text-(--ui-text-tertiary)" role="note">
          {b.canonical.archiveEmpty}
        </p>
      </div>
    )
  }

  const { threads, entriesByThread } = legacyArchiveThreads(room)

  const toggleThread = (threadId: string) => {
    setOpenThreads(prev => {
      const next = new Set(prev)

      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }

      return next
    })
  }

  return (
    <div className="border-b border-(--ui-stroke-secondary)" data-testid="group-legacy-history">
      <button
        aria-controls={`group-legacy-history:${room.roomId || 'name'}`}
        aria-expanded={paneOpen}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[0.7rem] text-(--ui-text-quaternary) transition-colors hover:text-foreground"
        onClick={() => setPaneOpen(open => !open)}
        title={b.canonical.archiveTitle}
        type="button"
      >
        <Codicon className="shrink-0 text-[0.65rem]" name={paneOpen ? 'chevron-down' : 'chevron-right'} />
        <span className="shrink-0 font-medium">{b.canonical.archiveTitle}</span>
        <span className="shrink-0 text-[0.625rem] text-(--ui-text-quaternary)">{threads.length}</span>
      </button>
      {paneOpen && (
        <div className="grid gap-0.5 px-2.5 pb-1.5" id={`group-legacy-history:${room.roomId || 'name'}`}>
          {threads.map(thread => {
            const entries = entriesByThread.get(thread.id) || []
            const open = openThreads.has(thread.id)

            return (
              <div key={thread.id}>
                <button
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-left text-xs text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground"
                  onClick={() => toggleThread(thread.id)}
                  title={open ? b.canonical.collapseThread : b.canonical.expandThread}
                  type="button"
                >
                  <Codicon className="shrink-0 text-[0.65rem]" name={open ? 'chevron-down' : 'chevron-right'} />
                  <span className="min-w-0 flex-1 truncate">
                    {(thread.head || b.canonical.threadUntitled).replace(/\s+/g, ' ').slice(0, 70)}
                  </span>
                  <span className="shrink-0 text-[0.6rem] text-(--ui-text-quaternary)">{thread.count}</span>
                </button>
                {open && <ArchiveThreadRows entries={entries} />}
              </div>
            )
          })}
          <p className="px-2 pt-0.5 text-[0.625rem] text-(--ui-text-quaternary)" role="note">
            {b.canonical.archiveSource}
          </p>
        </div>
      )}
    </div>
  )
}
