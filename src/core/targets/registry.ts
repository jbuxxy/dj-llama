import type { DestinationTarget, TargetCapability } from './types'

export class TargetRegistry {
  private targets = new Map<string, DestinationTarget>()

  register(target: DestinationTarget): void {
    this.targets.set(target.id, target)
  }

  get(id: string): DestinationTarget | undefined {
    return this.targets.get(id)
  }

  all(): DestinationTarget[] {
    return [...this.targets.values()]
  }

  withCapability(capability: TargetCapability): DestinationTarget[] {
    return this.all().filter((t) => t.capabilities.includes(capability))
  }

  clear(): void {
    this.targets.clear()
  }
}
