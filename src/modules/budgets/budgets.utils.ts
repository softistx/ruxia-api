import type { Address, MailMessage } from "@softistx/mail";
import { escapeHtml } from "../../mail/escape";
import { TIME_ZONE } from "../../shared/months";
import type { SpendRow } from "../conversations/services/spend.service";
import type { BudgetAlert } from "./budgets.integrity";
import { roundUsd } from "./budgets.rules";

// The figures of a set of rows, as the GraphQL types show them.
export type SpendFigures = {
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  messages: number;
};

export type ModelFigures = SpendFigures & { modelId: string };

const EMPTY: SpendFigures = {
  spentUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
  messages: 0,
};

// The rows added up.
export function totalOf(rows: readonly SpendRow[]): SpendFigures {
  const total = rows.reduce(
    (sum, row) => ({
      spentUsd: sum.spentUsd + row.costUsd,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      webSearches: sum.webSearches + row.webSearches,
      messages: sum.messages + row.messages,
    }),
    EMPTY,
  );
  return { ...total, spentUsd: roundUsd(total.spentUsd) };
}

// The rows of every member folded into one line per model, the dearest first.
export function perModel(rows: readonly SpendRow[]): ModelFigures[] {
  const byModel = Map.groupBy(rows, (row) => row.modelId);
  return [...byModel]
    .map(([modelId, own]) => ({ modelId, ...totalOf(own) }))
    .sort(
      (a, b) => b.spentUsd - a.spentUsd || a.modelId.localeCompare(b.modelId),
    );
}

// The rows of the team folded into the money each member spent.
export function perMember(rows: readonly SpendRow[]): Map<string, number> {
  const byOwner = Map.groupBy(rows, (row) => row.ownerId);
  return new Map(
    [...byOwner].map(([ownerId, own]) => [ownerId, totalOf(own).spentUsd]),
  );
}

type Locale = "fr" | "en";

const usd = (locale: Locale, amount: number) =>
  new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
  }).format(amount);

const day = (locale: Locale, at: Date) =>
  new Intl.DateTimeFormat(locale === "fr" ? "fr-CA" : "en-CA", {
    timeZone: TIME_ZONE,
    dateStyle: "long",
  }).format(at);

const WORDS = {
  fr: {
    subject: (percent: number) =>
      `Vous avez utilisé ${percent}\u202f% de votre budget mensuel`,
    body: (name: string, spent: string, budget: string, reset: string) =>
      `Bonjour ${name},\n\nVous avez dépensé ${spent} sur votre budget de ${budget} ce mois-ci. À 100\u202f%, l'envoi vers les modèles payants est suspendu jusqu'au ${reset} ; les modèles locaux restent disponibles.\n\nUn administrateur peut relever votre budget.`,
  },
  en: {
    subject: (percent: number) =>
      `You have used ${percent}% of your monthly budget`,
    body: (name: string, spent: string, budget: string, reset: string) =>
      `Hello ${name},\n\nYou have spent ${spent} of your ${budget} budget this month. At 100%, sending to paid models is paused until ${reset}; local models stay available.\n\nAn administrator can raise your budget.`,
  },
} as const;

// The alert mail, in the member's language: plain text and its HTML. It names
// figures only; no link, no conversation.
export function alertMail(
  member: { name: string; email: string; locale: Locale },
  alert: BudgetAlert,
  from: Address,
): MailMessage {
  const words = WORDS[member.locale];
  const text = words.body(
    member.name,
    usd(member.locale, alert.spentUsd),
    usd(member.locale, alert.budgetUsd),
    day(member.locale, alert.resetsAt),
  );
  const html = text
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  return {
    from,
    to: { name: member.name, address: member.email },
    subject: words.subject(Math.floor(alert.percent)),
    text,
    html,
  };
}
