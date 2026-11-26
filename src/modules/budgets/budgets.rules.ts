// The pure rules of the budgets (docs/spec.md, section 4.12): where a spend
// stands against a budget. The month is `src/shared/months.ts`.

// The percent of the budget at which the member is alerted, once a month.
export const ALERT_PERCENT = 80;

// The monthly budget of a member while the admin has set none, in USD.
export const DEFAULT_BUDGET_USD = 20;

// How much of the budget is spent, in percent (not rounded). A budget of 0
// has no room at all: 100.
export function percentOf(spentUsd: number, budgetUsd: number): number {
  if (budgetUsd <= 0) return 100;
  return (spentUsd / budgetUsd) * 100;
}

// A model costs money unless its provider is the local Ollama (spec 4.12:
// Claude is paid, Ollama is free).
export const isPaid = (provider: string): boolean => provider !== "ollama";

// The send stop: the spend has reached the budget.
export const isExhausted = (spentUsd: number, budgetUsd: number): boolean =>
  spentUsd >= budgetUsd;

// The alert: 80 % reached, on a budget that has room to speak of.
export const isAlerting = (spentUsd: number, budgetUsd: number): boolean =>
  budgetUsd > 0 && spentUsd * 100 >= budgetUsd * ALERT_PERCENT;

// A spend rounded to the micro-dollar, so floating sums print and compare.
export const roundUsd = (usd: number): number =>
  Math.round(usd * 1_000_000) / 1_000_000;
