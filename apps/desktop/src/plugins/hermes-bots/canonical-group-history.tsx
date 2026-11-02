import * as sdk from '@hermes/plugin-sdk'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { type CanonicalGroupAttachment, CanonicalGroupAttachments, fetchCanonicalGroupAttachment } from './canonical-group-attachments'
import { useCanonicalGroupLabels } from './canonical-group-labels'
import { groupMessageSections, isCanonicalMessageEvent, untetheredNotices } from './canonical-group-threads'
import type { CanonicalGroupBinding, CanonicalRoomMember } from './canonical-groups'

const MessageTextContent = typeof sdk === 'undefined' ? undefined : sdk.MessageTextContent
const Streamdown = typeof sdk === 'undefined' ? undefined : sdk.Streamdown

export interface CanonicalGroupEvent {
  seq: number
  event_id?: string
  room_id?: string
  kind: string
  payload: {
    text?: string
    content?: string
    attachments?: CanonicalGroupAttachment[]
    member_id?: string
    error?: string
    reason?: string
    reason_code?: string
    status?: string
    /** Protocol-resident on message payloads: the desktop send mints it, the
     *  discussion driver stamps it on member replies (threading UX). */
    thread_id?: string
  }
  actor?: { kind?: string; id?: string; display_name?: string }
  created_at?: number
}

/** View-model the workspace passes so this stays a projection of its thread
 *  model: folded sections, their unread counts, and the active thread's
 *  reply-composer slot. Absent = the bare flat log (verbatim upstream shape,
 *  used by tests and any caller without a thread model). */
export interface CanonicalThreadHistoryView {
  foldedThreadIds?: ReadonlySet<string>
  unreadByThread?: Record<string, number>
  replyThreadId?: string | null
  replySlot?: ReactNode
  onToggleThread?: (threadId: string) => void
}

interface CanonicalGroupHistoryProps {
  binding: CanonicalGroupBinding
  events: CanonicalGroupEvent[]
  members?: CanonicalRoomMember[]
  disabled?: boolean
  threadView?: CanonicalThreadHistoryView
}

function eventAuthor(event: CanonicalGroupEvent, roster: Map<string, CanonicalRoomMember>, isMessage: boolean) {
  const memberId = isMessage ? (event.actor?.kind === 'member' ? event.actor.id : undefined) : event.payload.member_id

  const member = roster.get(memberId ?? '')

  // The log's label preserves who spoke even if the roster has since changed.
  return (
    (isMessage ? event.actor?.display_name : undefined) ||
    member?.display_name ||
    member?.handle ||
    (isMessage ? event.actor?.id : memberId)
  )
}

function EventTime({ timestamp }: { timestamp?: number }) {
  if (typeof timestamp !== 'number') {
    return null
  }

  const at = new Date(timestamp * 1000)

  if (!Number.isFinite(at.getTime())) {
    return null
  }

  return (
    <time className="text-[0.625rem] text-(--ui-text-quaternary)" dateTime={at.toISOString()}>
      {sdk.relativeTime(at.getTime())}
    </time>
  )
}

function EventBody({ event }: { event: CanonicalGroupEvent }) {
  const text = event.payload.text || event.payload.content || ''

  return (
    <div
      className="min-w-0 text-xs text-(--ui-text-secondary) [&_p]:mb-1 [&_p:last-child]:mb-0 [&_ul]:mb-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere"
      data-selectable-text="true"
    >
      {/* The shared renderer (layout and large-message safeguards). media={false}: room text
        may come from another machine, so its MEDIA: paths never resolve against this gateway;
        room files keep their own download path below. */}
      {MessageTextContent ? (
        <MessageTextContent media={false} text={text} />
      ) : Streamdown ? (
        <Streamdown>{text}</Streamdown>
      ) : (
        text
      )}
    </div>
  )
}

// Previews download the whole file over RPC; larger or unsized images keep only Download.
const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

// Automatic previews share a small download budget per connection, in request order; a file already
// downloading is joined rather than requested again. Manual Download stays outside it. The budget is
// per connection because a remote whose dial hangs holds its slots for good, and must not stall others.
type Preview = Awaited<ReturnType<typeof fetchCanonicalGroupAttachment>>
interface PreviewQueue { slots: number; waiters: Array<() => void> }
const previewDownloads = new Map<string, Promise<Preview>>()
const previewQueues = new Map<string, PreviewQueue>()

