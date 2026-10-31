import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock, createGroupGateway } = await import('./group-test-utils')
  const base = await pluginSdkMock(createGroupGateway().host)
  const { en } = await import('@/i18n/en')
  const { CANONICAL_GROUP_LOCALES } = await import('./canonical-group-locales')

  const Clickable = (p: ComponentProps<'button'>) => <button {...p} />
  const Panel = ({ children }: { children?: ReactNode }) => <div>{children}</div>

  return {
    ...base,
    Button: Clickable,
    RowButton: Clickable,
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    Codicon: ({ name }: { name?: string }) => <span data-icon={name ?? ''} />,
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
    DialogContent: Panel,
    DialogDescription: Panel,
    DialogFooter: Panel,
    DialogHeader: Panel,
    DialogTitle: Panel,
    useI18n: () => ({ t: en }),
    usePluginI18n: () => (key: string) =>
      CANONICAL_GROUP_LOCALES.en[key.replace('canonical.', '') as keyof typeof CANONICAL_GROUP_LOCALES.en] ?? key,
    host: { ...base.host, requestProfile: request }
  }
})

import { CanonicalGroupMembers } from './canonical-group-members'

const binding = { connectionId: 'local', profile: 'team', roomId: 'room-1' }

const roomMembers = [
  { member_id: 'ops', profile: 'ops', handle: 'ops', display_name: 'Ops Bot' },
  { member_id: 'scout', profile: 'scout', handle: 'scout' }
]

const ariaChecked = () => screen.getAllByRole('checkbox').map(row => row.getAttribute('aria-checked'))

const notified = async () => {
  const { host } = await import('@hermes/plugin-sdk')

  return (host as unknown as { notify: ReturnType<typeof vi.fn> }).notify.mock.calls
}

const seatable = ['p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17']

beforeEach(() => {
  request.mockReset()
})

afterEach(() => {
  cleanup()
})

it('lists stored seats pre-checked plus seatable candidates and saves the mapped roster once', async () => {
  request.mockImplementation(async (_route, method, params) =>
    method === 'groups.capabilities'
      ? { seatable_profiles: ['writer', 'scout'] }
      : method === 'groups.update_members'
        ? { room: { room_id: params.room_id, members: params.members } }
        : {}
  )
  const onClose = vi.fn()
  render(<CanonicalGroupMembers binding={binding} members={roomMembers} onClose={onClose} open />)

  await screen.findByTestId('canonical-group-member:ops')
  expect(ariaChecked()).toEqual(['true', 'true', 'false'])
  expect(screen.getByText('Ops Bot')).toBeTruthy()
  expect(screen.getByTestId('canonical-group-member:writer')).toBeTruthy()
  expect(screen.getByText('Pick 2–16 members for this group. The group and its history stay as they are.')).toBeTruthy()

  // Unchecking a stored seat keeps its ghost row listed, so a save can never
  // silently drop it; re-checking restores the exact pre-open picks.
  fireEvent.click(screen.getByTestId('canonical-group-member:scout'))
  expect(ariaChecked()).toEqual(['true', 'false', 'false'])
  expect(screen.getByTestId('canonical-group-member:scout')).toBeTruthy()
  fireEvent.click(screen.getByTestId('canonical-group-member:scout'))
  expect(ariaChecked()).toEqual(['true', 'true', 'false'])

  fireEvent.click(screen.getByRole('button', { name: 'Save members' }))

  await waitFor(() => expect(request.mock.calls.some(call => call[1] === 'groups.update_members')).toBe(true))
  const [route, method, params] = request.mock.calls.find(call => call[1] === 'groups.update_members')!
  expect(method).toBe('groups.update_members')
  expect(route).toMatchObject({ connectionId: binding.connectionId, profile: binding.profile, targetProfile: binding.profile })
  expect(params.room_id).toBe(binding.roomId)
  expect(params.profile).toBe(binding.profile)
  expect(params.members).toEqual([
    {
      member_id: 'ops',
      profile: 'ops',
      handle: 'ops',
      display_name: 'Ops Bot',
      target: { kind: 'local', profile: 'ops' }
    },
    { member_id: 'scout', profile: 'scout', handle: 'scout', target: { kind: 'local', profile: 'scout' } }
  ])
  expect(onClose).toHaveBeenCalled()
  expect(await notified()).toHaveLength(0)
})

