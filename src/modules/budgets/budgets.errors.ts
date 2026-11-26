import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes). `exhausted`: the
// month's spend has reached the member's budget, so a send to a paid model is
// refused; Ollama stays allowed.
export const codes = defineCodes("budgets", ["exhausted"]);

// The raw figures stay in the params (USD), with the instant the month ends
// (the budget starts again), as an ISO date.
export const exhausted = (figures: {
  spentUsd: number;
  budgetUsd: number;
  resetsAt: Date;
}) =>
  fail("budgets.errors.exhausted", {
    status: 409,
    params: {
      spentUsd: figures.spentUsd,
      budgetUsd: figures.budgetUsd,
      resetsAt: figures.resetsAt.toISOString(),
    },
  });
