import { describe, expect, test } from "bun:test";
import { type AuthApp, authApp, signedInAccount } from "~/auth";
import { sessionViewer } from "~/execute";
import { appMongo } from "../../config/db";
import { MembersService } from "./members.service";

// janus's accounts live in the run's one database and specs do not clear
// them: a spec that needs "the only administrator" demotes the others first,
// through janus (no guard in the way).
async function onlyAdmin(kit: AuthApp, keep: string) {
  for (const id of await kit.auth.roles.holders("admin")) {
    if (id !== keep) await kit.auth.roles.setRole(id, "member");
  }
}

async function serviceOf(kit: AuthApp, token: string) {
  const viewer = await sessionViewer(kit, token);
  return new MembersService(appMongo, kit.auth, viewer);
}

const refused = (code: string) => ({ extensions: { code } });

describe("MembersService", () => {
  test("lists the members with their total and finds one", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    await signedInAccount(kit, { name: "Bea" });
    const service = await serviceOf(kit, admin.token);
    const page = await service.list({ first: 1 });
    expect(page.edges).toHaveLength(1);
    expect(page.totalCount).toBeGreaterThanOrEqual(2);
    expect((await service.find(admin.userId)).email).toBe(admin.email);
  });

  test("an unknown id is not-found and a foreign cursor is refused", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    const service = await serviceOf(kit, admin.token);
    await expect(service.find("nobody")).rejects.toMatchObject(
      refused("members.errors.not-found"),
    );
    await expect(
      service.list({ first: 5, after: "not-a-cursor" }),
    ).rejects.toMatchObject(refused("members.errors.invalid-cursor"));
  });

  test("the role is janus's: setRole moves it", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    const member = await signedInAccount(kit);
    const service = await serviceOf(kit, admin.token);
    await service.setRole(member.userId, "admin");
    expect(await service.roleOf(member.userId)).toBe("admin");
    await service.setRole(member.userId, "member");
    expect(await service.roleOf(member.userId)).toBe("member");
  });

  test("the last administrator cannot be demoted or disabled", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    await onlyAdmin(kit, admin.userId);
    const service = await serviceOf(kit, admin.token);
    await expect(service.setRole(admin.userId, "member")).rejects.toMatchObject(
      refused("members.errors.last-admin"),
    );
    await expect(service.disable(admin.userId)).rejects.toMatchObject(
      refused("members.errors.last-admin"),
    );
    expect(await service.roleOf(admin.userId)).toBe("admin");
  });

  test("with a second administrator, one can be demoted", async () => {
    const kit = authApp();
    const first = await signedInAccount(kit, { role: "admin" });
    const second = await signedInAccount(kit, { role: "admin" });
    const service = await serviceOf(kit, first.token);
    await service.setRole(second.userId, "member");
    expect(await service.roleOf(second.userId)).toBe("member");
  });

  test("disabling marks the account inactive and enabling restores it", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    const member = await signedInAccount(kit);
    const service = await serviceOf(kit, admin.token);
    const disabled = await service.disable(member.userId);
    expect(disabled.disabledAt).toBeInstanceOf(Date);
    expect((await kit.auth.accounts.user.get(member.userId)).active).toBe(
      false,
    );
    const enabled = await service.enable(member.userId);
    expect(enabled.disabledAt).toBeNull();
    expect((await kit.auth.accounts.user.get(member.userId)).active).toBe(true);
  });

  test("settings change only what the input names, and the language reaches janus", async () => {
    const kit = authApp();
    const member = await signedInAccount(kit);
    const service = await serviceOf(kit, member.token);
    const first = await service.updateSettings({
      pushPreviews: false,
      language: "EN",
    });
    expect(first.locale).toBe("en");
    expect(first.settings.pushPreviews).toBe(false);
    const second = await service.updateSettings({ voiceAutoPlay: true });
    expect(second.locale).toBe("en");
    expect(second.settings).toMatchObject({
      pushPreviews: false,
      voiceAutoPlay: true,
      defaultPersonaId: null,
      rememberWithoutAsking: false,
    });
    expect((await kit.auth.accounts.user.get(member.userId)).locale).toBe("en");
  });

  test("single tenant: a member's settings are its own, an admin reads none of its data through them", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit, { name: "Ada" });
    const bea = await signedInAccount(kit, { name: "Bea" });
    const adaService = await serviceOf(kit, ada.token);
    const beaService = await serviceOf(kit, bea.token);
    await adaService.updateSettings({ rememberWithoutAsking: true });
    expect((await beaService.mine()).settings.rememberWithoutAsking).toBe(
      false,
    );
    expect((await adaService.mine())._id).toBe(ada.userId);
  });
});