it('stops allowing new seats at the fork member cap and saves nothing past it', async () => {
  request.mockImplementation(async (_route, method) =>
    method === 'groups.capabilities' ? { seatable_profiles: seatable } : {}
  )
  render(<CanonicalGroupMembers binding={binding} members={roomMembers} open />)

  await screen.findByTestId('canonical-group-member:p17')
  expect(screen.getAllByRole('checkbox')).toHaveLength(17)

  // Two seats come checked from the room; the picker accepts new seats until it
  // reaches 16 (GROUP_CHAT_MAX_MEMBERS, fork canon), then the next row locks.
  for (const key of seatable.slice(0, 14)) {
    fireEvent.click(screen.getByTestId(`canonical-group-member:${key}`))
  }

  expect(ariaChecked().filter(checked => checked === 'true')).toHaveLength(16)
  const last = screen.getByTestId('canonical-group-member:p17') as HTMLButtonElement
  expect(last.getAttribute('aria-checked')).toBe('false')
  expect(last.disabled).toBe(true)
})

it('pre-checks exactly the room roster on every open and saves nothing on cancel', async () => {
  request.mockImplementation(async (_route, method) =>
    method === 'groups.update_members'
      ? { room: { room_id: 'room-1', members: [] } }
      : { seatable_profiles: ['writer'] }
  )
  const onClose = vi.fn()
  const view = render(<CanonicalGroupMembers binding={binding} members={roomMembers} onClose={onClose} open={false} />)
  expect(screen.queryByTestId('canonical-group-member-picker')).toBeNull()
  expect(request).not.toHaveBeenCalled()
  view.rerender(<CanonicalGroupMembers binding={binding} members={roomMembers} onClose={onClose} open />)

  await screen.findByTestId('canonical-group-member:writer')
  expect(ariaChecked()).toEqual(['true', 'true', 'false'])

  fireEvent.click(screen.getByTestId('canonical-group-member:scout'))
  fireEvent.click(screen.getByTestId('canonical-group-member:writer'))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalled()
  expect(request.mock.calls.some(call => call[1] === 'groups.update_members')).toBe(false)

  // Reopening re-seeds from the room's roster, not from the previous picks.
  view.rerender(<CanonicalGroupMembers binding={binding} members={roomMembers} onClose={onClose} open={false} />)
  view.rerender(<CanonicalGroupMembers binding={binding} members={roomMembers} onClose={onClose} open />)
  await screen.findByTestId('canonical-group-member:writer')
  expect(ariaChecked()).toEqual(['true', 'true', 'false'])
})

it('reports save failures through host.notify and keeps the dialog open', async () => {
  const host = (await import('@hermes/plugin-sdk')).host as unknown as { notify: ReturnType<typeof vi.fn> }
  host.notify.mockClear()
  request.mockImplementation(async (_route, method) =>
    method === 'groups.capabilities'
      ? { seatable_profiles: [] }
      : method === 'groups.update_members'
        ? Promise.reject(new Error('stale authority'))
        : {}
  )
  const onClose = vi.fn()
  render(<CanonicalGroupMembers binding={binding} members={roomMembers} onClose={onClose} open />)

  await screen.findByTestId('canonical-group-member:ops')
  fireEvent.click(screen.getByRole('button', { name: 'Save members' }))

  await waitFor(() => expect(host.notify.mock.calls).toHaveLength(1))
  expect(String(host.notify.mock.calls[0]?.[0]?.message)).toContain('stale authority')
  expect(onClose).not.toHaveBeenCalled()
})