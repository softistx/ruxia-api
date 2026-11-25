import { expect, test } from "bun:test";
import { appMongo, databaseOf } from "../config/db";
import type { Joined } from "./auth";
import { invitationsConfig } from "./auth-invitations";

const db = databaseOf(appMongo);
const joined: Joined[] = [];
const granted: [string, string][] = [];
const config = invitationsConfig(
  db,
  async (j) => {
    joined.push(j);
  },
  () =>
    ({
      setRole: async (id: string, role: string) => {
        granted.push([id, role]);
      },
    }) as never,
);

test("an invitation lasts seven days, at most 200 pending", () => {
  expect(config.lifetime).toBe("7d");
  expect(config.maxPending).toBe(200);
});

test("the account is made from the invitation, its locale only if shipped", () => {
  const make = (locale: string) =>
    config.create({ email: "a@b.test", name: "A", locale } as never);
  expect(make("en")).toEqual({ email: "a@b.test", name: "A", locale: "en" });
  expect(make("de")).toEqual({ email: "a@b.test", name: "A" });
});

test("accepting grants the role, then records the member", async () => {
  await config.onAccepted?.({
    invitation: { role: "admin", email: "a@b.test", name: "A", locale: "en" },
    user: { id: "u-1" },
  } as never);
  expect(granted).toEqual([["u-1", "admin"]]);
  expect(joined).toEqual([
    { userId: "u-1", email: "a@b.test", name: "A", locale: "en" },
  ]);
});

test("an unknown role is refused before anything is written", async () => {
  granted.length = 0;
  expect(
    config.onAccepted?.({
      invitation: { role: "root", email: "a@b.test", name: "A" },
      user: { id: "u-2" },
    } as never),
  ).rejects.toThrow("unknown");
  expect(granted).toEqual([]);
});
