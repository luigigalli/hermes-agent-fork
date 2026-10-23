import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

// Fork thread UX re-landed on the canonical workspace (deposit-spec 19/10):
// the New Thread composer must not blend its message into an open thread's
// flow, the timeline must keep THREADS DISTINCT (grouped under per-thread
// headers; the Show threads index ordered by CREATION) and folding must never
// delete, re-date or reorder what was said. The threads themselves are the
// canonical protocol's own `thread_id` payloads (each desktop send mints one,
// the discussion driver stamps member replies).
const request = vi.hoisted(() => vi.fn())
vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock, createGroupGateway } = await import('./group-test-utils')
  const { en } = await import('@/i18n/en')
  const { CANONICAL_GROUP_LOCALES } = await import('./canonical-group-locales')
  const base = await pluginSdkMock((createGroupGateway().host as Record<string, unknown>) || {})

  return {
    ...base,
    MessageTextContent: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
    useI18n: () => ({ locale: 'en', t: en }),
    usePluginI18n: () => (key: string) =>
      CANONICAL_GROUP_LOCALES.en[key.replace('canonical.', '') as keyof typeof CANONICAL_GROUP_LOCALES.en] ?? key,
    Button: (props: ComponentProps<'button'>) => <button {...props} />,
    Codicon: ({ name }: { name: string }) => <span data-icon={name} />,
    relativeTime: () => 'now',
    host: { ...base.host, requestProfile: request }
  }
})

import { CanonicalGroupWorkspace } from './canonical-group-workspace'

const binding = { connectionId: 'local', profile: 'team', roomId: 'threads-room' }

interface LogEvent {
  created_at: number
  event_id?: string
  kind: string
  payload: Record<string, unknown>
  seq: number
}

const twoThreadLog: LogEvent[] = [
  { created_at: 1, event_id: 'u1', kind: 'message.user', payload: { text: 'Build request', thread_id: 'a' }, seq: 1 },
  { created_at: 2, event_id: 'm1', kind: 'message.member', payload: { text: 'Build done', thread_id: 'a' }, seq: 2 },
  { created_at: 3, event_id: 'u2', kind: 'message.user', payload: { text: 'Release request', thread_id: 'b' }, seq: 3 },
  { created_at: 4, event_id: 'm2', kind: 'message.member', payload: { text: 'Release done', thread_id: 'b' }, seq: 4 }
]

function journalMock(logStore: { log: LogEvent[] }) {
  request.mockImplementation(async (_route: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'groups.state') {
      return { driver_status: {}, room: { members: [], name: 'Room' } }
    }

    if (method === 'groups.log') {
      return { events: logStore.log, has_more: false }
    }

    if (method === 'groups.send') {
      const payload = params.payload as { text: string; thread_id: string }

      logStore.log = [
        ...logStore.log,
        {
          created_at: 5,
          event_id: params.event_id as string,
          kind: 'message.user',
          payload: { text: payload.text, thread_id: payload.thread_id },
          seq: 5
        }
      ]

      return { accepted: true }
    }

    if (method === 'groups.stop') {
      return { cancelled: 0 }
    }

    return {}
  })
}

function renderRoom(logStore: { log: LogEvent[] }) {
  journalMock(logStore)
  Element.prototype.scrollIntoView = vi.fn()

  return render(<CanonicalGroupWorkspace binding={binding} />)
}

afterEach(() => {
  cleanup()
  request.mockReset()
  localStorage.clear()
})

it('renders the whole-log flow with every thread visible and its header distinct', async () => {
  const logStore = { log: [...twoThreadLog] }
  renderRoom(logStore)

  // No active topic yet: both topics' flows render under their own headers.
  const log = await screen.findByRole('log', {}, { timeout: 2000 })

  expect(within(log).getByText('Build done')).toBeTruthy()
  expect(within(log).getByText('Release done')).toBeTruthy()
  // The workspace is ready once the composer unlocks (state + journal read in).
  await waitFor(() => expect((screen.getByLabelText('Group message') as HTMLTextAreaElement).disabled).toBe(false))
})

