import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errMsg } from '@/core/validation'
import { ConfirmDialog } from '../components/confirm-dialog'
import { Hint } from '../components/hint'
import { Button } from '../components/ui/button'
import {
  type AdminUser,
  deleteUserApi,
  getCurrentUser,
  listUsers,
  syncPlexUsers,
  updateUserAdmin,
  updateUserAutoApproveRequests,
} from '../lib/api'
import { formatRelativeTime } from '../lib/format-time'

type Group = 'active' | 'invited' | 'noAccess'

const GROUPS: { id: Group; title: string; help: string }[] = [
  { id: 'active', title: 'Using DJ Llama', help: 'Have signed in at least once.' },
  {
    id: 'invited',
    title: "Haven't signed in yet",
    help: 'Have Plex access to your music, but have never opened DJ Llama.',
  },
  {
    id: 'noAccess',
    title: 'No Music access',
    help: "Shared on your Plex server, but not your Music library, so they can't use DJ Llama.",
  },
]

function groupOf(u: AdminUser): Group {
  if (!u.isAdmin && !u.hasMusicAccess) return 'noAccess'
  return u.hasSignedIn ? 'active' : 'invited'
}

// Owner, then admins, then most recently signed in; alphabetical otherwise.
function compareUsers(a: AdminUser, b: AdminUser): number {
  const rank = (u: AdminUser) => (u.isOwner ? 0 : u.isAdmin ? 1 : 2)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  const at = a.lastSignInAt ? Date.parse(a.lastSignInAt) : 0
  const bt = b.lastSignInAt ? Date.parse(b.lastSignInAt) : 0
  if (at !== bt) return bt - at
  return a.username.localeCompare(b.username)
}

function statusLine(u: AdminUser, group: Group): string {
  if (group === 'noAccess') return 'No access to your Plex Music library'
  if (group === 'invited') return "Hasn't signed in yet"
  return u.lastSignInAt ? `Signed in ${formatRelativeTime(u.lastSignInAt)}` : 'Has signed in'
}

const AVATAR_CLASSES: Record<Group, string> = {
  active: 'bg-accent/15 text-accent',
  invited: 'bg-bg text-muted border border-border',
  noAccess: 'bg-bg text-muted/60 border border-border',
}

const pill = 'shrink-0 text-[11px] font-medium leading-none px-1.5 py-1 rounded'

type MenuItem = {
  label: string
  description?: string
  onSelect: () => void
  disabledReason?: string
  destructive?: boolean
}