function releasePreviewSlot(queue: PreviewQueue) {
  const next = queue.waiters.shift()

  if (next) {next()} else {queue.slots++}
}

function queuePreview(connectionId: string, key: string, fetch: () => Promise<Preview>, onPreview: (preview: Preview) => void) {
  const queue = previewQueues.get(connectionId) ?? { slots: 2, waiters: [] }
  previewQueues.set(connectionId, queue)
  let cancelled = false
  const deliver = (download: Promise<Preview>) => void download.then(preview => { if (!cancelled) {onPreview(preview)} }, () => undefined)

  const run = () => {
    let download = previewDownloads.get(key)

    if (download) {releasePreviewSlot(queue)} else {
      download = fetch().finally(() => { previewDownloads.delete(key); releasePreviewSlot(queue) })
      previewDownloads.set(key, download)
    }

    deliver(download)
  }

  const running = previewDownloads.get(key)

  if (running) {deliver(running)} else if (queue.slots > 0) {queue.slots--; run()} else {queue.waiters.push(run)}

  // A preview that leaves before its turn gives up its place without sending a request.
  return () => {
    cancelled = true
    const at = queue.waiters.indexOf(run)

    if (at >= 0) {queue.waiters.splice(at, 1)}
  }
}

function ImagePreview({ binding, eventId, attachment, disabled }: {
  binding: CanonicalGroupBinding; eventId: string; attachment: CanonicalGroupAttachment; disabled: boolean
}) {
  const [src, setSrc] = useState('')
  const [near, setNear] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const { attachment_id: attachmentId, size } = attachment
  const { connectionId, profile, roomId } = binding
  const previewable = !!attachmentId && size !== undefined && size <= IMAGE_PREVIEW_MAX_BYTES

  // History loads the whole room: fetch only near the viewport. Leaving before its turn gives up the queued place;
  // a started download runs to completion and is shared if the preview returns.
  useEffect(() => {
    const el = box.current

    if (src || disabled || !el) {return}
    const observer = new IntersectionObserver(entries => setNear(entries[entries.length - 1].isIntersecting), { rootMargin: '200px' })
    observer.observe(el)

    return () => observer.disconnect()
  }, [src, disabled])

  useEffect(() => {
    if (disabled || !near || !attachmentId || !previewable) {return}
    let url = ''
    const key = JSON.stringify([connectionId, profile, roomId, eventId, attachmentId])

    // A failed preview leaves the Download button as the way to the file.
    const cancel = queuePreview(connectionId, key, () => fetchCanonicalGroupAttachment({ connectionId, profile, roomId }, eventId, attachmentId), ({ bytes, mime }) => {
      url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      setSrc(url)
    })

    // Dropping `near` makes a re-shown room wait on the observer again, not refetch every preview seen so far at once.
    return () => { cancel(); URL.revokeObjectURL(url); setSrc(''); setNear(false) }
  }, [connectionId, profile, roomId, eventId, attachmentId, disabled, near, previewable])

  return previewable ? <div ref={box}>{src && <img alt={attachment.name} className="max-h-64 max-w-full rounded object-contain" src={src} />}</div> : null
}

function MessageRow({
  author,
  canonical,
  disabled,
  event
}: {
  author?: string
  canonical: CanonicalGroupBinding
  disabled?: boolean
  event: CanonicalGroupEvent
}) {
  const previewEventId = event.room_id === canonical.roomId ? event.event_id : undefined

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        {author && <strong className="text-[0.7rem] font-semibold text-(--ui-accent)">{author}</strong>}
        <EventTime timestamp={event.created_at} />
      </div>
      <EventBody event={event} />
      {previewEventId && event.payload.attachments?.filter(a => a.kind === 'image').map(a =>
        <ImagePreview attachment={a} binding={canonical} disabled={Boolean(disabled)} eventId={previewEventId} key={a.attachment_id ?? a.name} />)}
      {!!event.payload.attachments?.length && (
        <CanonicalGroupAttachments
          attachments={event.payload.attachments.map(attachment => ({ ...attachment, event_id: event.event_id }))}
          binding={canonical}
          disabled={disabled || !event.event_id || event.room_id !== canonical.roomId}
          readOnly
        />
      )}
    </div>
  )
}

