# Domain glossary

ruxia is a messaging app whose contacts are AI personas. The code, the GraphQL schema and
the collections speak English; the people who use it speak French, often. Each term is the
one the code uses, with the French it stands for. A term joins this table with the module
that introduces it. The specification is [docs/spec.md](docs/spec.md).

| Term (code)    | French      | Meaning                                                                                                                          |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Member         | membre      | A person with an account on this ruxia; `members` holds its name, locale, avatar and settings. Its id is the janus account's.    |
| Role           | rôle        | `admin` or `member`, held in janus's relations, never stored on the member. The last active admin cannot be demoted or disabled. |
| Invitation     | invitation  | The only way in: an admin invites an address with a role; the invitee accepts with a name and a password. No sign-up.            |
| Disabled       | désactivé   | A member with `disabledAt` set: janus refuses its sessions and sign-ins until an admin enables it.                               |
| Viewer         | utilisateur | The signed-in member as the session shows it: role, locale, second factor, passkeys, budget status.                              |
| MemberSettings | réglages    | Language fr/en, push previews, voice auto-play, default persona, "remember without asking" (spec 4.16).                          |
| BudgetStatus   | budget      | A placeholder until budgets land: no limit, nothing spent.                                                                       |
| Model          | modèle      | An entry of the model catalogue (`models`): public id, provider (Claude or Ollama), label, capabilities, context window, prices. |
| Enabled        | activé      | A model an admin allows conversations to use. Claude models start enabled; discovered Ollama models start disabled.              |
| Available      | disponible  | A model a send can reach now: always for Claude, for Ollama while the last probe saw its server up with the model installed.     |
| Probe          | sonde       | The check of the Ollama server every 30 s (`OLLAMA_BASE_URL`), cached in Redis for 90 s, which also lists new installed models.  |

Modules: `accounts` (sign-in, second factor, passkeys, step-up), `members`, `invitations`,
`models`, `translations` and `system`. Operator scripts: `admin:create <email>` (issues an admin
invitation and mails it; `--print-link` prints the link), `db:sync`, `db:migrate`,
`schema:print`.

## Headers

| Header           | Sent by      | Meaning                                                                                                         |
| ---------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `x-ruxia-client` | every client | Required on `/graphql` (any value, e.g. `ruxia-ui`): the CSRF defence, since a custom header needs a preflight. |

## Mail links

The links of the mails open the UI at: `/auth/accept-invitation?token=`,
`/auth/reset-password?token=`, `/auth/verify-email?token=` and `/settings/security`.

## Error codes

Every code has French and English texts in a data migration (`src/migrations`); the
inventory is `src/i18n/codes.ts`.

| Code                                 | Raised when                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `auth.errors.client-header-required` | `x-ruxia-client` is missing.                                                 |
| `auth.errors.unauthenticated`        | No valid session.                                                            |
| `auth.errors.forbidden`              | The role does not allow the operation.                                       |
| `auth.errors.second-factor-state`    | The second factor is already (or not) in the asked state.                    |
| `auth.errors.step-up-required`       | A sensitive operation needs a recent confirmation.                           |
| `auth.errors.invalid-code`           | A wrong second-factor or recovery code.                                      |
| `auth.errors.invalid-credentials`    | Wrong e-mail or password.                                                    |
| `auth.errors.invalid-token`          | An unknown, spent or expired link token.                                     |
| `auth.errors.too-many-attempts`      | Too many attempts in the window.                                             |
| `auth.errors.unavailable`            | A dependency (janus store, Redis) is down.                                   |
| `auth.errors.exhausted`              | The client's address is past its limit.                                      |
| `auth.errors.passkey-invalid`        | A passkey response that does not verify.                                     |
| `auth.errors.passkey-limit`          | The account holds its maximum of passkeys.                                   |
| `auth.errors.passkey-taken`          | The passkey is already registered.                                           |
| `invitations.errors.not-found`       | An id that names no invitation.                                              |
| `invitations.errors.not-pending`     | Revoking an invitation that is not pending.                                  |
| `invitations.errors.invalid`         | An unknown, spent or expired invitation token.                               |
| `invitations.errors.already-member`  | The address already has an account.                                          |
| `invitations.errors.already-pending` | The address is already invited (revoke first).                               |
| `invitations.errors.limit`           | Too many pending invitations.                                                |
| `invitations.errors.refused`         | janus refused the invitation.                                                |
| `invitations.errors.invalid-cursor`  | A cursor that does not belong to the list.                                   |
| `members.errors.not-found`           | An id that names no member.                                                  |
| `members.errors.last-admin`          | Demoting or disabling the last active administrator.                         |
| `members.errors.invalid-cursor`      | A cursor that does not belong to the list.                                   |
| `models.errors.not-found`            | An id that names no model of the catalogue (404).                            |
| `models.errors.disabled`             | Sending to a model an admin has not enabled (409).                           |
| `models.errors.offline`              | Sending to an Ollama model whose server is off or lacks it (409).            |
| `operator.errors.invalid-arguments`  | An operator script run with wrong arguments.                                 |
| `validation.errors.*`                | An input refused: `invalid-input` and each field's reason; the query limits. |
