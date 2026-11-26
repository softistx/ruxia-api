import { describe, expect, test } from "bun:test";
import {
  isAlerting,
  isExhausted,
  isMonth,
  isPaid,
  monthOf,
  percentOf,
  roundUsd,
  windowOf,
} from "./budgets.rules";

const at = (iso: string) => new Date(iso);

describe("monthOf: Toronto's calendar, not the server's", () => {
  test("a winter midnight: 05:00 UTC is the first instant of the month", () => {
    expect(monthOf(at("2026-12-01T04:59:59.999Z"))).toBe("2026-11");
    expect(monthOf(at("2026-12-01T05:00:00.000Z"))).toBe("2026-12");
  });

  test("a summer midnight: 04:00 UTC is the first instant of the month", () => {
    expect(monthOf(at("2026-07-01T03:59:59.999Z"))).toBe("2026-06");
    expect(monthOf(at("2026-07-01T04:00:00.000Z"))).toBe("2026-07");
  });

  test("around the clock change of November (EDT to EST on the 1st)", () => {
    // The change is at 2 h on Sunday 2026-11-01; midnight of the 1st is EDT.
    expect(monthOf(at("2026-11-01T03:59:59.999Z"))).toBe("2026-10");
    expect(monthOf(at("2026-11-01T04:00:00.000Z"))).toBe("2026-11");
    // Back an hour in the night: 05:30 UTC is 00:30 EST, still November.
    expect(monthOf(at("2026-11-01T05:30:00.000Z"))).toBe("2026-11");
  });

  test("around the clock change of March (EST to EDT on the 8th)", () => {
    expect(monthOf(at("2026-04-01T03:59:59.999Z"))).toBe("2026-03");
    expect(monthOf(at("2026-04-01T04:00:00.000Z"))).toBe("2026-04");
    expect(monthOf(at("2026-03-01T04:59:59.999Z"))).toBe("2026-02");
    expect(monthOf(at("2026-03-01T05:00:00.000Z"))).toBe("2026-03");
  });

  test("the new year", () => {
    expect(monthOf(at("2027-01-01T04:59:59.999Z"))).toBe("2026-12");
    expect(monthOf(at("2027-01-01T05:00:00.000Z"))).toBe("2027-01");
  });
});

describe("windowOf", () => {
  test("the window of a winter month", () => {
    const { start, end } = windowOf("2026-12");
    expect(start.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  test("November is an hour longer than 30 days, across the change", () => {
    const { start, end } = windowOf("2026-11");
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe((30 * 24 + 1) * 3_600_000);
  });

  test("March is an hour shorter than 31 days, across the change", () => {
    const { start, end } = windowOf("2026-03");
    expect(start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe((31 * 24 - 1) * 3_600_000);
  });

  test("a window holds exactly the instants monthOf names for it", () => {
    for (const month of [
      "2026-02",
      "2026-03",
      "2026-10",
      "2026-11",
      "2026-12",
    ]) {
      const { start, end } = windowOf(month);
      expect(monthOf(start)).toBe(month);
      expect(monthOf(new Date(end.getTime() - 1))).toBe(month);
      expect(monthOf(new Date(start.getTime() - 1))).not.toBe(month);
      expect(monthOf(end)).not.toBe(month);
    }
  });
});

describe("isPaid", () => {
  test("Claude is paid, Ollama is free", () => {
    expect(isPaid("anthropic")).toBe(true);
    expect(isPaid("ollama")).toBe(false);
  });
});

describe("isMonth", () => {
  test("a real month only", () => {
    expect(isMonth("2026-11")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-00")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
  });
});

describe("spend against a budget", () => {
  test("percent, with a budget of 0 having no room", () => {
    expect(percentOf(5, 20)).toBe(25);
    expect(percentOf(0, 0)).toBe(100);
    expect(percentOf(30, 20)).toBe(150);
  });

  test("exhausted at the budget, not before", () => {
    expect(isExhausted(19.99, 20)).toBe(false);
    expect(isExhausted(20, 20)).toBe(true);
    expect(isExhausted(0, 0)).toBe(true);
  });

  test("alerting from 80 %, never on a budget of 0", () => {
    expect(isAlerting(15.99, 20)).toBe(false);
    expect(isAlerting(16, 20)).toBe(true);
    expect(isAlerting(1, 0)).toBe(false);
  });

  test("rounding to the micro-dollar", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});
