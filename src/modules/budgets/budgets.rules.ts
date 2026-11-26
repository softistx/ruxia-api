// The pure rules of the budgets (docs/spec.md, section 4.12): the month in
// America/Toronto, its window, and where a spend stands against a budget.

// The calendar the budgets count in, whatever the server's own zone is.
export const TIME_ZONE = "America/Toronto";

// The percent of the budget at which the member is alerted, once a month.
export const ALERT_PERCENT = 80;

// The monthly budget of a member while the admin has set none, in USD.
export const DEFAULT_BUDGET_USD = 20;

const wall = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// The Toronto wall clock at `at`, as numbers.
function wallOf(at: Date) {
  const parts = Object.fromEntries(
    wall.formatToParts(at).map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts["year"] ?? 0,
    month: parts["month"] ?? 0,
    day: parts["day"] ?? 0,
    hour: parts["hour"] ?? 0,
    minute: parts["minute"] ?? 0,
    second: parts["second"] ?? 0,
  };
}

// How far Toronto's clock is ahead of UTC at `at`, in milliseconds (negative
// west of Greenwich: -5 h in winter, -4 h in summer).
function offsetAt(at: Date): number {
  const w = wallOf(at);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

const pad = (value: number) => String(value).padStart(2, "0");

// The calendar month `at` falls in, in Toronto: `YYYY-MM`.
export function monthOf(at: Date): string {
  const { year, month } = wallOf(at);
  return `${year}-${pad(month)}`;
}

// The instant Toronto's clock reads midnight on the first of `year`-`month`.
// Midnight on the 1st is never inside a clock change (those are Sundays at
// 2 h), so two passes find the offset in force at that instant.
function startOfMonth(year: number, month: number): Date {
  const guess = Date.UTC(year, month - 1, 1);
  const first = guess - offsetAt(new Date(guess));
  return new Date(guess - offsetAt(new Date(first)));
}

// The window of a `YYYY-MM` month: its first instant and the first instant of
// the next one (`end` is excluded), both in Toronto's midnight. A month
// that is 28 to 31 days long, and an hour more or less once a year, is
// handled by the zone's rules, never by counting hours.
export function windowOf(month: string): { start: Date; end: Date } {
  const [year = 0, number = 0] = month.split("-").map(Number);
  const nextYear = number === 12 ? year + 1 : year;
  const next = number === 12 ? 1 : number + 1;
  return {
    start: startOfMonth(year, number),
    end: startOfMonth(nextYear, next),
  };
}

// Whether `value` is a real `YYYY-MM` (the SDL's pattern checks the shape).
export const isMonth = (value: string): boolean =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

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
