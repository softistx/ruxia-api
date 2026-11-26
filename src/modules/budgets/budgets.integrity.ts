import type { Address, Mailer } from "@softistx/mail";
import type { SpendService } from "../conversations/services/spend.service";
import type { MembersService } from "../members";

// What the budgets need of the other modules, as ports the registry passes
// (never defaulted). The messages' spend is conversations' own aggregate, so
// the budgets read no message; `find` is the member behind an alert or a
// budget, `roster` every member's name.
export type MessageSpend = Pick<SpendService, "ofMember" | "ofTeam">;
export type BudgetMembers = Pick<MembersService, "find" | "roster">;

// The mail an alert goes out by: the app's mailer and its sender.
export type BudgetMail = { mailer: Mailer; from: Address };

// An 80 % alert that was just recorded.
export type BudgetAlert = {
  memberId: string;
  month: string;
  spentUsd: number;
  budgetUsd: number;
  percent: number;
  resetsAt: Date;
};

// Where else an alert is announced besides the mail and the in-app notice.
// Web Push (slice 14, docs/spec.md section 4.14) plugs in here: the registry
// passes it, and until then a no-op (`noPush`). A failure is logged by the
// background and never reaches the run that ended.
export type AlertHook = (alert: BudgetAlert) => Promise<void>;

export const noPush: AlertHook = async () => {};
