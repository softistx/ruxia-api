# Domain glossary

ruxia is a messaging app whose contacts are AI personas. The code, the GraphQL schema and
the collections speak English; the people who use it speak French, often. Each term is the
one the code uses, with the French it stands for. A term joins this table with the module
that introduces it. The specification is [docs/spec.md](docs/spec.md).

| Term (code)    | French       | Meaning                                                                                                                                 |
| -------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Member         | membre       | A person with an account on this ruxia; `members` holds its name, locale, avatar and settings. Its id is the janus account's.           |
| Role           | rôle         | `admin` or `member`, held in janus's relations, never stored on the member. The last active admin cannot be demoted or disabled.        |
| Invitation     | invitation   | The only way in: an admin invites an address with a role; the invitee accepts with a name and a password. No sign-up.                   |
| Disabled       | désactivé    | A member with `disabledAt` set: janus refuses its sessions and sign-ins until an admin enables it.                                      |
| Viewer         | utilisateur  | The signed-in member as the session shows it: role, locale, second factor, passkeys, budget status.                                     |
| MemberSettings | réglages     | Language fr/en, push previews, voice auto-play, default persona, "remember without asking" (spec 4.16).                                 |
| BudgetStatus   | budget       | A placeholder until budgets land: no limit, nothing spent.                                                                              |
| Model          | modèle       | An entry of the model catalogue (`models`): public id, provider (Claude or Ollama), label, capabilities, context window, prices.        |
| Enabled        | activé       | A model an admin allows conversations to use. Claude models start enabled; discovered Ollama models start disabled.                     |
| Available      | disponible   | A model a send can reach now: always for Claude, for Ollama while the last probe saw its server up with the model installed.            |
| Probe          | sonde        | The check of the Ollama server every 30 s (`OLLAMA_BASE_URL`), cached in Redis for 90 s, which also lists new installed models.         |
| Persona        | persona      | An AI contact a member creates (`personas`): name, avatar, tagline, personality (the system prompt), default model, tools.              |
| Visibility     | visibilité   | `PRIVATE` (the owner only) or `TEAM` (every member reads and starts it, only the owner edits; others duplicate it into a PRIVATE copy). |
| Catalogue      | catalogue    | The TEAM personas, read with `catalogue(filter)`; the admin features some and orders them (`setPersonaFeatured`, `reorderFeatured`).    |
| Featured       | mis en avant | A TEAM persona the admin placed (`featuredRank`) at the top of the catalogue. Making it PRIVATE again unfeatures it.                    |

Modules: `accounts` (sign-in, second factor, passkeys, step-up), `members`, `invitations`,
`models`, `personas`, `translations` and `system`. Operator scripts: `admin:create <email>` (issues an admin
invitation and mails it; `--print-link` prints the link), `db:sync`, `db:migrate`,
`schema:print`.

## Media

Files go through `@softistx/alxia-media` routes beside `/graphql`, over the private `S3_*` bucket (no URL ever leaves the API; the UI builds `/media/<kind>/<key>/<size>` on its own origin). One kind: `persona-avatars` (`PUT` and `GET`, no `DELETE`; png, jpeg or webp up to 2 MiB, at least 64 px a side). A `PUT` answers `{ key, contentType, size }`. The upload is re-encoded into PNG squares of 256 and 64 px and never stored, so its EXIF and GPS data are dropped: only `/media/persona-avatars/<key>/256` and `/64` are served (the bare key is 404). The key is the uploader's until a persona carries it, then read by the persona's readers. Limits: `media-uploads` 30 an hour per account (burst 10, fails open) and a quota of 50 files per member (402 `quota_exceeded`). An upload whose key cannot be recorded is removed at once. Files are otherwise kept: a deleted persona keeps its avatar.

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

| Code                                 | Raised when                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.errors.client-header-required` | `x-ruxia-client` is missing.                                                                                                                         |
| `auth.errors.unauthenticated`        | No valid session.                                                                                                                                    |
| `auth.errors.forbidden`              | The role does not allow the operation.                                                                                                               |
| `auth.errors.second-factor-state`    | The second factor is already (or not) in the asked state.                                                                                            |
| `auth.errors.step-up-required`       | A sensitive operation needs a recent confirmation.                                                                                                   |
| `auth.errors.invalid-code`           | A wrong second-factor or recovery code.                                                                                                              |
| `auth.errors.invalid-credentials`    | Wrong e-mail or password.                                                                                                                            |
| `auth.errors.invalid-token`          | An unknown, spent or expired link token.                                                                                                             |
| `auth.errors.too-many-attempts`      | Too many attempts in the window.                                                                                                                     |
| `auth.errors.unavailable`            | A dependency (janus store, Redis) is down.                                                                                                           |
| `auth.errors.exhausted`              | The client's address is past its limit.                                                                                                              |
| `auth.errors.passkey-invalid`        | A passkey response that does not verify.                                                                                                             |
| `auth.errors.passkey-limit`          | The account holds its maximum of passkeys.                                                                                                           |
| `auth.errors.passkey-taken`          | The passkey is already registered.                                                                                                                   |
| `invitations.errors.not-found`       | An id that names no invitation.                                                                                                                      |
| `invitations.errors.not-pending`     | Revoking an invitation that is not pending.                                                                                                          |
| `invitations.errors.invalid`         | An unknown, spent or expired invitation token.                                                                                                       |
| `invitations.errors.already-member`  | The address already has an account.                                                                                                                  |
| `invitations.errors.already-pending` | The address is already invited (revoke first).                                                                                                       |
| `invitations.errors.limit`           | Too many pending invitations.                                                                                                                        |
| `invitations.errors.refused`         | janus refused the invitation.                                                                                                                        |
| `invitations.errors.invalid-cursor`  | A cursor that does not belong to the list.                                                                                                           |
| `members.errors.not-found`           | An id that names no member.                                                                                                                          |
| `members.errors.last-admin`          | Demoting or disabling the last active administrator.                                                                                                 |
| `members.errors.invalid-cursor`      | A cursor that does not belong to the list.                                                                                                           |
| `models.errors.not-found`            | An id that names no model of the catalogue (404).                                                                                                    |
| `models.errors.disabled`             | Sending to a model an admin has not enabled (409).                                                                                                   |
| `models.errors.offline`              | Sending to an Ollama model whose server is off or lacks it (409: a state refusal the UI shows as an offline model, never an outage to retry).        |
| `personas.errors.not-found`          | An id that names no persona the viewer may read: unknown, deleted, or another member's PRIVATE one (404). Also `ids.<i>` of `reorderFeatured`.       |
| `personas.errors.not-owner`          | Changing or deleting a TEAM persona that is not yours (403); duplicate it instead.                                                                   |
| `personas.errors.model-unavailable`  | `defaultModelId` names no model, or one an administrator has not enabled (409, `extensions.field` `defaultModelId`). An offline Ollama model passes. |
| `personas.errors.version-conflict`   | `updatePersona` sent a `version` that is not the persona's current one (409): read it again.                                                         |
| `personas.errors.invalid-cursor`     | A cursor that does not belong to the list (400).                                                                                                     |
| `operator.errors.invalid-arguments`  | An operator script run with wrong arguments.                                                                                                         |
| `validation.errors.*`                | An input refused: `invalid-input` and each field's reason; the query limits.                                                                         |

The `validation.errors.*` wildcard row is deliberate, not a shortcut: those codes come from `@softistx/graphql-validation`, which owns the list, so this table does not copy it.
