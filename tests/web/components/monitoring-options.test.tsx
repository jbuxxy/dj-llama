// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MonitoringOptions } from '@/web/components/monitoring-options'

describe('MonitoringOptions', () => {
  it('renders button and dropdown labels', () => {
    render(<MonitoringOptions onApprove={vi.fn()} onOpenAlbumPicker={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Monitoring options' }))

    expect(screen.getByText('All albums')).toBeInTheDocument()
    expect(screen.getByText('Monitor and search for all albums')).toBeInTheDocument()
    expect(screen.getByText('Future releases only')).toBeInTheDocument()
    expect(screen.getByText('Only monitor new releases going forward')).toBeInTheDocument()
    expect(screen.getByText('Selected albums')).toBeInTheDocument()
    expect(screen.getByText('Choose which albums to monitor')).toBeInTheDocument()
    expect(screen.getByText('None')).toBeInTheDocument()
    expect(screen.getByText('Add unmonitored (tracking only)')).toBeInTheDocument()
  })

  it('keeps all options enabled when popularAvailable defaults to true', () => {
    render(<MonitoringOptions onApprove={vi.fn()} onOpenAlbumPicker={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Monitoring options' }))
    const disabled = screen.getAllByRole('button').filter((b) => (b as HTMLButtonElement).disabled)
    expect(disabled).toHaveLength(0)
  })

  it('disables the Popular option and ignores clicks when popularAvailable is false', () => {
    const onApprove = vi.fn()
    render(
      <MonitoringOptions
        onApprove={onApprove}
        onOpenAlbumPicker={vi.fn()}
        popularAvailable={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Monitoring options' }))
    const disabled = screen
      .getAllByRole('menuitem')
      .filter((b) => (b as HTMLButtonElement).disabled)
    expect(disabled).toHaveLength(1)
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    fireEvent.click(disabled[0]!)
    expect(onApprove).not.toHaveBeenCalled()
  })

  function openMenu() {
    const toggle = screen.getByRole('button', { name: 'Monitoring options' })
    fireEvent.click(toggle)
    return toggle
  }

  it('exposes the dropdown as an ARIA menu with menuitem children', () => {
    render(<MonitoringOptions onApprove={vi.fn()} onOpenAlbumPicker={vi.fn()} />)
    const toggle = openMenu()
    expect(toggle).toHaveAttribute('aria-haspopup', 'menu')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu')
    expect(menu).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(5)
  })

  it('focuses the first menuitem when opened', () => {
    render(<MonitoringOptions onApprove={vi.fn()} onOpenAlbumPicker={vi.fn()} />)
    openMenu()
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
  })

  it('moves focus with ArrowDown/ArrowUp and wraps around', () => {
    render(<MonitoringOptions onApprove={vi.fn()} onOpenAlbumPicker={vi.fn()} />)
    openMenu()
    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])

    // ArrowUp from the first item wraps to the last.
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[items.length - 1])
  })

  it('skips disabled items during arrow navigation', () => {
    render(
      <MonitoringOptions
        onApprove={vi.fn()}
        onOpenAlbumPicker={vi.fn()}
        popularAvailable={false}
      />,
    )
    openMenu()
    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')
    const popularIndex = items.findIndex((b) => (b as HTMLButtonElement).disabled)

    // Walk down to the item just before the disabled one, then once more: focus
    // must land past it, never on the disabled item.
    for (let i = 0; i < popularIndex; i += 1) fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).not.toBe(items[popularIndex])
  })

  it('closes on Escape and returns focus to the toggle', () => {
    render(<MonitoringOptions onApprove={vi.fn()} onOpenAlbumPicker={vi.fn()} />)
    const toggle = openMenu()
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(toggle)
  })
})
