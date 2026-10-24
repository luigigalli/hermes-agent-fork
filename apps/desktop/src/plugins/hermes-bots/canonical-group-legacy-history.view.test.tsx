import type * as HermesSdk from '@hermes/plugin-sdk'
import { host } from '@hermes/plugin-sdk'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WritableAtom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CanonicalGroupLegacyHistory } from './canonical-group-legacy-history'
import { $groupChats } from './group-chat'
import { $groupThreadReads } from './group-thread-pane'
import { GroupChatWorkspace } from './group-chat-view'
import { translateBots } from './i18n-test-helper'

// The projection contract (t_97e2e058): the pane is a READ-ONLY projection —
// collapse/expand is view state only, nothing marked read, nothing written to
// the durable store. The i18n comes from the plugin's real English bundle
// (translateBots), so a hard-coded English literal in the view cannot pass.
const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()
  const { en } = await import('@/i18n/en')

  return {
    ...sdk,
    gatewayActivationEpoch: () => 1,
    host: {
      ...sdk.host,
      requestProfile: request,
      notify: vi.fn(),
      request: (method: string, params?: Record<string, unknown>) => request(null, method, params),
      connections: vi.fn(async () => []),
      state: {
        ...sdk.host.state,
        connectionId: sdk.atom<string | null>('local'),
        profile: sdk.atom('default'),
        gateway: sdk.atom('open')
      }
    },
    useI18n: () => ({ locale: 'en', t: en as unknown as Record<string, unknown> }),
    usePluginI18n: () => translateBots
  }
})

const state = {
  connectionId: host.state.connectionId as WritableAtom<string | null>,
  profile: host.state.profile as WritableAtom<string>,
  gateway: host.state.gateway as WritableAtom<string>
}

const roster = [{ name: 'alpha', connectionId: 'local' }]
const members = roster.map(m => ({ member_id: m.name, profile: m.name, handle: m.name }))
const t0 = 1_700_000_000_000
const archived = {
  epoch: 0,
  log: [
    { at: t0, from: { kind: 'user' as const, name: 'You' }, text: 'Kick off build' },
    { at: t0 + 90_000, from: { kind: 'member' as const, name: 'Merk' }, text: 'Halfway through' },
    { at: t0 + 17 * 60_000, from: { kind: 'user' as const, name: 'You' }, text: 'Next topic' }
  ],
  running: false,
  watermarks: {}
}

beforeEach(() => {
  $groupChats.set({ Team: archived })
  $groupThreadReads.set({})
  state.connectionId.set('local')
  state.profile.set('default')
  state.gateway.set('open')
  request.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

const durableSnapshot = () => JSON.stringify($groupChats.get())

it('the pane is collapsed by default; expanding shows the archived threads without a single write', () => {
  const view = render(<CanonicalGroupLegacyHistory room={archived} />)

  const before = durableSnapshot()
  const readsBefore = JSON.stringify($groupThreadReads.get())
  expect(view.container.textContent).toContain('Past threads (read-only)')
  // Collapsed: no archived message text yet.
  expect(document.body.textContent).not.toContain('Kick off build')

  fireEvent.click(screen.getByRole('button', { name: /Past threads \(read-only\)/ }))
  // The index lists threads newest-activity first; entries wait for a row click.
  expect(document.body.textContent).toContain('Next topic')
  expect(document.body.textContent).toContain('Read-only projection')

  fireEvent.click(screen.getByText('Kick off build'))
  expect(document.body.textContent).toContain('Halfway through')

  // The fold invariant pinned on the DATA (view-testing recipe): the durable
  // log and the read watermarks are identical after every interaction.
  expect(durableSnapshot()).toBe(before)
  expect(JSON.stringify($groupThreadReads.get())).toBe(readsBefore)
})

it('a room with no local archive shows the honest absence note only when asked to', () => {
  const withNote = render(<CanonicalGroupLegacyHistory room={undefined} showWhenEmpty />)

  expect(withNote.container.textContent).toContain("This room's archived history is not in")
  cleanup()
  expect(render(<CanonicalGroupLegacyHistory room={undefined} />).container.firstChild).toBeNull()
})

it('the legacy-room gate shows the archive above the Start action, copy from the bundle', async () => {
  gateway()
  await act(async () => {
    render(<GroupChatWorkspace group="Team" members={roster} />)
  })

  expect(screen.getByRole('button', { name: 'Start gateway group' })).toBeTruthy()
  expect(document.body.textContent).toContain('Legacy Desktop room')
  expect(document.body.textContent).toContain('shown read-only above')
  // The archived pane rides the room's durable record, collapsed by default.
  expect(screen.getByRole('button', { name: /Past threads \(read-only\)/ })).toBeTruthy()
})

it('a restored canonical key on a missing room does not pretend the archive pane is there', async () => {
  gateway()
  await act(async () => {
    render(<GroupChatWorkspace group="canonical:local:default:gone" members={roster} origin="key" />)
  })

  expect(screen.getByRole('button', { name: 'Start gateway group' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Past threads \(read-only\)/ })).toBeNull()
})

function gateway() {
  request.mockImplementation(async (_route, method, params) => {
    if (method === 'groups.capabilities') {
      return { driver: true, persistent_process: true }
    }

    if (method === 'groups.list') {
      return { rooms: [{ room_id: 'other', name: 'Elsewhere', members }], next_offset: null }
    }

    if (method === 'groups.state') {
      return { room: { room_id: 'gone', name: String(params?.room_id), members }, driver_status: {} }
    }

    if (method === 'groups.log') {
      return { events: [] }
    }

    throw new Error(`Unexpected RPC: ${method}`)
  })
}
