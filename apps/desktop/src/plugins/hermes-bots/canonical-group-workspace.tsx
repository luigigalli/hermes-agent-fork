import { Button, Codicon, Textarea, useValue } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { CanonicalGroupAttachments } from './canonical-group-attachments'
import { type CanonicalGroupEvent, CanonicalGroupHistory } from './canonical-group-history'
import { useCanonicalGroupLabels } from './canonical-group-labels'
import { CanonicalGroupLegacyHistory } from './canonical-group-legacy-history'
import { prepareCanonicalGroupSend, readCanonicalGroupSend, retireCanonicalGroupSend } from './canonical-group-send'
import type { PreparedCanonicalGroupSend } from './canonical-group-send'
import { canonicalThreadUnread, groupMessageSections } from './canonical-group-threads'
import { actCanonicalGroup, canonicalGroupRequest } from './canonical-groups'
import type {
  CanonicalGroupBinding,
  CanonicalPendingAction,
  CanonicalRoom,
  CanonicalRoomMember
} from './canonical-groups'
import { $groupChats } from './group-chat'
import { $groupThreadReads, markGroupThreadRead } from './group-thread-pane'

type RoomEvent = CanonicalGroupEvent
interface Attachment {
  attachment_id?: string
  event_id?: string
  kind: string
  name: string
  mime: string
  size?: number
}
interface RoomState {
  room: CanonicalRoom
  driver_status?: { pending_actions?: CanonicalPendingAction[] }
}

const sameGroupPayload = (payload: Record<string, unknown>, text: string, attachments: Attachment[]) =>
  payload.text === text && JSON.stringify(payload.attachments ?? []) === JSON.stringify(attachments)

function CanonicalGroupRoster({ members = [], label }: { members?: CanonicalRoomMember[]; label: string }) {
  if (!members.length) {
    return null
  }

  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-2 text-xs text-(--ui-text-tertiary)">
      {members.map(member => (
        <li key={member.member_id}>{member.display_name || member.handle || member.member_id}</li>
      ))}
    </ul>
  )
}

export function CanonicalGroupWorkspace({
  binding,
  visible = true,
  onBack
}: {
  binding: CanonicalGroupBinding
  visible?: boolean
  onBack?: () => void
}) {
  // Remount on identity changes: old polls and pending confirmations never cross rooms.
  return (
    <CanonicalRoomView
      binding={binding}
      key={JSON.stringify([binding.connectionId, binding.profile, binding.roomId])}
      onBack={onBack}
      visible={visible}
    />
  )
}

