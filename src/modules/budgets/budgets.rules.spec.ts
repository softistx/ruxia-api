import { describe, expect, test } from "bun:test";
import {
  isAlerting,
  isExhausted,
  isPaid,
  percentOf,
  roundUsd,
} from "./budgets.rules";

describe("isPaid", () => {
  test("Claude is paid, Ollama is free", () => {
    expect(isPaid("anthropic")).toBe(true);
    expect(isPaid("ollama")).toBe(false);
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
