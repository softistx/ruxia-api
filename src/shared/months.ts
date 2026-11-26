// The calendar month in America/Toronto, shared by the budgets and the
// conversations' spend ledger: computed with `Intl`, never from the server's
// own zone.

// The calendar the budgets count in, whatever the server's own zone is.
export const TIME_ZONE = "America/Toronto";

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
