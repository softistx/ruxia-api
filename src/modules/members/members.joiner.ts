import type { Joined } from "../../auth/auth";
import type { AppMongo } from "../../config/db";

// What `createAuth` calls once an invitation made an account: records the
// member, keyed by the account's id. Idempotent (an upsert on the id), since
// janus may run the callback again. The member is its own creator.
export function memberJoiner(mongo: Pick<AppMongo, "as">) {
  return async (joined: Joined) => {
    await mongo.as(joined.userId).db.members.upsert(
      { _id: joined.userId },
      {
        name: joined.name,
        email: joined.email.toLowerCase(),
        locale: joined.locale,
      },
    );
  };
}

// The members' port for a name chosen after the member joined (an invitee
// names themselves on accepting): `invitations` takes it explicitly, so only
// this module writes `members`. The member is its own updater.
export type MemberRenamer = (userId: string, name: string) => Promise<void>;

export function memberRenamer(mongo: Pick<AppMongo, "as">): MemberRenamer {
  return async (userId, name) => {
    await mongo.as(userId).db.members.update(userId, { name });
  };
}
