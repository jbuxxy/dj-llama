// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/web/lib/api', () => ({
  completeSetup: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public data: unknown,
    ) {
      super('Missing required fields')
    }
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { toast } from 'sonner'
import { ApiError, completeSetup } from '@/web/lib/api'
import { SetupWizard } from '@/web/pages/setup'

const mockCompleteSetup = vi.mocked(completeSetup)
const mockToastError = vi.mocked(toast.error)

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderSetupWizard() {
    return render(<SetupWizard onComplete={vi.fn()} />)
  }

  async function fillAndContinueLidarr() {
    await screen.findByText('Connect Lidarr')
    fireEvent.change(screen.getByLabelText('Lidarr URL'), {
      target: { value: 'http://localhost:8686' },
    })
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
  }

  it('moves to AI setup after continuing past Lidarr details', async () => {
    renderSetupWizard()
    await fillAndContinueLidarr()

    await screen.findByText('AI Provider')
  })

  it('surfaces the backend error (and missing fields) when setup completion fails', async () => {
    mockCompleteSetup.mockRejectedValueOnce(
      new ApiError(400, { error: 'Missing required fields', fields: ['aiModel'] }),
    )
    renderSetupWizard()

    await fillAndContinueLidarr()
    await screen.findByText('AI Provider')
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }))

    fireEvent.click(await screen.findByRole('button', { name: /Start Digging/i }))

    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError).toHaveBeenCalledWith('Missing required fields: aiModel')
  })
})
