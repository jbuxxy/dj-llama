// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CronPicker } from '@/web/components/cron-picker'

describe('CronPicker', () => {
  it('shows a plain-English summary instead of raw cron', () => {
    render(<CronPicker value="0 6 * * 1" onChange={vi.fn()} />)
    expect(screen.getByText('Every Monday at 6:00 AM')).toBeInTheDocument()
    expect(screen.getByText(/Next run:/)).toBeInTheDocument()
    expect(screen.queryByText('0 6 * * 1')).not.toBeInTheDocument()
  })

  it('emits cron as days are picked', () => {
    const onChange = vi.fn()
    render(<CronPicker value="0 6 * * 1" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thursday' }))
    expect(onChange).toHaveBeenLastCalledWith('0 6 * * 1,4')
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays' }))
    expect(onChange).toHaveBeenLastCalledWith('0 6 * * 1,2,3,4,5')
  })

  it('keeps the time when switching repeat mode', () => {
    const onChange = vi.fn()
    render(<CronPicker value="30 7 * * *" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Certain days' }))
    expect(onChange).toHaveBeenLastCalledWith('30 7 * * 1')
  })

  it('switches to every-few-hours', () => {
    const onChange = vi.fn()
    render(<CronPicker value="0 6 * * *" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Every few hours' }))
    expect(onChange).toHaveBeenLastCalledWith('0 */6 * * *')
  })

  it('opens hand-written cron in the advanced editor without rewriting it', () => {
    const onChange = vi.fn()
    render(<CronPicker value="0 9 * * 1-5" onChange={onChange} />)
    expect(screen.getByDisplayValue('0 9 * * 1-5')).toBeInTheDocument()
    expect(screen.getByText('Custom schedule')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