function NoticeRow({ author, event, notice }: { author?: string; event: CanonicalGroupEvent; notice: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        {author && <strong className="text-[0.7rem] font-semibold text-(--ui-accent)">{author}</strong>}
        <EventTime timestamp={event.created_at} />
      </div>
      <NoticeBody event={event} notice={notice} />
    </div>
  )
}

function NoticeBody({ event, notice }: { event: CanonicalGroupEvent; notice: string }) {
  const detail = event.payload.error || event.payload.reason || event.payload.reason_code

  return (
    <p className="text-xs text-(--ui-text-secondary)" data-selectable-text="true">
      <strong>{notice}</strong>
      {detail && <>: {detail}</>}
    </p>
  )
}

export function CanonicalGroupHistory({
  binding,
  events,
  members = [],
  disabled = false,
  threadView
}: CanonicalGroupHistoryProps) {
  const labels = useCanonicalGroupLabels()
  const roster = new Map(members.map(member => [member.member_id, member]))

  const notices = new Map([
    ['turn.failed', labels.turnFailed],
    ['turn.cancelled', labels.turnCancelled],
    ['turn.deferred', labels.turnDeferred],
    ['member.unavailable', labels.memberUnavailable],
    ['room.stop_requested', labels.roomStopped],
    ['room.disbanded', labels.roomDisbanded],
    ['authority.lost', labels.authorityLost]
  ])

  const entry = (event: CanonicalGroupEvent) => {
    // Verbatim upstream dispatch: a bare notice or a message-kind row; anything
    // else (turn.started/settled machinery, unknown kinds) is not rendered.
    const notice =
      event.kind === 'room.activity' && event.payload.status === 'bounded'
        ? labels.workLimitReached
        : notices.get(event.kind)

    if (!notice && !isCanonicalMessageEvent(event)) {
      return null
    }

    const author = eventAuthor(event, roster, !notice && isCanonicalMessageEvent(event))

    if (notice) {
      return <NoticeRow author={author} event={event} key={event.seq} notice={notice} />
    }

    return <MessageRow author={author} canonical={binding} disabled={disabled} event={event} key={event.seq} />
  }

  if (!threadView) {
    // Verbatim upstream flow: every event in arrival order, notices included.
    return <>{events.map(entry)}</>
  }

  const folded = threadView.foldedThreadIds
  const sections = groupMessageSections(events)
  const trailing = untetheredNotices(events)
  const replyThreadId = threadView.replyThreadId ?? null
  const replySlot = threadView.replySlot
  const onToggleThread = threadView.onToggleThread
  const unreadByThread = threadView.unreadByThread || {}

  return (
    <>
      {sections.map(section => {
        const unread = unreadByThread[section.threadId] || 0
        const sectionFolded = folded?.has(section.threadId) ?? false
        const onToggle = onToggleThread && ((): void => onToggleThread(section.threadId))

        // A single-topic room keeps the bare timeline (no headers to fold);
        // from two topics on, headers make the threads DISTINCT (deposit 19/10).
        const header =
          sections.length > 1 ? (
            <button
              aria-expanded={!sectionFolded}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[0.7rem] font-medium text-(--ui-text-secondary) transition-colors hover:text-foreground"
              onClick={() => onToggle?.()}
              title={sectionFolded ? labels.expandThread : labels.collapseThread}
              type="button"
            >
              <sdk.Codicon
                className="shrink-0 text-[0.65rem]"
                name={sectionFolded ? 'chevron-right' : 'chevron-down'}
              />
              <span className="min-w-0 flex-1 truncate">
                {(section.head || labels.threadUntitled).replace(/\s+/g, ' ').slice(0, 70)}
              </span>
              <span className="shrink-0 text-[0.6rem] text-(--ui-text-quaternary)">{section.count}</span>
              {unread > 0 && (
                <span className="shrink-0 rounded-full bg-(--ui-accent) px-1.5 text-[0.6rem] font-medium text-white">
                  {unread}
                </span>
              )}
            </button>
          ) : null

        return (
          <section key={section.threadId}>
            {header}
            {!sectionFolded && (
              <>
                {section.entries.map(event => entry(event))}
                {replyThreadId === section.threadId ? replySlot : null}
                {section.notices.map(event => entry(event))}
              </>
            )}
          </section>
        )
      })}
      {trailing.map(event => entry(event))}
    </>
  )
}