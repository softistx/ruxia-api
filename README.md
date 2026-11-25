# ruxia-api

The GraphQL API of ruxia, a messaging app whose contacts are AI personas. Bun, alxia,
GraphQL Yoga, `@softistx/mongo`, `@softistx/redis`, `@softistx/s3` and `@softistx/janus`.
Rules for contributors are in [AGENTS.md](AGENTS.md), the domain words in
[CONTEXT.md](CONTEXT.md), the specification in [docs/spec.md](docs/spec.md).

## Run it

```sh
cp .env.example .env        # placeholders only
bun install
bun run services:up         # mongo (replica set), redis, minio
bun run dev:api             # http://localhost:3000/graphql, /health, /ready
bun run admin:create you@example.com   # the first administrator, by invitation
```

There is no sign-up: members come in through an invitation an administrator sends
(`inviteMember`), accepted with `acceptInvitation`.

## Checks

`bun run verify` runs generation, the schema check, Biome, `bun check` and the tests.
`schema.graphql` is committed (`bun run schema:print`).

## Deploy

`deploy/docker-compose.yaml` and `deploy/deploy.sh`: copy `deploy/.env.example` to
`deploy/.env`, fill it, run `deploy/deploy.sh`. Every service has resource limits; the
script removes the images and build cache it replaced, and never touches a volume.
