import { describe, expect, test } from "bun:test";
import { nameOfEmail, pageFilter, statusOf } from "./invitations.utils";

const now = new Date("2026-11-25T12:00:00Z");
const later = new Date("2026-11-26T12:00:00Z");
const earlier = new Date("2026-11-24T12:00:00Z");

describe("statusOf", () => {
  test("a pending invitation past its date is expired", () => {
    expect(statusOf({ status: "pending", expiresAt: later }, now)).toBe(
      "PENDING",
    );
    expect(statusOf({ status: "pending", expiresAt: earlier }, now)).toBe(
      "EXPIRED",
    );
  });

  test("accepted and revoked stay so whatever the date", () => {
    expect(statusOf({ status: "accepted", expiresAt: earlier }, now)).toBe(
      "ACCEPTED",
    );
    expect(statusOf({ status: "revoked", expiresAt: later }, now)).toBe(
      "REVOKED",
    );
  });
});

describe("pageFilter", () => {
  test("maps each status to janus's filter", () => {
    expect(pageFilter("EXPIRED")).toEqual({
      status: "pending",
      lapsed: "only",
    });
    expect(pageFilter("PENDING")).toEqual({
      status: "pending",
      lapsed: "exclude",
    });
    expect(pageFilter(null)).toEqual({});
  });
});

describe("nameOfEmail", () => {
  test("takes the part before the @", () => {
    expect(nameOfEmail("ada@example.com")).toBe("ada");
  });
});
