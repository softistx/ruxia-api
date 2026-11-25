// The collections of the one database (`ruxia`): no tenancy. src/config/db.ts
// wires this module object, and `bun run db:sync` syncs exactly these, then
// janus's own collections (`syncMongoAdapter`, `syncMongoInvitations`), which
// janus-mongo defines itself and so are not wired here. A module adds its
// collections here as it lands.

export { roleLocks } from "../auth/roles.model";
export { members } from "./members/members.model";
export { models } from "./models/models.model";
export { personaAvatars, personas } from "./personas/models";
export { translations } from "./translations/translations.model";
