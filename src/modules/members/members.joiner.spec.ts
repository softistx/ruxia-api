import { expect, test } from "bun:test";
import { appMongo } from "../../config/db";
import { memberJoiner, memberRenamer } from "./members.joiner";

test("joining records the member by the account's id, lowercased and idempotent", async () => {
  const join = memberJoiner(appMongo);
  const userId = Bun.randomUUIDv7();
  const joined = {
    userId,
    email: "Join.Er@Ruxia.Test",
    name: "Joiner",
    locale: "en",
  } as const;
  await join(joined);
  await join({ ...joined, name: "Joiner Again" });
  const rows = await appMongo.db.members.find({ _id: userId }).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    email: "join.er@ruxia.test",
    name: "Joiner Again",
    locale: "en",
    disabledAt: null,
  });
});

test("renaming changes the name alone, stamped by the member", async () => {
  const userId = Bun.randomUUIDv7();
  await memberJoiner(appMongo)({
    userId,
    email: "rename@ruxia.test",
    name: "Before",
    locale: "fr",
  });
  await memberRenamer(appMongo)(userId, "After");
  const row = await appMongo.db.members.findOne({ _id: userId });
  expect(row).toMatchObject({
    name: "After",
    email: "rename@ruxia.test",
    updatedBy: userId,
  });
});
