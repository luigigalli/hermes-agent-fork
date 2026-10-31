/**
 * Member editing for an EXISTING canonical (gateway-native) group room: the
 * room-side "Manage members" picker's canonical twin. Same checklist
 * mechanics as the legacy `GroupMemberPicker` — pre-checked stored seats,
 * ghost rows that stay listed, 2–16 seats, nothing written until Save — but
 * candidates come from the canonical boundary (`groups.capabilities`
 * `seatable_profiles` plus the room's stored roster) and Save dispatches
 * `groups.update_members` through `updateCanonicalGroupMembers` instead of
 * touching the legacy `$botMeta`/`$groupChats` metadata.
 */

import {
  Button,
  cn,
  Codicon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  host,
  RowButton
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'

import { useCanonicalGroupLabels } from './canonical-group-labels'
import { canonicalGroupRequest, updateCanonicalGroupMembers } from './canonical-groups'
import type { CanonicalGroupBinding, CanonicalRoomMember } from './canonical-groups'
import { GROUP_CHAT_MAX_MEMBERS } from './group-chat'
import type { GroupMember } from './types'

interface CanonicalGroupMembersProps {
  binding: CanonicalGroupBinding
  members?: CanonicalRoomMember[]
  open: boolean
  onClose?: () => void
  /** Called after a successful save so the room view can refresh before the next poll. */
  onSaved?: () => void
}

const seatKey = (member: GroupMember) =>
  (member.route?.targetProfile ?? member.targetProfile ?? member.name).toLowerCase()

export function CanonicalGroupMembers({
  binding,
  members = [],
  onClose,
  onSaved,
  open
}: CanonicalGroupMembersProps) {
  const labels = useCanonicalGroupLabels()

  // Candidates never come from the legacy roster: the seats this caller may
  // seat again (`seatable_profiles`) plus every seat the room already holds.
  // Stored seats stay listed even when their source would drop them — the
  // ghost-row rule the legacy picker established — so a Save can never
  // silently drop an offline member.
  const [seatable, setSeatable] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }

    let alive = true
    canonicalGroupRequest<{ seatable_profiles?: string[] }>(binding, 'groups.capabilities')
      .then(capabilities => {
        if (!alive) {
          return
        }

        setSeatable(Array.isArray(capabilities.seatable_profiles) ? capabilities.seatable_profiles : [])
      })
      .catch(() => {
        // Degrade to the room's stored roster: its seats can still be kept or
        // removed, and the save reports anything the gateway refuses.
        if (alive) {
          setSeatable([])
        }
      })

    return () => {
      alive = false
    }
  }, [binding, open])

  const roster = useMemo(() => {
    const rows: GroupMember[] = []
    const seen = new Set<string>()

    for (const member of members) {
      const profile = member.profile.toLowerCase()

      if (!member.profile?.trim() || seen.has(profile)) {
        continue
      }

      seen.add(profile)
      rows.push({ name: member.profile, handle: member.handle, ...(member.display_name ? { display_name: member.display_name } : {}) })
    }

    for (const profile of seatable) {
      const key = profile.toLowerCase()

      if (key && !seen.has(key)) {
        seen.add(key)
        rows.push({ name: profile, handle: profile })
      }
    }

    return rows
  }, [members, seatable])

  const [selected, setSelected] = useState(() => new Set(members.map(member => member.profile.toLowerCase())))

  // Re-seed from the room only when the dialog opens: `members` is rebuilt on
  // every room poll, so keying on it would wipe the user's picks mid-edit.
  useEffect(() => {
    if (open) {
      setSelected(new Set(members.map(member => member.profile.toLowerCase())))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const atCap = selected.size >= GROUP_CHAT_MAX_MEMBERS

  const save = async () => {
    setSaving(true)

    try {
      await updateCanonicalGroupMembers(
        binding,
        roster.filter(member => selected.has(seatKey(member)))
      )
      onSaved?.()
      onClose?.()
    } catch (error) {
      host.notify({
        kind: 'error',
        message: String(error instanceof Error ? error.message : error)
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={value => !value && onClose?.()} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.manageMembers}</DialogTitle>
          <DialogDescription>
            {labels.pickMembersHint.replace('{n}', String(GROUP_CHAT_MAX_MEMBERS))}
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-80 gap-0.5 overflow-y-auto" data-testid="canonical-group-member-picker">
          {roster.map(member => {
            const key = seatKey(member)
            const checked = selected.has(key)
            const disabled = !checked && atCap

            return (
              <RowButton
                aria-checked={checked}
                className={cn(
                  'flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-(--chrome-action-hover)',
                  disabled && 'cursor-not-allowed opacity-50'
                )}
                data-testid={`canonical-group-member:${key}`}
                disabled={disabled}
                key={key}
                onClick={() =>
                  setSelected(current => {
                    const next = new Set(current)

                    if (checked) {
                      next.delete(key)
                    } else {
                      next.add(key)
                    }

                    return next
                  })
                }
                role="checkbox"
              >
                <Codicon
                  className={cn(checked ? 'text-(--ui-accent)' : 'text-(--ui-text-quaternary)')}
                  name={checked ? 'pass-filled' : 'circle-large-outline'}
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="truncate text-xs text-foreground">{member.display_name || member.name}</div>
                  <div className="truncate text-[0.625rem] text-(--ui-text-quaternary)">{`@${member.handle ?? member.name}`}</div>
                </div>
              </RowButton>
            )
          })}
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="secondary">
            {labels.cancel}
          </Button>
          <Button
            disabled={saving || selected.size < 2 || selected.size > GROUP_CHAT_MAX_MEMBERS}
            onClick={() => void save()}
          >
            {labels.saveMembers}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}