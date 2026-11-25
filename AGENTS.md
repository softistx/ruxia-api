# ruxia-api: rules for agents and contributors

The GraphQL API of ruxia, a messaging app whose contacts are AI personas: Bun, alxia,
GraphQL Yoga, `@softistx/mongo`, `@softistx/redis`, `@softistx/s3`, `@softistx/janus` and
the house AI SDK `@softistx/ai-*`. The specification is [docs/spec.md](docs/spec.md), the
roadmap [docs/roadmap.md](docs/roadmap.md).

The owner's rules for every repository are in `~/.claude/CLAUDE.md`; this file states
only what is ruxia-api's own. The stack's conventions are the `alxia-graphql-api` plugin's
(`build-an-alxia-graphql-api`, `add-a-module`, its `conventions-reviewer`).

- **Coordination**: the ruxia session in `~/workspace/dev/ruxia/` coordinates; send it
  status, merges, blockers and owner questions with a recommended option.
- **Branches**: `develop` is the default branch and there is no `main`. v1 is built on
  `feat/v1`: each slice is `feat/v1-<slice>` off it, PR'd with `--base feat/v1`.
- **Single tenant**: no workspaces and no `scoped()` tenancy; every owner collection is
  read with its `ownerId`, and a spec per module proves another member gets `not-found`.
- **Privacy**: the admin never reads members' conversations, messages, attachments,
  memory or projects; no resolver or script exposes them (a leak spec guards it).
- **AI through `@softistx/ai-*` only**: no provider SDK, no hand-made SSE writer, no
  app-side embeddings or search client. A gap is filed on softistx/ai and the slice waits.
- **Writes by a model are proposed actions** confirmed by the user (MCP, memory).
- **CI**: no workflow yet; the local green bar is the proof until one is added.
