import { useQuery } from '@tanstack/react-query'
import { CollapsibleCard } from '@/web/components/collapsible-card'
import { getSystemInfo } from '@/web/lib/api'
import { BackupSection } from './backup-section'
import { MaintenanceSection } from './maintenance-section'
import { MigrateBackendSection } from './migrate-backend-section'
import { SystemSection } from './system-section'

export function AdministrationTab() {
  const { data: system } = useQuery({ queryKey: ['adminSystem'], queryFn: getSystemInfo })

  return (
    <div className="space-y-4 max-w-3xl">
      <CollapsibleCard title="System" subtitle="What's running and whether it's healthy.">
        <SystemSection info={system} />
      </CollapsibleCard>

      <CollapsibleCard
        title="Backup & restore"
        subtitle="Keep a copy of your data, or bring one back."
      >
        <BackupSection />
      </CollapsibleCard>

      <CollapsibleCard title="Maintenance">
        <MaintenanceSection />
      </CollapsibleCard>

      {system?.dbBackend === 'pglite' && (
        <CollapsibleCard title="Move to PostgreSQL" defaultCollapsed>
          <MigrateBackendSection />
        </CollapsibleCard>
      )}
    </div>
  )
}
