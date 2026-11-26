# ruxia-api: rules for agents and contributors

The GraphQL API of ruxia, a messaging app whose contacts are AI personas: Bun, alxia,
GraphQL Yoga, `@softistx/mongo`, `@softistx/redis`, `@softistx/s3`, `@softistx/janus` and
the house AI SDK `@softistx/ai-*`. The specification is [docs/spec.md](docs/spec.md), the
roadmap [docs/roadmap.md](docs/roadmap.md).

The owner's rules for every repository are in `~/.claude/CLAUDE.md`; this file states
only what is ruxia-api's own. The stack's conventions are the `alxia-graphql-api` plugin's
(`build-an-alxia-graphql-api`, `add-a-module`, its `conventions-reviewer`), and they
apply here **in full**: every rule of those skills counts as stated in this file, so the
`conventions-reviewer` counts it, except where a line below departs from it (single
tenant: no `scoped()` tenancy). Background jobs that keep a module's data current while
the server runs (such as `models.probe.ts`) are the `reload` role under another name.
**System jobs**: the boot `sweep` (`sweepRuns`) and the daily `purge`
(`ConversationsPurge`) are started from `server.ts` only, never by a request or a
spec (specs call `tick` themselves), through an explicit ticker port that is
unref'd. They may read and delete across owners (raw, no viewer), because no
member owns them, but they never expose content: nothing they read is logged,
returned or mailed beyond ids and counts. The purge takes each conversation by a
conditional claim (`purgingAt`) that a restore cannot pass. The purge never touches
`spend` (the figures ledger that budgets read).
The projects add two more system jobs, started from `server.ts` only: the
`IndexingWorker` (the `indexing` queue of `@softistx/redis`, or `localQueues` in
this process without `REDIS_URL`) and the daily `ProjectsPurge` (same ticker port
and `purgingAt` claim as the conversations'). They read and write across owners
(raw, no viewer) and never log or return content. Vector search is behind the
`VectorIndex` port (MongoDB `$vectorSearch` in production, in-memory cosine in
specs): every search names the owner and one project.
The **budget alert** is a background notice, not a ticker job: it runs after a run's end
without a request viewer, writes only `budgetAlerts`, and mails the member through
`auth.mailer` in the background (a failed send is logged, never retried).

- **Single-item deletes**: `deleteConversation(id)` and `restoreConversation(id)`
  return the conversation (an app departure from the bulk form of the stack
  skills: soft delete with a 30-day restore, one item at a time, the UI needs the
  entity for its undo). `deleteAttachment(id)` is single-item too: it is the UI's
  per-chip remove of one unsent upload, answers the id, and is refused once a message
  carries the file (Assumed, not answered: the recommended option, taken in the
  night window). The same holds for `deleteProject(id)` and `restoreProject(id)`
  (the project, as the conversation's: soft delete with a 30-day restore),
  `deleteProjectDocument(id)` (answers the id), `deletePersona(id)` and
  `deleteMemoryItem(id)`: per-item UI actions, not bulk ones (Assumed, not
  answered: the recommended option, taken in the night window).

- **Coordination**: the ruxia session in `~/workspace/dev/ruxia/` coordinates; send it
  status, merges, blockers and owner questions with a recommended option.
- **Branches**: `develop` is the default branch and there is no `main`. v1 is built on
  `feat/v1`: each slice is `feat/v1-<slice>` off it, PR'd with `--base feat/v1`.
- **Single tenant**: no workspaces and no `scoped()` tenancy; every owner collection is
  read with its `ownerId`, and a spec per module proves another member gets `not-found`.
- **Privacy**: the admin never reads members' conversations, messages, attachments,
  memory or projects; no resolver or script exposes them (a leak spec guards it).
- **AI through `@softistx/ai-*` only**: no provider SDK, no hand-made SSE writer, no
  app-side embeddings or search client (`$vectorSearch` of our own MongoDB is not a
  search client). A gap is filed on softistx/ai and the slice waits.
- **Transports**: `/graphql` is the entry point; `/media` (the private bucket's `persona-avatars`, `attachments`, `project-documents` and `conversation-exports`) and
  `GET /runs/:runId/events` (the SSE stream of a run, spec §1 and §4.5) are the transports
  beside it, through `@softistx/alxia-media` and `@softistx/ai-alxia`. Any other route is
  asked about first.
- **Writes by a model are proposed actions** confirmed by the user (MCP, memory).
- **Entry-point defaults**: `createApp` may default `adapters` (the provider seam, `serverModels`), beside `throttle`, `now`, `titleModelId`, `runtime` (the runs' host, one per app), `observers` (`aiTelemetry`, no content), `heartbeatMs` and `maxRunMs` (10 minutes), and the ports of the infrastructure it hands to the services: `media` (the private bucket), `statuses` (the Ollama probe's store), `embedder` (the embeddings, `EMBED_BASE_URL`), `vectors` (the `VectorIndex`) and `indexQueue` (the indexing queue) (Assumed, not answered: the recommended option, taken in the night window, with `media` and `statuses` as precedent); no module defaults a port.
- **CI**: no workflow yet; the local green bar is the proof until one is added.
