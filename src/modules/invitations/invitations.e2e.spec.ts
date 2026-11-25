import { expect, test } from "bun:test";
import { graphqlPost } from "~/app";
import {
  authApp,
  signedInAccount,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";

// The whole onboarding over /graphql, as the UI does it: an administrator
// invites, the invitee accepts from the mailed link, signs in, and a member
// is then refused an administrator's mutation.
test("invite, accept, sign in, then the role guard refuses the member", async () => {
  const kit = authApp();
  const admin = await signedInAccount(kit, { role: "admin", name: "Root" });
  const post = async (query: string, variables: object, token?: string) =>
    (
      await graphqlPost(
        kit.app,
        JSON.stringify({ query, variables }),
        token ? { authorization: `Bearer ${token}` } : {},
      )
    ).json() as Promise<{
      data?: Record<
        string,
        { status?: string; token?: string; viewer?: { role: string } }
      >;
      errors?: { extensions?: { code?: string } }[];
    }>;

  const email = uniqueEmail("invitee");
  const invited = await post(
    "mutation($email: EmailAddress!) { inviteMember(email: $email, role: MEMBER) { id status } }",
    { email },
    admin.token,
  );
  expect(invited.data?.["inviteMember"]?.status).toBe("PENDING");
  await kit.auth.background.settled();
  const token = tokenSent(kit.mailer, email, "/auth/accept-invitation");

  const accepted = await post(
    'mutation($token: String!, $password: String!) { acceptInvitation(token: $token, name: "Mia", password: $password) { status } }',
    { token, password: specPassword },
  );
  expect(accepted.data?.["acceptInvitation"]?.status).toBe("SIGNED_IN");

  const signedIn = await post(
    "mutation($input: SignInInput!) { signIn(input: $input) { status token viewer { role } } }",
    { input: { email, password: specPassword } },
  );
  const session = signedIn.data?.["signIn"];
  if (!session) throw new Error("no sign-in");
  expect(session.status).toBe("SIGNED_IN");
  expect(session.viewer?.role).toBe("MEMBER");

  const refused = await post(
    "mutation($email: EmailAddress!) { inviteMember(email: $email, role: MEMBER) { id } }",
    { email: uniqueEmail("other") },
    session.token as string,
  );
  expect(refused.errors?.[0]?.extensions?.code).toBe("auth.errors.forbidden");

  const anonymous = await post(
    "mutation($email: EmailAddress!) { inviteMember(email: $email, role: MEMBER) { id } }",
    { email: uniqueEmail("anon") },
  );
  expect(anonymous.errors?.[0]?.extensions?.code).toBe(
    "auth.errors.unauthenticated",
  );
});
