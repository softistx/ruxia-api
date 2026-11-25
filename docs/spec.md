# ruxia-api: specification (v1)

The GraphQL API of ruxia, a messaging app whose contacts are AI personas. This document
is the v1 contract: modules, entities, rules and what each slice must deliver. The UI's
side is `ruxia-ui/docs/spec.md`; the slices are the issues listed in the tracking issue.

## 1. Scope and principles

- **Single tenant**: one team, no workspaces. Accounts are janus accounts with one role,
  `admin` or `member`. No public sign-up: an admin invites by e-mail, the invitation is
  proved by its token.
- **Privacy**: a conversation, its messages, attachments, memory and projects belong to
  their user. **The admin cannot read a member's conversations** (no resolver, script or
  admin view exposes them; a leak spec proves it). The admin sees usage figures only.
- **Retention**: kept until the user deletes them (soft delete, then a purge job after
  30 days). Export as Markdown or JSON.
- **Stack**: Bun, alxia (`@alxia/core`, `@alxia/graphql`, `@alxia/i18n`), GraphQL Yoga,
  `@softistx/mongo` (MongoDB 8), `@softistx/redis`, `@softistx/s3`, `@softistx/janus`,
  `@softistx/mail`, and the house AI SDK `@softistx/ai-*` (see §3). Conventions are the
  `alxia-graphql-api` plugin's (module per role, guards first, error codes inventory,
  committed `schema.graphql`, data migrations that only grow).
- **Transport**: GraphQL for everything; a run's events stream as Server-Sent Events
  through `@softistx/ai-alxia` (`agentEvents`). Media go through `@alxia/media` routes over
  a private bucket (keys in the schema, never URLs). The API has no public hostname: the
  UI's BFF calls it server side.
- **Deploy**: the VPS, Docker compose with `deploy.resources.limits` on every service
  (api, mongo, redis, seaweedfs or minio, searxng, whisper, piper, ollama-embed), light
  healthchecks, old images pruned after each deploy.

## 2. Models

| Provider | Package | Notes |
| --- | --- | --- |
| Claude | `@softistx/ai-anthropic` | streaming, thinking, prompt caching, vision; web search via the Anthropic server tool |
| Ollama on the owner's Mac | `@softistx/ai-ollama` | reached over Tailscale; free (no cost counted); **offline** when the Mac is off |

- A **model catalogue** (`models` module) lists the enabled models: id, provider, label,
  capabilities (`tools`, `vision`, `thinking`, `webSearch`), context window, prices per
  million tokens (Claude only). The admin enables or disables models.
- **Availability**: Ollama models carry `available: Boolean!` from a cached health probe
  (every 30 s, Redis, short timeout). The UI greys an unavailable model as "offline"; a
  send to an offline model is refused with `models.errors.offline`.
