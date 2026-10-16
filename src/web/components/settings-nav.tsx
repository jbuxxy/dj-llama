import type { LucideIcon } from 'lucide-react'
import { ChevronsUpDown, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type SettingsNavItem<T extends string> = {
  id: T
  label: string
  description: string
  icon: LucideIcon
}

export type SettingsNavGroup<T extends string> = { label: string; items: SettingsNavItem<T>[] }

// How far the sheet has to be dragged down before letting go closes it.
const DRAG_CLOSE_PX = 80

/**
 * Settings section navigation. Desktop: a sticky icon sidebar. Mobile: a
 * card naming the current section that opens a bottom sheet of icon tiles
 * -- every section visible at once with a one-line hint, instead of a
 * native select that only shows names.
 */
export function SettingsNav<T extends string>({
  groups,
  active,
  onChange,
}: {
  groups: SettingsNavGroup<T>[]
  active: T
  onChange: (id: T) => void
}) {
  const items = groups.flatMap((g) => g.items)
  const current = items.find((i) => i.id === active) ?? items[0]

  return (
    <>
      {current && (
        <div className="md:hidden">
          <MobileSectionSwitcher groups={groups} current={current} onChange={onChange} />
        </div>
      )}
      <nav
        aria-label="Settings sections"
        className="hidden md:block md:sticky md:top-6 self-start space-y-5"
      >
        {groups.map((group) => (
          <div key={group.label} className="space-y-0.5">
            <p className="px-3 pb-1 text-micro font-semibold uppercase tracking-wider text-muted">
              {group.label}
            </p>
            {group.items.map((item) => {
              const isActive = item.id === active
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => onChange(item.id)}
                  className={`relative w-full flex items-center gap-2.5 text-left px-3 py-1.5 rounded-md text-sm transition-colors ${
                    isActive
                      ? 'bg-surface text-text font-medium before:absolute before:left-0 before:inset-y-1.5 before:w-0.5 before:rounded-full before:bg-accent'
                      : 'text-muted hover:text-text hover:bg-surface/60'
                  }`}
                >
                  <Icon
                    size={15}
                    aria-hidden="true"
                    className={isActive ? 'text-accent shrink-0' : 'shrink-0'}
                  />
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </>
  )
}

function MobileSectionSwitcher<T extends string>({
  groups,
  current,
  onChange,
}: {
  groups: SettingsNavGroup<T>[]
  current: SettingsNavItem<T>
  onChange: (id: T) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const CurrentIcon = current.icon

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="w-full flex items-center gap-3 p-3 rounded-xl border border-border bg-surface text-left active:scale-[0.99] transition-transform"
      >
        <span className="flex items-center justify-center size-11 rounded-lg bg-accent/15 text-accent shrink-0">
          <CurrentIcon size={22} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-text leading-tight">
            {current.label}
          </span>
          <span className="block text-xs text-muted truncate mt-0.5">{current.description}</span>
        </span>
        <span className="flex items-center gap-1 text-xs font-medium text-accent shrink-0">
          Sections
          <ChevronsUpDown size={14} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <SectionSheet
          groups={groups}
          activeId={current.id}
          onSelect={(id) => {
            onChange(id)
            close()
          }}
          onClose={close}
        />
      )}
    </>
  )
}

function SectionSheet<T extends string>({
  groups,
  activeId,
  onSelect,
  onClose,
}: {
  groups: SettingsNavGroup<T>[]
  activeId: T
  onSelect: (id: T) => void
  onClose: () => void
}) {
  // Mounted closed, then flipped open on the next frame so the slide-up
  // transition actually runs.
  const [shown, setShown] = useState(false)
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<number | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheetRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function onTouchStart(e: React.TouchEvent) {
    dragStart.current = e.touches[0]?.clientY ?? null
    setDragging(true)
  }
  function onTouchMove(e: React.TouchEvent) {
    if (dragStart.current == null) return
    const y = e.touches[0]?.clientY ?? dragStart.current
    setDragY(Math.max(0, y - dragStart.current))
  }
  function onTouchEnd() {
    dragStart.current = null
    setDragging(false)
    if (dragY > DRAG_CLOSE_PX) onClose()
    else setDragY(0)
  }

  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden" role="presentation">
      <button
        type="button"
        aria-label="Close sections"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings sections"
        className={`absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-border bg-bg shadow-2xl pb-[max(1rem,env(safe-area-inset-bottom))] motion-reduce:transition-none ${
          !dragging ? 'transition-transform duration-300 ease-out' : ''
        }`}
        style={{ transform: shown ? `translateY(${dragY}px)` : 'translateY(100%)' }}
      >
        <div
          className="sticky top-0 z-10 bg-bg px-4 pt-2.5 pb-2"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className="mx-auto mb-2.5 h-1 w-10 rounded-full bg-border" aria-hidden="true" />
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg tracking-wide text-text">Settings</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 -mr-1.5 rounded-md text-muted hover:text-text"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="px-4 space-y-4">
          {groups.map((group) => (
            <section key={group.label}>
              <p className="pb-2 text-micro font-semibold uppercase tracking-wider text-muted">
                {group.label}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {group.items.map((item) => {
                  const isActive = item.id === activeId
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => onSelect(item.id)}
                      className={`flex flex-col items-start gap-2 p-3 rounded-xl border text-left transition-colors active:scale-[0.98] ${
                        isActive
                          ? 'border-accent bg-accent/10'
                          : 'border-border bg-surface hover:border-accent/50'
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center size-9 rounded-lg ${
                          isActive ? 'bg-accent text-accent-fg' : 'bg-bg text-accent'
                        }`}
                      >
                        <Icon size={18} aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-text leading-tight">
                          {item.label}
                        </span>
                        <span className="block text-micro-lg text-muted leading-snug mt-0.5 line-clamp-2">
                          {item.description}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
