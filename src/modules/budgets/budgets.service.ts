import { ConflictError } from "@softistx/mongo";
import type { Viewer } from "../../auth/viewer";
import type { AppMongo } from "../../config/db";
import type { Background } from "../../shared/background";
import { monthOf, windowOf } from "../../shared/months";
import { exhausted } from "./budgets.errors";
import type {
  AlertHook,
  BudgetAlert,
  BudgetMail,
  BudgetMembers,
  MessageSpend,
} from "./budgets.integrity";
import {
  DEFAULT_BUDGET_USD,
  isAlerting,
  isExhausted,
  isPaid,
  percentOf,
} from "./budgets.rules";
import { alertMail, perMember, perModel, totalOf } from "./budgets.utils";

// What the budgets are wired from, every port passed by the registry.
export type BudgetsDeps = {
  mongo: AppMongo;
  spend: MessageSpend;
  members: BudgetMembers;
  mail: BudgetMail;
  background: Background;
  onAlert: AlertHook;
  now: () => Date;
};

// The budgets and the usage, for one request (docs/spec.md, section 4.12).
// The resolver ran the guard first: an administrator for the settings and the
// team's usage, a member for its own figures. A run that ended asks
// `checkAlert` for its owner, with no viewer of its own.
export class BudgetsService {
  constructor(
    private readonly deps: BudgetsDeps,
    private readonly viewer: Viewer | null,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("budgets: an operation needs a viewer");
    return this.viewer.id;
  }

  private get mongo() {
    return this.deps.mongo.as(this.actor);
  }

  // The team's default monthly budget, in USD.
  async defaultBudget(): Promise<number> {
    const settings = await this.deps.mongo.db.budgetSettings.findById("team");
    return settings?.defaultMonthlyUsd ?? DEFAULT_BUDGET_USD;
  }

  // Sets the team's default; a member with a budget of its own keeps it.
  async setDefault(monthlyUsd: number) {
    await this.mongo.db.budgetSettings.upsert(
      { _id: "team" },
      { defaultMonthlyUsd: monthlyUsd },
    );
    return { defaultMonthlyUsd: monthlyUsd };
  }

  // Sets a member's own budget, or null to follow the default again.
  async setMember(memberId: string, monthlyUsd: number | null) {
    const member = await this.deps.members.find(memberId);
    await this.mongo.db.memberBudgets.upsert(
      { _id: member._id },
      { monthlyUsd },
    );
    return {
      memberId: member._id,
      monthlyUsd,
      effectiveUsd: monthlyUsd ?? (await this.defaultBudget()),
    };
  }

  // What applies to a member: its own budget, else the default.
  private async budgetOf(memberId: string): Promise<number> {
    const own = await this.deps.mongo.db.memberBudgets.findById(memberId);
    return own?.monthlyUsd ?? (await this.defaultBudget());
  }

  // A member's spend and budget for a month.
  private async figures(memberId: string, month: string) {
    const window = windowOf(month);
    const [rows, budgetUsd] = await Promise.all([
      this.deps.spend.ofMember(memberId, month),
      this.budgetOf(memberId),
    ]);
    const total = totalOf(rows);
    return {
      month,
      window,
      rows,
      total,
      budgetUsd,
      percent: percentOf(total.spentUsd, budgetUsd),
    };
  }

  // The signed-in member's status for the current month: the viewer's
  // `budgetStatus`.
  async status() {
    const month = monthOf(this.deps.now());
    const { total, window, budgetUsd, percent } = await this.figures(
      this.actor,
      month,
    );
    const alert = await this.deps.mongo.db.budgetAlerts.findFirst({
      memberId: this.actor,
      month,
    });
    return {
      month,
      spentUsd: total.spentUsd,
      budgetUsd,
      percent,
      exhausted: isExhausted(total.spentUsd, budgetUsd),
      alertedAt: alert?.alertedAt ?? null,
      resetsAt: window.end,
    };
  }

