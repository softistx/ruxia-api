import { InvalidCursorError } from "@softistx/mongo";
import type { Role } from "../../auth/access";
import type { Auth } from "../../auth/auth";
import type { Viewer } from "../../auth/viewer";
import type { AppMongo } from "../../config/db";
import type { MemberSettingsInput } from "../../generated/graphql/resolvers";
import { toConnection } from "../../shared/pagination";
import { authCall } from "../accounts";
import { invalidCursor, lastAdmin, notFound } from "./members.errors";
import type { MemberDocument } from "./members.model";
import { settingsPatch } from "./members.utils";

// The members, for one request: the resolver ran the guard first (admin for
// the management, member for the own settings). The role is janus's, read
// from `auth.roles`, never stored on the document.
export class MembersService {
  constructor(
    private readonly mongo: AppMongo,
    private readonly auth: Pick<Auth, "accounts" | "roles">,
    private readonly viewer: Viewer | null,
  ) {}

  // The acting account: reached only past the guards, which refuse an
  // anonymous request.
  private get actor() {
    if (!this.viewer) throw new Error("members: an operation needs a viewer");
    return this.viewer.id;
  }

  private get members() {
    return this.mongo.as(this.actor).db.members;
  }

  // A page of members, oldest first.
  async list(args: {
    first?: number | null | undefined;
    after?: string | null | undefined;
  }) {
    try {
      const [page, total] = await Promise.all([
        this.members.paginateByCursor({
          orderBy: "createdAt",
          limit: args.first ?? 20,
          after: args.after,
          scope: "members",
        }),
        this.members.count(),
      ]);
      return toConnection(args.after, page, total);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw invalidCursor();
      throw error;
    }
  }

  // One member: 404 for an id that names none.
  async find(id: string): Promise<MemberDocument> {
    const found = await this.members.findById(id);
    if (!found) throw notFound();
    return found;
  }

  // The names of these members, in the order asked (an empty name for an id
  // that names none): what a DataLoader batch returns. No guard here: the
  // caller shows a name only of an owner it already let the viewer read.
  async namesOf(ids: readonly string[]) {
    const found = await this.members.findMany({
      filter: { _id: { $in: [...ids] } },
    });
    const names = new Map(found.map((member) => [member._id, member.name]));
    return ids.map((id) => ({ id, name: names.get(id) ?? "" }));
  }

  // Every member's id and name, for the team's usage figures (administrators
  // only: the resolver ran the guard).
  async roster() {
    const found = await this.members.findMany({});
    return found.map((member) => ({ id: member._id, name: member.name }));
  }

  // The member's role: null for an account that holds none.
  roleOf(id: string): Promise<Role | null> {
    return this.auth.roles.roleOf(id);
  }

  // Gives the member `role` as its only one. Demoting the last active
  // administrator is refused, inside the platform's lock so two demotions at
  // once cannot both pass.
  async setRole(id: string, role: Role): Promise<MemberDocument> {
    const member = await this.find(id);
    await this.auth.roles.setRole(id, role, {
      before: async () => {
        if (role !== "admin") await this.keepAnAdmin(id);
      },
    });
    return member;
  }

  // Signs the member out for good until enabled: janus refuses its sessions
  // and sign-ins, and the document says when.
  async disable(id: string): Promise<MemberDocument> {
    const member = await this.find(id);
    if (member.disabledAt !== null) return member;
    return this.auth.roles.underLock(async () => {
      await this.keepAnAdmin(id);
      await this.setActive(id, false);
      return this.members.update(id, { disabledAt: new Date() });
    });
  }

  async enable(id: string): Promise<MemberDocument> {
    const member = await this.find(id);
    if (member.disabledAt === null) return member;
    await this.setActive(id, true);
    return this.members.update(id, { disabledAt: null });
  }

  // The signed-in member's own document.
  mine(): Promise<MemberDocument> {
    return this.find(this.actor);
  }

  // Changes what the input names of the member's settings. The language is the
  // account's too (it writes the mails), so janus's is changed with it.
  async updateSettings(input: MemberSettingsInput): Promise<MemberDocument> {
    const member = await this.mine();
    const patch = settingsPatch(member, input);
    if (patch.locale !== undefined) {
      const locale = patch.locale;
      await authCall(async () => {
        const users = this.auth.accounts.user;
        await users.update(await users.get(this.actor), { locale });
      });
    }
    return this.members.update(this.actor, patch);
  }

  // Refuses when `id` is the only active administrator left. Reads the admins
  // under the platform's lock (callers hold it).
  private async keepAnAdmin(id: string) {
    const admins = await this.auth.roles.holders("admin");
    if (!admins.includes(id)) return;
    const active = await this.members
      .find({ _id: { $in: admins }, disabledAt: null })
      .toArray();
    if (!active.some((admin) => admin._id === id)) return;
    if (active.every((admin) => admin._id === id)) throw lastAdmin();
  }

  private setActive(id: string, active: boolean) {
    return authCall(async () => {
      const users = this.auth.accounts.user;
      await users.setActive(await users.get(id), active);
    });
  }
}
