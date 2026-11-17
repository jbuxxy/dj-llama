import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { errMsg } from '@/core/validation'
import { addOptimisticJob, useActiveJob, watchJob } from './activity'
import { getPipelineStatus, triggerPipeline } from './api'

/**
 * One way to start a discovery scan from anywhere (header, Discover empty
 * state, mobile toolbar, Today's Pick). Shows the scan as started the
 * instant it's clicked, attaches a live progress toast, and reports
 * `running` from the pushed activity feed instead of a slow status poll.
 */
export function useStartScan(): { start: () => void; running: boolean } {
  const queryClient = useQueryClient()
  const job = useActiveJob('pipeline')
  const { data: status } = useQuery({
    queryKey: ['pipelineStatus'],
    queryFn: getPipelineStatus,
    // Pushed job events invalidate this; the interval is only a safety net.
    refetchInterval: (query) => (query.state.data?.running ? 15_000 : false),
  })
  const running = !!job || (status?.running ?? false)

  function start() {
    if (running) {
      toast.info('A scan is already running')
      return
    }
    watchJob('pipeline')
    const dropPlaceholder = addOptimisticJob(queryClient, {
      kind: 'pipeline',
      label: 'Discovery scan',
      message: 'Starting scan...',
    })
    triggerPipeline()
      .then((res) => {
        queryClient.invalidateQueries({ queryKey: ['pipelineStatus'] })
        if (res.status === 'duplicate') {
          dropPlaceholder()
          toast.info('A scan is already running for you')
        }
      })
      .catch((err) => {
        dropPlaceholder()
        toast.error(errMsg(err))
      })
  }

  return { start, running }
}
