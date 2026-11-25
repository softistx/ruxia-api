import type { AppMongo } from "../../../config/db";
import type { AvatarClaims } from "../personas.integrity";

// The avatar files of the personas, for the media routes (`personas.media.ts`):
// who uploaded a key, and who may read it. A key is read by its uploader, by
// the owner of a persona that carries it, and by anyone for a TEAM persona
// that carries it, deleted or not (a conversation keeps showing the avatar).
// Never an admin's privilege: a PRIVATE persona's avatar is its owner's.
export class AvatarsService implements AvatarClaims {
  constructor(private readonly mongo: Pick<AppMongo, "as" | "db">) {}

  // Remembers that `ownerId` uploaded `key`.
  async record(ownerId: string, key: string) {
    await this.mongo.as(ownerId).db.personaAvatars.create({
      _id: key,
      ownerId,
    });
  }

  async uploadedBy(viewerId: string, key: string) {
    const claim = await this.mongo.db.personaAvatars.findById(key);
    return claim?.ownerId === viewerId;
  }

  // The read right of `viewerId` on `key`.
  async mayRead(viewerId: string, key: string) {
    if (await this.uploadedBy(viewerId, key)) return true;
    return this.mongo.db.personas.exists(
      {
        avatarKey: key,
        $or: [{ ownerId: viewerId }, { visibility: "team" }],
      },
      { withDeleted: true },
    );
  }
}
