import { Compass, LayoutDashboard, ListMusic, Search } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '../lib/utils'

/**
 * Mobile-only bottom navigation bar. Hidden on md+ breakpoints.
 * Fixed to bottom of screen, above any content via z-index. Everything not
 * on this short list (Genres, Settings, ...) is still reachable from the
 * hamburger menu or the profile menu -- this bar is deliberately just the
 * handful of most-used destinations.
 */
export function BottomNav({ pendingRequestsCount = 0 }: { pendingRequestsCount?: number }) {
  const location = useLocation()

  const discoverActive = location.pathname === '/discover'

  const items: Array<{
    to: string
    label: string
    Icon: typeof LayoutDashboard
    exact: boolean
    override?: boolean
    badge?: number
  }> = [
    { to: '/', label: 'Dashboard', Icon: LayoutDashboard, exact: true },
    {
      to: '/requests',
      label: 'Search',
      Icon: Search,
      exact: false,
      badge: pendingRequestsCount,
    },
    {
      to: '/discover',
      label: 'Discover',
      Icon: Compass,
      exact: true,
      override: discoverActive,
    },
    { to: '/playlists', label: 'Playlists', Icon: ListMusic, exact: false },
  ]
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-bg border-t border-border"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around h-14 px-2">
        {items.map(({ to, label, Icon, exact, override, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) => {
              const active = override ?? isActive
              return cn(
                'relative flex min-h-11 min-w-[52px] flex-col items-center justify-center gap-0.5 rounded-md px-3 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
                active ? 'text-accent' : 'text-muted hover:text-text',
              )
            }}
            aria-label={label}
          >
            {({ isActive }) => {
              const active = override ?? isActive
              return (
                <>
                  <span className="relative">
                    <Icon
                      size={20}
                      aria-hidden="true"
                      className={active ? 'text-accent' : undefined}
                    />
                    {!!badge && (
                      <span className="absolute -top-1.5 -right-2 min-w-4 px-1 h-4 rounded-full bg-accent text-accent-fg text-micro-sm leading-4 text-center font-semibold">
                        {badge}
                      </span>
                    )}
                  </span>
                  <span className="text-micro font-medium leading-none">{label}</span>
                </>
              )
            }}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
