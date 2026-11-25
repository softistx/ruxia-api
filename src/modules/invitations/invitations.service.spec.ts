import { describe, expect, test } from "bun:test";
import {
  type AuthApp,
  authApp,
  signedInAccount,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { sessionViewer } from "~/execute";
import { appMongo } from "../../config/db";
import { InvitationsService } from "./invitations.service";

const refused = (code: string) => ({ extensions: { code } });
const unlimited = async () => {};

async function adminService(kit: AuthApp) {
  const admin = await signedInAccount(kit, { role: "admin", name: "Root" });
  const viewer = await sessionViewer(kit, admin.token);
  const service = new InvitationsService(
    appMongo,
    kit.auth,
    viewer,
    unlimited,
    () => kit.clock.now(),
  );
  return { admin, service };
}

const anonymousService = (kit: AuthApp) =>
  new InvitationsService(appMongo, kit.auth, null, unlimited, () =>
    kit.clock.now(),
  );

describe("InvitationsService", () => {
  test("invites an address, mails the link and lists it as pending", async () => {
    const kit = authApp();
    const { service } = await adminService(kit);
    const email = uniqueEmail("guest");
    const invitation = await service.invite(
      ` ${email.toUpperCase()} `,
      "member",
    );
    expect(invitation).toMatchObject({
      email,
      role: "member",
      status: "PENDING",
    });
    await kit.auth.background.settled();
    expect(
      tokenSent(kit.mailer, email, "/auth/accept-invitation"),
    ).toBeTruthy();
    const page = await service.list({ status: "PENDING", first: 100 });
    expect(page.edges.map((edge) => edge.node.id)).toContain(invitation.id);
  });

  test("an address that is already a member is refused", async () => {
    const kit = authApp();
    const { service } = await adminService(kit);
    const member = await signedInAccount(kit);
    await expect(service.invite(member.email, "member")).rejects.toMatchObject(
      refused("invitations.errors.already-member"),
    );
  });

  test("inviting an address again leaves one pending invitation for it", async () => {
    const kit = authApp();
    const { service } = await adminService(kit);
    const email = uniqueEmail("twice");
    await service.invite(email, "member");
    await service.invite(email, "admin");
    const page = await service.list({ status: "PENDING", first: 100 });
    const held = page.edges.filter((edge) => edge.node.email === email);
    expect(held).toHaveLength(1);
    expect(held[0]?.node.role).toBe("admin");
  });

  test("a pending invitation past its date is EXPIRED", async () => {
    const kit = authApp();
    const { service } = await adminService(kit);
    const invitation = await service.invite(uniqueEmail("late"), "member");
    kit.clock.advance(
      invitation.expiresAt.getTime() - kit.clock.now().getTime() + 1000,
    );
    const page = await service.list({ status: "EXPIRED", first: 100 });
    expect(page.edges.map((edge) => edge.node.id)).toContain(invitation.id);
  });

  test("revokes a pending invitation once, and an unknown id is not-found", async () => {
    const kit = authApp();
    const { service } = await adminService(kit);
    const invitation = await service.invite(uniqueEmail("gone"), "member");
    expect((await service.revoke(invitation.id)).status).toBe("REVOKED");
    await expect(service.revoke(invitation.id)).rejects.toMatchObject(
      refused("invitations.errors.not-pending"),
    );
    await expect(service.revoke("nope")).rejects.toMatchObject(
      refused("invitations.errors.not-found"),
    );
  });

  test("a bad token is invalid; a good one previews, then accepts with the chosen name", async () => {
    const kit = authApp();
    const { service } = await adminService(kit);
    const anonymous = anonymousService(kit);
    await expect(anonymous.preview("bad-token")).rejects.toMatchObject(
      refused("invitations.errors.invalid"),
    );
    const email = uniqueEmail("new");
    await service.invite(email, "admin");
    await kit.auth.background.settled();
    const token = tokenSent(kit.mailer, email, "/auth/accept-invitation");
    expect(await anonymous.preview(token)).toMatchObject({
      email,
      role: "admin",
    });
    const payload = await anonymous.accept(
      token,
      "  Nora  ",
      "a long password",
    );
    expect(payload.status).toBe("SIGNED_IN");
    const member = await appMongo.db.members.find({ email }).toArray();
    expect(member[0]).toMatchObject({ name: "Nora" });
    await expect(
      anonymous.accept(token, "Nora", "a long password"),
    ).rejects.toMatchObject(refused("invitations.errors.invalid"));
  });

  test("a blank name is a validation issue", async () => {
    const kit = authApp();
    await expect(
      anonymousService(kit).accept("token", "   ", "a long password"),
    ).rejects.toMatchObject(refused("validation.errors.invalid-input"));
  });
});