  // The signed-in member's usage for a month (the current one by default).
  async usage(month?: string | null) {
    const asked = month ?? monthOf(this.deps.now());
    const { rows, total, budgetUsd, percent } = await this.figures(
      this.actor,
      asked,
    );
    return {
      month: asked,
      ...total,
      budgetUsd,
      percent,
      models: perModel(rows),
    };
  }

  // The team's usage for a month: a line per member (the ones who spent
  // nothing too) and per model. Figures only.
  async teamUsage(month?: string | null) {
    const asked = month ?? monthOf(this.deps.now());
    const [rows, roster, own, defaultBudgetUsd] = await Promise.all([
      this.deps.spend.ofTeam(asked),
      this.deps.members.roster(),
      this.deps.mongo.db.memberBudgets.findMany({}),
      this.defaultBudget(),
    ]);
    const spent = perMember(rows);
    const budgets = new Map(own.map((row) => [row._id, row.monthlyUsd]));
    const members = roster
      .map(({ id, name }) => {
        const customBudget = budgets.get(id) ?? null;
        const budgetUsd = customBudget ?? defaultBudgetUsd;
        const spentUsd = spent.get(id) ?? 0;
        return {
          memberId: id,
          name,
          spentUsd,
          budgetUsd,
          percent: percentOf(spentUsd, budgetUsd),
          customBudget: customBudget !== null,
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd || a.name.localeCompare(b.name));
    return {
      month: asked,
      spentUsd: totalOf(rows).spentUsd,
      defaultBudgetUsd,
      members,
      models: perModel(rows),
    };
  }

  // The send stop: a send to a paid model is refused once the month's spend
  // has reached the signed-in member's budget (409 `budgets.errors.exhausted`).
  // A free model is never refused. A run already started is not counted until
  // it ends, so one started under budget finishes and may overshoot it.
  async requireWithin(provider: string) {
    if (!isPaid(provider)) return;
    const status = await this.status();
    if (!status.exhausted) return;
    throw exhausted({
      spentUsd: status.spentUsd,
      budgetUsd: status.budgetUsd,
      resetsAt: status.resetsAt,
    });
  }

  // After a run ended: raises the member's 80 % alert for the month the run
  // counts in (`at` is its assistant message's creation, so a run that crossed
  // midnight on the 1st is checked in the month it was spent in), once. The
  // member is read and the mail built first; then the alert is recorded, and
  // its unique index is the one-winner gate: only the run that records it
  // sends. The mail and the push hook go out in the background; a failed send
  // is logged and not retried (the alert stays recorded, so it is never sent
  // twice), and the in-app notice is the record itself.
  async checkAlert(memberId: string, at: Date) {
    const month = monthOf(at);
    const { total, window, budgetUsd, percent } = await this.figures(
      memberId,
      month,
    );
    if (!isAlerting(total.spentUsd, budgetUsd)) return;
    const alert: BudgetAlert = {
      memberId,
      month,
      spentUsd: total.spentUsd,
      budgetUsd,
      percent,
      resetsAt: window.end,
    };
    const member = await this.deps.members.find(memberId);
    const message = alertMail(member, alert, this.deps.mail.from);
    if (!(await this.record(alert, this.deps.now()))) return;
    const { background, mail, onAlert } = this.deps;
    background.run("budget alert mail", () => mail.mailer.send(message));
    background.run("budget alert push", () => onAlert(alert));
  }

  // Writes the month's alert; false when it already exists.
  private async record(alert: BudgetAlert, now: Date): Promise<boolean> {
    try {
      await this.deps.mongo.as(alert.memberId).db.budgetAlerts.create({
        memberId: alert.memberId,
        month: alert.month,
        alertedAt: now,
        spentUsd: alert.spentUsd,
        budgetUsd: alert.budgetUsd,
      });
      return true;
    } catch (error) {
      if (error instanceof ConflictError) return false;
      throw error;
    }
  }
}