it('a New Thread send starts and opens its own thread instead of blending into the open thread flow', async () => {
  const logStore = { log: [...twoThreadLog] }
  renderRoom(logStore)

  await waitFor(() => expect((screen.getByLabelText('Group message') as HTMLTextAreaElement).disabled).toBe(false))

  // The bottom bar is the New Thread LAUNCHER, never a live composer: the
  // launcher reveals the dedicated composer ABOVE the timeline.
  expect(screen.queryByTestId('group-new-thread-creator')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'New Thread' }))

  const creator = screen.getByTestId('group-new-thread-creator')

  expect(creator).toBeTruthy()

  // Type and submit for real: the minted thread becomes the active reply
  // thread with its own composer; the reveal closes.
  fireEvent.change(screen.getByLabelText('New Thread'), { target: { value: 'fresh topic' } })
  fireEvent.submit(creator)

  await screen.findByLabelText('Reply in thread')

  // Reveal closed; the entry is on screen — the per-thread header AND the
  // entry body both carry the topic text, so accept any of the nodes.
  expect(screen.queryByTestId('group-new-thread-creator')).toBeNull()
  await waitFor(() => expect(screen.getAllByText('fresh topic')).toBeTruthy())

  const sends = request.mock.calls.filter(call => call[1] === 'groups.send')

  expect(sends).toHaveLength(1)

  // …in its OWN thread, distinct from the open topic, now the ACTIVE thread.
  expect((sends[0][2] as { payload: { thread_id: string } }).payload.thread_id).toBeTruthy()
  expect((sends[0][2] as { payload: { thread_id: string } }).payload.thread_id).not.toBe('b')

  // The previous topic folded (its replies hidden) and only its header remains.
  expect(screen.queryByText('Release done')).toBeNull()
  expect(screen.getByText('Release request')).toBeTruthy()
})

it('the Show threads index lists threads in creation order and folds the timeline to the chosen topic', async () => {
  const logStore = { log: [...twoThreadLog] }
  renderRoom(logStore)

  await waitFor(() => expect((screen.getByLabelText('Group message') as HTMLTextAreaElement).disabled).toBe(false))

  // Index closed: pane rows absent.
  expect(screen.queryAllByTitle('Open this thread')).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: /Show threads/ }))

  // First pane open auto-folds every non-active topic: whole-log mode ends.
  expect(screen.queryByText('Build done')).toBeNull()
  expect(screen.queryByText('Release done')).toBeNull()

  // Index rows in CREATION order (a before b).
  const rows = screen.getAllByTitle('Open this thread')

  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('Build request')
  expect(rows[1].textContent).toContain('Release request')

  // Choosing a topic focusses the timeline on its flow.
  fireEvent.click(rows[0])

  expect(await screen.findByText('Build done')).toBeTruthy()
  expect(screen.queryByText('Release done')).toBeNull()
})

it('collapse is a view affordance: the log keeps every entry, re-dates nothing, loses nothing', async () => {
  const logStore = { log: [...twoThreadLog] }
  renderRoom(logStore)

  await waitFor(() => expect((screen.getByLabelText('Group message') as HTMLTextAreaElement).disabled).toBe(false))

  const before = logStore.log.map(entryData => [
    entryData.payload.text,
    entryData.created_at,
    entryData.payload.thread_id
  ])

  // Fold thread a via its header toggle.
  const header = screen.getAllByRole('button').find(button => button.textContent?.includes('Build request'))

  expect(header).toBeTruthy()
  fireEvent.click(header!)

  expect(screen.queryByText('Build done')).toBeNull()

  // Unfold: the entries are still there, in order.
  const headerAgain = screen.getAllByRole('button').find(button => button.textContent?.includes('Build request'))

  fireEvent.click(headerAgain!)

  expect(await screen.findByText('Build done')).toBeTruthy()

  const after = logStore.log.map(entryData => [
    entryData.payload.text,
    entryData.created_at,
    entryData.payload.thread_id
  ])

  expect(after).toEqual(before)
})