- Each conversation picks its model (defaulting to its persona's), and may switch it
  between turns.

## 3. Reuse of the house AI SDK

| Need | Package | Status |
| --- | --- | --- |
| agent loop, zod tools, proposed actions (confirmed writes), structured output | `@softistx/ai-core` | shipped |
| Claude adapter | `@softistx/ai-anthropic` | shipped; server web search tool: **upstream** |
| Ollama adapter | `@softistx/ai-ollama` | shipped; health and installed models, image parts: **upstream** |
| conversation store and compaction | `@softistx/ai-memory/mongo` | shipped (threads and messages scoped by owner) |
| MCP servers' tools as agent tools, confirmation for writes | `@softistx/ai-mcp/client` | shipped |
| request middleware (abort, language), SSE reply | `@softistx/ai-alxia` | shipped |
| run spans with `gen_ai.*` attributes | `@softistx/ai-telemetry` | shipped |
| fake model in specs | `@softistx/ai-testing` | shipped |
| embeddings for RAG | `@softistx/ai-core` + `@softistx/ai-ollama` | **upstream** (an embeddings port) |
| web search for Ollama models | — | **upstream** (SearXNG tool) |
| cost of a usage | `@softistx/ai-anthropic` | **upstream** (price table) |
| a run that outlives its client, resumable SSE | `@softistx/ai-alxia` | **upstream** |
| PDF attachments sent whole | `@softistx/ai-core` + `@softistx/ai-anthropic` | **upstream** (softistx/ai#154) |

No app-side replacement is written for an upstream gap: the slice that needs it waits for
the release (`Temporary, until` only if the owner asks for a stopgap).

Branches, long-term memory, budgets, projects and the vector index are ruxia's own domain
(the SDK's roadmap leaves retrieval and cross-thread search to applications).

## 4. Modules

Each module: model, collections, SDL, service with spec, resolver, error codes, e2e spec.

### 4.1 `auth` and `members` (slice 1)

- janus accounts: password and passkey sign-in, second factor optional, sessions; e-mail
  verification through the invitation.
- `Member { id, name, email, role: ADMIN | MEMBER, avatarKey, locale, createdAt, disabledAt }`.
- Admin: `inviteMember(email, role)`, `revokeInvitation`, `setMemberRole`,
  `disableMember`, `enableMember`. The last admin cannot be demoted or disabled.
- `acceptInvitation(token, name, password)` (anonymous, throttled per address).
- `viewer` query: the signed-in member, their role and budget status.
- Guards: `requireMember`, `requireAdmin` (in `src/auth` only).
- Bootstrap: `bun run admin:create <email>` creates the first admin.

### 4.2 `models`

`models` query (enabled models with availability), admin `setModelEnabled`, the health
probe, the price table (from upstream; overridable by a migration).

### 4.3 `personas`

- `Persona { id, ownerId, name, avatarKey, tagline, personality (system prompt), defaultModelId,
  tools: { webSearch, artifacts, memory, mcpServerIds[] }, projectIds[], voiceId,
  visibility: PRIVATE | TEAM, featured: Boolean, createdAt, updatedAt, version }`.
- A member creates, edits, duplicates and deletes their own personas; `visibility: TEAM`
  shares one read-only with the team (others may start a conversation or duplicate it).
- **Catalogue**: `catalogue(filter)` lists the team-visible personas; the admin curates
  `featured` personas and their order (`setPersonaFeatured`, `reorderFeatured`).
- A deleted persona keeps its past conversations readable (snapshot of name and avatar on
  the conversation).
- Errors: `personas.errors.not-found`, `.not-owner`, `.model-unavailable`, `.version-conflict`.

### 4.4 `conversations`

- `Conversation { id, ownerId, personaId, personaSnapshot, modelId, title, pinned,
  archivedAt, deletedAt, lastMessageAt, activeLeafId, projectId? }`.
- List: cursor connection ordered by `lastMessageAt`, filters (persona, pinned, archived),
  full-text **search** over titles and message text (MongoDB text index, owner-scoped).
- Title generated after the first exchange (a short `generateObject` on a cheap model).
- `exportConversation(id, format: MARKDOWN | JSON)` returns a media key of the file;
  `deleteConversation` (soft), `restoreConversation` within 30 days, purge job after.

### 4.5 `messages` and branches

- Messages form a **tree**: `Message { id, conversationId, parentId?, role: USER | ASSISTANT,
  parts (text, image, attachment refs, tool calls and results, proposed actions,
  citations, artifact refs), modelId, usage, cost, status: STREAMING | DONE | FAILED | STOPPED,
  reactions[], pinned, createdAt }`.
- `sendMessage(conversationId, parentId?, text, attachmentIds[])` starts a run and returns
  its `runId`; the reply streams at `GET /runs/:runId/events` (SSE through `agentEvents`,
  with a heartbeat). A run **continues when the client leaves** (a phone locks, a tab
  closes) and its events are buffered so a reconnect resumes from `Last-Event-ID`; today
  `agentEvents` stops the run on disconnect, so this waits for the upstream detached run
  and resumable stream.
- `stopRun(runId)` aborts; the partial reply is kept with `status: STOPPED`.
- **Edit**: `editMessage(messageId, text)` creates a sibling user message and a new reply
  (a new branch). **Regenerate**: `regenerate(messageId, modelId?)` creates a sibling
  assistant message. `siblings` and `activeLeafId` let the UI switch branches
  (`setActiveBranch`).
- The model context is the path root → leaf, compacted by `@softistx/ai-memory`'s
  `compact` when it nears the window.
- **Reactions** (`react(messageId, emoji)`, one per user per emoji) and **pins**
  (`pinMessage`, `pinnedMessages(conversationId)`).
- **Typing indicator**: in a conversation it comes from the stream's own events
  (thinking, text, tool); for lists and push, `Conversation.runState: IDLE | THINKING |
  TYPING | TOOL` is read from the live run's state in Redis.

### 4.6 `attachments`

- Upload through `@alxia/media` over a private `@softistx/s3` bucket: images (jpeg, png,
  webp, gif, ≤ 10 MB), PDF and text files (≤ 20 MB). MIME type sniffed server side.
- Images go to the model as `image` parts (Claude; Ollama vision once upstream). PDF:
  text extracted for every model; sent whole to Claude once softistx/ai#154 ships.
- Per-user upload throttle; keys only in the schema.

### 4.7 `projects` and RAG

- `Project { id, ownerId, name, instructions, documents[], personaIds[] }`: a member
  groups documents and conversations; a persona may be bound to projects.
- Documents: uploaded files (PDF, Markdown, text, docx later) chunked (~800 tokens,
  overlap 100), **embedded with Ollama `nomic-embed-text` on the VPS** (Assumed, not
  answered) through the upstream embeddings port, stored in `chunks` with a MongoDB 8
  vector index (768 dims, cosine), filtered by `ownerId` and `projectId`.
- Indexing is a background job (Redis queue through `@softistx/redis`); `Document.status:
  PENDING | INDEXED | FAILED`.
- Retrieval is an agent tool `search_project(query)` given to runs in a project (top 6
  chunks, citations returned as parts), plus the project's `instructions` in the system
  prompt.

### 4.8 `memory` (long-term, per persona and user)

- `MemoryItem { id, ownerId, personaId, text, source: MODEL | USER, createdAt, updatedAt }`.
- Tools given to a run when the persona enables memory: `remember(text)` (a proposed
  action shown to the user, auto-confirmed when the user set "remember without asking"),
  `forget(id)`. The persona's memory items are injected in the system prompt (capped,
  newest first).
- The user lists, edits, deletes and adds items (`memoryItems(personaId)`,
  `updateMemoryItem`, `deleteMemoryItem`, `clearMemory(personaId)`).

### 4.9 `mcp-servers`

- Admin registers servers: `McpServer { id, name, url (Streamable HTTP), authHeaderSecret
  (encrypted at rest), allowList[], enabled }`; stdio servers are not allowed on the VPS.
- `testMcpServer(id)` lists its tools. Each persona enables the servers it uses.
- Tools come from `@softistx/ai-mcp/client` (`mcpTools`) with a name prefix; **every tool
  that is not annotated read-only is proposed and runs only once the user confirms**
  (`confirmAction(actionId)`, `rejectAction(actionId)`; TTL 15 min).
- Output framed as untrusted data (the SDK does it).

### 4.10 Web search

- Claude: the Anthropic server web search tool (upstream), citations kept as parts.
- Ollama: a SearXNG instance on the VPS (compose, limits), through the upstream tool.
- Enabled per persona (`tools.webSearch`); the search count is part of usage and cost.

### 4.11 Artifacts

- A tool `create_artifact({ kind: HTML | SVG | MARKDOWN | CODE | MERMAID, title, content })`
  and `update_artifact(id, content)`; each update is a new version.
- `Artifact { id, conversationId, messageId, kind, title, versions[] }`; served to the UI
  as content (never executed by the API). The UI renders HTML and SVG in a sandboxed
  iframe on a separate origin-less `srcdoc` with a strict CSP (see UI spec).

### 4.12 Budgets and usage

- Every assistant message stores `usage` (input, output, cache read/write, searches) and
  `cost` in USD (Claude via the upstream price table; Ollama 0).
- `Budget { memberId, monthlyUsd }` set by the admin (default from settings). The month
  is the calendar month in America/Toronto.
- At **80 %** the member is alerted once (in-app notice and push, mail to the member);
  at **100 %** a send to a paid model is refused with `budgets.errors.exhausted` (Ollama
  stays usable). The admin may raise the budget at once.
- A run in flight is allowed to finish; its cost may overshoot slightly (documented).
- `usage(month)` for the viewer; admin `teamUsage(month)` per member and per model
  (figures only, never content).

### 4.13 Voice

- **Speech to text**: `transcribe(mediaKey)` → text, through a Whisper server on the VPS
  (faster-whisper HTTP, compose with limits).
- **Text to speech**: `GET /speech/:messageId` streams audio from Piper on the VPS with
  the persona's `voiceId` (a list of installed Piper voices per language).
- Audio files are attachments (owner-scoped, throttled).

### 4.14 Push

- Web Push (VAPID keys from the environment): `subscribePush(subscription)`,
  `unsubscribePush`. A push is sent when a reply finishes and the member has no open
  stream on it, and for budget alerts. Payloads carry no message text unless the member
  opts in ("show previews").

### 4.15 `admin`

- Members and invitations (§4.1), budgets (§4.12), model enablement (§4.2), MCP servers
  (§4.9), featured catalogue (§4.3), team usage, default settings (default budget,
  default model, retention purge delay).
- Audit log of admin actions (who, what, when). No access to conversations, messages,
  attachments, memory or projects of others.

### 4.16 `settings` (per member)

Language (fr, en), default persona, "remember without asking", push previews, voice
auto-play.

## 5. Security

- Guards first in every resolver; owner scoping on every owner collection (`ownerId` in
  every query; a spec per module proves another member gets `not-found`).
- Prompt injection: tool outputs (MCP, web, RAG chunks) are framed untrusted; writes go
  through proposed actions; artifacts never run on the app origin.
- Secrets: MCP auth headers encrypted with a key from the environment; never returned.
- Rate limits through the Throttle port (Redis): sign-in, invitation, sends per minute,
  uploads, transcriptions.

## 6. Out of v1

Proactive messages; persona groups (v1.1); conversations with humans (v2); native apps;
public sign-up; several tenants.
