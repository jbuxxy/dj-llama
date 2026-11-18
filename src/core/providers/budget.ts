// Monthly AI spend cap (preferences.aiMonthlyBudgetUsd, admin). Checked when
// a metered provider is created: over budget, creation throws
// AiBudgetExceededError, which interactive routes surface as a 402 and the
// scheduled pipeline treats as "skip this run".

export class AiBudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `This month's AI budget is used up ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}). Raise it in Settings, or wait for next month.`,
    )
    this.name = 'AiBudgetExceededError'
  }
}

export type BudgetState = { spentUsd: number; budgetUsd: number | null }

const CACHE_MS = 60_000

/** Caches the month's spend briefly -- creation sits on interactive paths. */
export function createBudgetGuard(load: () => Promise<BudgetState>) {
  let cached: { at: number; state: BudgetState } | null = null
  return {
    async check(): Promise<void> {
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        cached = { at: Date.now(), state: await load() }
      }
      const { spentUsd, budgetUsd } = cached.state
      if (budgetUsd && budgetUsd > 0 && spentUsd >= budgetUsd) {
        throw new AiBudgetExceededError(spentUsd, budgetUsd)
      }
    },
    /** Forget the cached spend (after a settings change). */
    invalidate() {
      cached = null
    },
  }
}
