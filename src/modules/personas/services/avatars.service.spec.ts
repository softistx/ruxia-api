import { beforeAll, describe, expect, test } from "bun:test";
import { appMongo } from "../../../config/db";
import { AvatarsService } from "./avatars.service";

const avatars = new AvatarsService(appMongo);
const owner = "0190b1c0-0000-7000-8000-000000000001";
const other = "0190b1c0-0000-7000-8000-000000000002";

beforeAll(async () => {
  await appMongo.db.personas.raw.deleteMany({});
});

const persona = (avatarKey: string, visibility: "private" | "team") =>
  appMongo.as(owner).db.personas.create({
    ownerId: owner,
    name: "P",
    avatarKey,
    defaultModelId: "claude-sonnet-5-5",
    visibility,
  });

describe("AvatarsService", () => {
  test("an upload is its uploader's alone until a persona carries it", async () => {
    const key = crypto.randomUUID();
    await avatars.record(owner, key);
    expect(await avatars.uploadedBy(owner, key)).toBe(true);
    expect(await avatars.uploadedBy(other, key)).toBe(false);
    expect(await avatars.mayRead(owner, key)).toBe(true);
    expect(await avatars.mayRead(other, key)).toBe(false);
  });

  test("a key nobody uploaded is read by nobody", async () => {
    const key = crypto.randomUUID();
    expect(await avatars.uploadedBy(owner, key)).toBe(false);
    expect(await avatars.mayRead(owner, key)).toBe(false);
  });

  test("a PRIVATE persona's avatar stays its owner's, a TEAM one's is the team's, deleted or not", async () => {
    const hidden = crypto.randomUUID();
    const shared = crypto.randomUUID();
    await persona(hidden, "private");
    const team = await persona(shared, "team");
    expect(await avatars.mayRead(owner, hidden)).toBe(true);
    expect(await avatars.mayRead(other, hidden)).toBe(false);
    expect(await avatars.mayRead(other, shared)).toBe(true);
    await appMongo.as(owner).db.personas.delete(team._id);
    expect(await avatars.mayRead(other, shared)).toBe(true);
  });
});