function ActionsMenu({ username, items }: { username: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Actions for ${username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:text-text hover:bg-bg transition-colors"
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-surface p-1 shadow-xl"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={!!item.disabledReason}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={`block w-full rounded-md px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:bg-bg ${
                item.destructive ? 'text-reject' : 'text-text'
              }`}
            >
              <span className="block text-sm">{item.label}</span>
              {(item.disabledReason ?? item.description) && (
                <span className="block text-xs text-muted mt-0.5">
                  {item.disabledReason ?? item.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function UserManagementPage({ embedded = false }: { embedded?: boolean }) {
  const queryClient = useQueryClient()
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<{
    id: number
    username: string
  } | null>(null)

  const { data: currentUser } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers })

  const adminCount = usersQuery.data?.filter((u) => u.isAdmin).length ?? 0

  const toggleAdmin = useMutation({
    mutationFn: ({ id, isAdmin }: { id: number; isAdmin: boolean }) => updateUserAdmin(id, isAdmin),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => toast.error(errMsg(err)),
  })

  const toggleAutoApproveRequests = useMutation({
    mutationFn: ({ id, autoApproveRequests }: { id: number; autoApproveRequests: boolean }) =>
      updateUserAutoApproveRequests(id, autoApproveRequests),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => toast.error(errMsg(err)),
  })

  const deleteUser = useMutation({
    mutationFn: (id: number) => deleteUserApi(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => toast.error(errMsg(err)),
  })

  const syncUsers = useMutation({
    mutationFn: syncPlexUsers,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(
          `Synced: ${result.added} added, ${result.updated} updated, ${result.revoked} removed`,
        )
      }
    },
    onError: (err) => toast.error(errMsg(err)),
  })

  if (usersQuery.isLoading) {
    return <div className="p-8 text-muted">Loading users...</div>
  }

  if (usersQuery.error) {
    return (
      <div className="p-8 text-reject">
        Failed to load users:{' '}
        {usersQuery.error instanceof Error ? usersQuery.error.message : 'Unknown error'}
      </div>
    )
  }

  const grouped = new Map<Group, AdminUser[]>(GROUPS.map((g) => [g.id, []]))
  for (const u of usersQuery.data ?? []) grouped.get(groupOf(u))?.push(u)
  for (const list of grouped.values()) list.sort(compareUsers)

  function menuItems(user: AdminUser): MenuItem[] {
    const isSelf = currentUser?.id === user.id
    const isLastAdmin = user.isAdmin && adminCount <= 1
    const busy = toggleAdmin.isPending || toggleAutoApproveRequests.isPending
    const items: MenuItem[] = [
      {
        label: user.isAdmin ? 'Remove admin' : 'Make admin',
        description: user.isAdmin ? undefined : 'Full access to settings and other users.',
        onSelect: () => toggleAdmin.mutate({ id: user.id, isAdmin: !user.isAdmin }),
        disabledReason: !user.isAdmin
          ? busy
            ? 'Saving...'
            : undefined
          : user.isOwner
            ? 'The server owner is always an admin.'
            : isSelf
              ? "You can't remove your own admin role."
              : isLastAdmin
                ? "Can't remove the last admin."
                : busy
                  ? 'Saving...'
                  : undefined,
      },
    ]
    if (!user.isAdmin) {
      items.push({
        label: user.autoApproveRequests ? 'Stop trusting requests' : 'Trust requests',
        description: user.autoApproveRequests
          ? 'Their requests will wait for your approval again.'
          : 'Their requests go straight to Lidarr without waiting for approval.',
        onSelect: () =>
          toggleAutoApproveRequests.mutate({
            id: user.id,
            autoApproveRequests: !user.autoApproveRequests,
          }),
        disabledReason: busy ? 'Saving...' : undefined,
      })
    }
    items.push({
      label: 'Remove user',
      description: "They'll come back automatically if they still have Plex access.",
      onSelect: () => setConfirmDeleteUser({ id: user.id, username: user.username }),
      destructive: true,
      disabledReason: isSelf
        ? "You can't remove yourself."
        : isLastAdmin
          ? "Can't remove the last admin."
          : deleteUser.isPending
            ? 'Removing...'
            : undefined,
    })
    return items
  }

  return (
    <div className={embedded ? 'space-y-5' : 'p-6 space-y-5 max-w-6xl mx-auto'}>
      <div className="flex items-center justify-between gap-3">
        <h1 className={embedded ? 'sr-only' : 'text-2xl font-display tracking-wide text-text'}>
          User Management
        </h1>
        <p className={embedded ? 'text-sm text-muted' : 'sr-only'}>
          {usersQuery.data?.length ?? 0} people from Plex
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => syncUsers.mutate()}
          disabled={syncUsers.isPending}
        >
          <RefreshCw size={14} className={`mr-1 ${syncUsers.isPending ? 'animate-spin' : ''}`} />
          {syncUsers.isPending ? 'Syncing...' : 'Sync with Plex'}
        </Button>
      </div>

      <Hint id="user-management-intro-tip" type="inline">
        Accounts are managed by Plex: anyone with access to this server is added automatically, and
        access is removed automatically when Plex access is revoked. You can change the admin role
        and whether a user's requests need approval.
      </Hint>

      {usersQuery.data?.length === 0 && <p className="text-sm text-muted">No users found.</p>}

      {GROUPS.map((group) => {
        const members = grouped.get(group.id) ?? []
        if (members.length === 0) return null
        return (
          <section key={group.id} aria-labelledby={`users-${group.id}`}>
            <div className="flex items-baseline gap-2 px-1 mb-1.5">
              <h2 id={`users-${group.id}`} className="text-sm font-semibold text-text">
                {group.title}
              </h2>
              <span className="text-xs text-muted">{members.length}</span>
            </div>
            <p className="px-1 mb-2 text-xs text-muted">{group.help}</p>
            <ul className="rounded-lg border border-border bg-surface divide-y divide-border">
              {members.map((user) => (
                <li key={user.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div
                    aria-hidden
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase ${AVATAR_CLASSES[group.id]}`}
                  >
                    {user.username.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`truncate font-medium ${group.id === 'noAccess' ? 'text-muted' : 'text-text'}`}
                      >
                        {user.username}
                      </span>
                      {currentUser?.id === user.id && (
                        <span className="shrink-0 text-xs text-muted">(you)</span>
                      )}
                      {user.isOwner ? (
                        <span className={`${pill} bg-accent text-accent-fg`}>Owner</span>
                      ) : (
                        user.isAdmin && (
                          <span className={`${pill} bg-accent/15 text-accent`}>Admin</span>
                        )
                      )}
                      {!user.isAdmin && user.autoApproveRequests && (
                        <span
                          className={`${pill} bg-approve/15 text-approve`}
                          title="Requests go straight to Lidarr without approval"
                        >
                          Trusted
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted">
                      {statusLine(user, group.id)}
                      {user.email && <span className="hidden sm:inline"> · {user.email}</span>}
                    </p>
                  </div>
                  <ActionsMenu username={user.username} items={menuItems(user)} />
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      {confirmDeleteUser && (
        <ConfirmDialog
          title="Remove user"
          message={`Remove "${confirmDeleteUser.username}"? They'll be added back automatically the next time they sign in or the sync runs, as long as they still have Plex access.`}
          confirmLabel="Remove"
          onConfirm={() => {
            deleteUser.mutate(confirmDeleteUser.id)
            setConfirmDeleteUser(null)
          }}
          onCancel={() => setConfirmDeleteUser(null)}
        />
      )}
    </div>
  )
}
