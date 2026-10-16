// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '@/web/components/error-boundary'

function Boom({ message }: { message: string }): null {
  throw new Error(message)
}

describe('ErrorBoundary', () => {
  const originalError = console.error
  beforeEach(() => {
    // React logs caught render errors to console.error — silence to keep
    // test output readable.
    console.error = vi.fn()
  })
  afterEach(() => {
    console.error = originalError
  })

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>healthy child</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('healthy child')).toBeInTheDocument()
  })

  it('renders fallback UI with error message when child throws', () => {
    render(<ErrorBoundary>{(<Boom message="kaboom" />) as ReactNode}</ErrorBoundary>)
    expect(screen.getByText('kaboom')).toBeInTheDocument()
    // Fallback title ("Something went wrong") should render
    expect(screen.getByRole('heading')).toBeInTheDocument()
    // Retry and Home buttons present
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(2)
  })

  it('exposes retry and home buttons in the fallback', () => {
    render(<ErrorBoundary>{(<Boom message="x" />) as ReactNode}</ErrorBoundary>)
    const buttons = screen.getAllByRole('button')
    // Retry + Home = 2 buttons in the fallback UI.
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    const retry = buttons[0]
    if (!retry) throw new Error('retry button missing')
    // Clicking retry should not throw; the integration-level behaviour
    // (re-mount with healthy children) is covered by other tests.
    fireEvent.click(retry)
  })
})
