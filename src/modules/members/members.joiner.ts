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