function CanonicalRoomView({
  binding: initialBinding,
  visible,
  onBack
}: {
  binding: CanonicalGroupBinding
  visible: boolean
  onBack?: () => void
}) {
  const [binding] = useState(() => ({ ...initialBinding }))
  const labels = useCanonicalGroupLabels()
  const [state, setState] = useState<RoomState | null>(null)
  const [events, setEvents] = useState<RoomEvent[]>([])
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [restored, setRestored] = useState(false)
  const [pending, setPending] = useState<PreparedCanonicalGroupSend | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const [discard, setDiscard] = useState<CanonicalPendingAction | null>(null)
  const revision = useRef(0)
  // This window's typed draft while it sends the room's one pending intent another window prepared.
  const heldDraft = useRef<{ text: string; attachments: Attachment[] } | null>(null)

  // Thread view state (fork UX on the canonical workspace, deposit-spec 19/10):
  // folding is a VIEW affordance only — the log is never mutated, re-dated or
  // reordered by any of it.
  const [threadPaneOpen, setThreadPaneOpen] = useState(false)
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null)
  const [manualFolds, setManualFolds] = useState<ReadonlySet<string>>(() => new Set())
  const [newThreadCreator, setNewThreadCreator] = useState<string | null>(null)
  const [newThreadDraft, setNewThreadDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const threadReads = useValue($groupThreadReads)
  // The room's archived past, read-only (durable renderer copy + the mirror
  // the sync engine unions into it). Read access only — this view never
  // writes the store (projection contract, t_97e2e058).
  const archiveRooms = useValue($groupChats)

  const roomKey = binding.roomId
  const roomName = state?.room.name || binding.roomName || ''
  const sections = useMemo(() => groupMessageSections(events as CanonicalGroupEvent[]), [events])

  const unreadByThread = useMemo(() => {
    const reads = threadReads?.[roomKey] || {}
    const out: Record<string, number> = {}

    for (const section of sections) {
      out[section.threadId] = canonicalThreadUnread(reads[section.threadId], section)
    }

    return out
  }, [sections, threadReads, roomKey])

  const focusMode = threadPaneOpen || focusThreadId !== null

  const foldedThreadIds = useMemo<ReadonlySet<string>>(() => {
    // Focus mode: the chosen topic unfolds, everything else folds to its
    // header; a pane open without a chosen topic folds the WHOLE room (the
    // index is about to pick one). Whole-log mode keeps the manual folds.
    if (focusThreadId !== null) {
      return new Set(sections.map(section => section.threadId).filter(threadId => threadId !== focusThreadId))
    }

    if (threadPaneOpen) {
      return new Set(sections.map(section => section.threadId))
    }

    return manualFolds
  }, [focusThreadId, manualFolds, sections, threadPaneOpen])

  const unreadTotal = Object.values(unreadByThread).reduce((sum, count) => sum + count, 0)

  // eslint-disable-next-line no-restricted-syntax -- journal hydration and mounted lifetime, not a reactive store mirror
  useEffect(() => {
    alive.current = true
    let cancelled = false
    void readCanonicalGroupSend(binding)
      .then(entry => {
        if (cancelled) {
          return
        }

        if (entry) {
          setPending(entry)
          setDraft(String(entry.params.payload.text ?? ''))
          setAttachments((entry.params.payload.attachments as Attachment[] | undefined) ?? [])
        }

        setRestored(true)
      })
      .catch(e => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })

    return () => {
      cancelled = true
      alive.current = false
      revision.current++
    }
  }, [binding])

  const refresh = async () => {
    const version = ++revision.current
    const snapshot = await canonicalGroupRequest<RoomState>(binding, 'groups.state', { room_id: binding.roomId })
    const log: RoomEvent[] = []
    let cursor = 0

    for (;;) {
      const page = await canonicalGroupRequest<{ events: RoomEvent[]; has_more?: boolean; next_seq?: number }>(
        binding,
        'groups.log',
        { room_id: binding.roomId, since_seq: cursor, limit: 100 }
      )

      log.push(...page.events)

      if (!page.has_more) {
        break
      }

      const next = page.events.at(-1)?.seq

      if (!next || next <= cursor) {
        throw new Error(labels.invalidLogCursor)
      }

      cursor = next
    }

    if (alive.current && version === revision.current) {
      setState(snapshot)
      setEvents(log)
      setReadError('')
    }
  }

  useEffect(() => {
    if (!visible) {
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        await refresh()
      } catch (e) {
        if (!cancelled) {
          setReadError(String(e instanceof Error ? e.message : e))
        }
      }

      if (!cancelled) {
        timer = setTimeout(() => void poll(), 2000)
      }
    }

    void poll()

    return () => {
      cancelled = true
      revision.current++
      clearTimeout(timer)
    }
    // The keyed parent freezes the authority binding for this lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const mutate = async (operation: () => Promise<unknown>) => {
    if (busyRef.current) {
      return
    }

    busyRef.current = true
    setBusy(true)
    setError('')

    try {
      await operation()

      if (alive.current) {
        await refresh()
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      busyRef.current = false

      if (alive.current) {
        setBusy(false)
      }
    }
  }

  const send = () => {
    if (
      !restored ||
      busyRef.current ||
      uploading ||
      !state?.driver_status ||
      (!pending && !draft.trim() && !attachments.length)
    ) {
      return
    }

    void mutate(async () => {
      const exact = pending ?? (await prepareCanonicalGroupSend(binding, { text: draft, attachments }))

      if (!alive.current) {
        return
      }

      // Another window won the room's slot: send its intent first, keep this window's words.
      if (!pending && !sameGroupPayload(exact.params.payload, draft, attachments)) {
        heldDraft.current = { text: draft, attachments }
      }

      setPending(exact)
      setDraft(String(exact.params.payload.text ?? ''))
      setAttachments((exact.params.payload.attachments as Attachment[] | undefined) ?? [])
      await canonicalGroupRequest(exact.binding, 'groups.send', exact.params)
      await retireCanonicalGroupSend(exact.binding, exact.params.event_id)

      if (alive.current) {
        const held = heldDraft.current
        heldDraft.current = null
        setPending(null)
        setDraft(held?.text ?? '')
        setAttachments(held?.attachments ?? [])
      }
    })
  }

  /** One explicit-thread send (New Thread mint, reply-in-thread). The room keeps
   *  ONE unresolved intent; when the journal slot holds another window's
   *  intent, this send refuses and points at restoring it — exact words are
   *  authoritative, never silently replaced by a different thread's text. */
  const threadSend = (text: string, threadId: string, onDone?: () => void) => {
    const body = text.trim()
    const started = Boolean(body) && restored

    if (!started || busyRef.current || uploading || !state?.driver_status || !threadId) {
      return
    }

    void mutate(async () => {
      if (pending) {
        throw new Error(labels.unconfirmedSend)
      }

      const exact = await prepareCanonicalGroupSend(binding, { text: body, thread_id: threadId })

      if (exact.params.payload.thread_id !== threadId || exact.params.payload.text !== body) {
        throw new Error(labels.unconfirmedSend)
      }

      await canonicalGroupRequest(exact.binding, 'groups.send', exact.params)
      await retireCanonicalGroupSend(exact.binding, exact.params.event_id)
      onDone?.()
    })
  }

  const act = (action: CanonicalPendingAction, choice?: 'once' | 'deny') =>
    mutate(() => actCanonicalGroup(binding, action, choice))

  // --- thread view affordances -------------------------------------------------

  const markThreadRead = (threadId: string) => markGroupThreadRead(roomKey, threadId, Date.now())

  const toggleThreadPane = () => {
    // Leaving the pane returns the room to the whole-log flow; the first open
    // folds everything until a topic is picked (whole-log mode ends).
    setFocusThreadId(null)
    setThreadPaneOpen(!threadPaneOpen)
  }

  const openThread = (threadId: string) => {
    setFocusThreadId(threadId)
    markThreadRead(threadId)
  }

  // Focus mode's header click = open that topic; whole-log's = manual fold.
  const toggleThread = (threadId: string) => {
    if (focusThreadId !== null) {
      openThread(threadId)

      return
    }

    setManualFolds(prev => {
      const next = new Set(prev)

      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }

      return next
    })
  }

  const startNewThread = () => {
    // Mint at reveal: the id is stable across re-renders and retry of the same
    // composer, so a slow send can never change the topic it opened.
    setNewThreadCreator(crypto.randomUUID())
    setNewThreadDraft('')
  }

  const submitNewThread = () => {
    const threadId = newThreadCreator

    if (!threadId) {
      return
    }

    threadSend(newThreadDraft, threadId, () => {
      setNewThreadCreator(null)
      setNewThreadDraft('')
      setThreadPaneOpen(false)
      setFocusThreadId(threadId)
      markThreadRead(threadId)
    })
  }

  const replyThreadId = newThreadCreator ? null : focusThreadId

  const replySlot = (
    <form
      className="grid gap-1 px-2 pb-1"
      onSubmit={event => {
        event.preventDefault()
        const threadId = replyThreadId

        if (!threadId) {
          return
        }

        threadSend(replyDrafts[threadId] || '', threadId, () => {
          setReplyDrafts(prev => ({ ...prev, [threadId]: '' }))
          markThreadRead(threadId)
        })
      }}
    >
      <Textarea
        aria-label={labels.replyInThread}
        autoFocus
        className="min-w-0 flex-1"
        disabled={!restored || busy || uploading || !state?.driver_status}
        onChange={e => setReplyDrafts(prev => ({ ...prev, [replyThreadId ?? '']: e.target.value }))}
        value={(replyThreadId && replyDrafts[replyThreadId]) || ''}
      />
      <Button disabled={!restored || busy || uploading || !state?.driver_status} size="sm" type="submit">
        {labels.send}
      </Button>
    </form>
  )

  const composerLocked = !restored || busy || !!pending

  const threadIndex = sections.length ? (
    <div className="border-b border-(--ui-stroke-secondary)">
      <button
        aria-controls={`canonical-threads:${binding.roomId}`}
        aria-expanded={threadPaneOpen}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[0.7rem] text-(--ui-text-quaternary) transition-colors hover:text-foreground"
        onClick={toggleThreadPane}
        type="button"
      >
        <Codicon className="shrink-0 text-[0.65rem]" name={threadPaneOpen ? 'chevron-down' : 'chevron-right'} />
        <span className="truncate">{threadPaneOpen ? labels.hideThreads : labels.showThreads}</span>
        {unreadTotal > 0 && (
          <span className="shrink-0 rounded-full bg-(--ui-accent) px-1.5 text-[0.6rem] font-medium text-white">
            {unreadTotal}
          </span>
        )}
        <span className="shrink-0 text-[0.625rem] text-(--ui-text-quaternary)">{sections.length}</span>
      </button>
      {threadPaneOpen && (
        <div
          aria-label={labels.showThreads}
          className="grid gap-0.5 px-2.5 pb-1.5"
          id={`canonical-threads:${binding.roomId}`}
        >
          {sections.map(section => (
            <button
              className="flex w-full items-center gap-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-left text-xs text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground"
              key={section.threadId}
              onClick={() => openThread(section.threadId)}
              title={labels.openThread}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">
                {(section.head || labels.threadUntitled).replace(/\s+/g, ' ').slice(0, 70)}
              </span>
              <span className="shrink-0 text-[0.6rem] text-(--ui-text-quaternary)">{section.count}</span>
              {(unreadByThread[section.threadId] || 0) > 0 && (
                <span className="shrink-0 rounded-full bg-(--ui-accent) px-1.5 text-[0.6rem] font-medium text-white">
                  {unreadByThread[section.threadId]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  ) : null

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        {onBack && <Button onClick={onBack}>{labels.back}</Button>}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-medium">{state?.room.name || labels.loadingGroup}</h2>
            <span className="shrink-0 rounded-full border border-(--ui-stroke-secondary) px-1.5 text-[0.6rem] text-(--ui-text-tertiary)">
              {labels.roomKindGateway}
            </span>
          </div>
          <CanonicalGroupRoster label={labels.members} members={state?.room.members} />
        </div>
        <Button
          disabled={busy || !state?.driver_status}
          onClick={() =>
            void mutate(() =>
              canonicalGroupRequest(binding, 'groups.stop', { room_id: binding.roomId, cancel_id: crypto.randomUUID() })
            )
          }
        >
          {labels.stop}
        </Button>
      </header>
      {readError && (
        <div role="alert">
          {readError}
          <Button onClick={() => void refresh().catch(e => setReadError(String(e)))}>{labels.refresh}</Button>
        </div>
      )}
      {error && <div role="alert">{error}</div>}
      {state && !state.driver_status && <p>{labels.driverUnavailable}</p>}
      <CanonicalGroupLegacyHistory room={roomName ? archiveRooms[roomName] : undefined} />
      {threadIndex}
      {newThreadCreator && (
        <form
          className="grid gap-1 border-b border-(--ui-stroke-secondary) p-2"
          data-testid="group-new-thread-creator"
          onSubmit={event => {
            event.preventDefault()
            submitNewThread()
          }}
        >
          <Textarea
            aria-label={labels.newThread}
            autoFocus
            className="min-w-0 flex-1"
            disabled={!restored || busy || uploading || !state?.driver_status}
            onChange={e => setNewThreadDraft(e.target.value)}
            placeholder={labels.newThreadPlaceholder}
            value={newThreadDraft}
          />
          <div className="flex items-center gap-2">
            <Button
              disabled={!restored || busy || uploading || !newThreadDraft.trim() || !state?.driver_status}
              size="sm"
              type="submit"
            >
              {labels.send}
            </Button>
            <Button onClick={() => setNewThreadCreator(null)} size="sm">
              {labels.cancel}
            </Button>
          </div>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-auto" role="log">
        <CanonicalGroupHistory
          binding={binding}
          disabled={!visible}
          events={events}
          members={state?.room.members}
          threadView={{
            foldedThreadIds,
            onToggleThread: toggleThread,
            replySlot,
            replyThreadId,
            unreadByThread
          }}
        />
      </div>
      {(state?.driver_status?.pending_actions || []).map(action => (
        <div
          className="flex items-center gap-2"
          key={`${action.kind}:${action.task_id}:${action.execution_generation}`}
        >
          <span>{action.member_id}</span>
          {action.kind === 'discard' && (
            <Button disabled={busy} onClick={() => setDiscard({ ...action })}>
              {labels.discard}
            </Button>
          )}
          {action.kind === 'retry' && (
            <Button disabled={busy} onClick={() => void act({ ...action })}>
              {labels.retry}
            </Button>
          )}
          {action.kind === 'approval' && (
            <>
              <Button disabled={busy} onClick={() => void act({ ...action }, 'once')}>
                {labels.allowOnce}
              </Button>
              <Button disabled={busy} onClick={() => void act({ ...action }, 'deny')}>
                {labels.deny}
              </Button>
            </>
          )}
        </div>
      ))}
      {discard && (
        <div aria-label={labels.discardUnknown} role="alertdialog">
          <p>{labels.discardWarning}</p>
          <Button
            disabled={busy}
            onClick={() => {
              const exact = discard
              setDiscard(null)
              void act(exact)
            }}
          >
            {labels.confirmDiscard}
          </Button>
          <Button onClick={() => setDiscard(null)}>{labels.cancel}</Button>
        </div>
      )}
      {pending && <p role="status">{labels.restoredPendingSend}</p>}
      {focusMode ? (
        // A live composer rides the open thread's flow in the timeline; the
        // bottom bar stays the New Thread LAUNCHER, never a live composer.
        <div className="border-t border-(--ui-stroke-secondary) p-2">
          <Button onClick={startNewThread}>{labels.newThread}</Button>
        </div>
      ) : (
        <form
          className="flex items-end gap-2"
          onSubmit={event => {
            event.preventDefault()
            send()
          }}
        >
          <CanonicalGroupAttachments
            attachments={attachments}
            binding={binding}
            disabled={composerLocked}
            onChange={setAttachments}
            onUploadingChange={setUploading}
          />
          <Textarea
            aria-label={labels.groupMessage}
            className="min-w-0 flex-1"
            disabled={composerLocked}
            onChange={e => setDraft(e.target.value)}
            value={draft}
          />
          <Button
            className="shrink-0"
            disabled={
              !restored ||
              busy ||
              uploading ||
              (!pending && !draft.trim() && !attachments.length) ||
              !state?.driver_status
            }
            type="submit"
          >
            {pending ? labels.retry : labels.send}
          </Button>
          <Button className="shrink-0" onClick={startNewThread} type="button">
            {labels.newThread}
          </Button>
        </form>
      )}
    </section>
  )
}
