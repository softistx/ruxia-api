# Deploying ruxia-api

`deploy.sh` builds the image and runs `docker-compose.yaml` (mongo with its search
component `mongot`, redis, minio, `ollama-embed`, the API and its migration
one-shot). Fill `deploy/.env` from `.env.example` first (mode 600).

## Pinned images and where the tags come from

Checked on 2026-11-26 on Docker Hub.

| Image                              | Tag       | Source                                                                                              |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `mongo`                            | `8.3.17`  | https://hub.docker.com/_/mongo/tags (the docs ask for MongoDB 8.3 or later for self-managed Search) |
| `mongodb/mongodb-community-search` | `1.79.1`  | https://hub.docker.com/r/mongodb/mongodb-community-search/tags                                      |
| `ollama/ollama`                    | `0.40.18` | https://hub.docker.com/r/ollama/ollama/tags (the newest tag that is not a release candidate)        |

The search component's setup follows
https://www.mongodb.com/docs/search/self-managed/current/installation/docker/.
That page gives `docker run` commands, not a compose file, and its sample is
"insecure, for local experimentation": the compose here is a translation of it.

## To check before the first deploy

None of these has been run: the compose was only validated with
`docker compose config`.

1. **`setParameter` names.** mongod is started with `mongotHost`,
   `searchIndexManagementHostAndPort`, `useGrpcForSearch` and `searchTLSMode`
   as `--setParameter`. Check each is accepted by `mongo:8.3.17` (`docker logs
   ruxia-mongo`), and whether `skipAuthenticationToSearchIndexManagementServer`
   is needed: our mongod has no access control, and the docs' sample sets it to
   `false`.
2. **mongot config path.** `./mongot/mongot.yml` is mounted at
   `/mongot-community/config.default.yml`, the path the docs use. Check mongot
   starts from it (`docker logs ruxia-mongot`).
3. **`curl` (or `wget`) in the mongot image.** Its healthcheck tries both
   against `localhost:8080/health`. The docs run the check from the host, so
   neither is guaranteed. If both are missing, `mongot` stays unhealthy and
   `api-migrate` never starts: replace the check (a TCP probe) or
   `depends_on` `service_started`.
4. **Secret file mode.** `MONGOT_PASSWORD` is mounted at
   `/run/secrets/mongot_password`; the docs say `chmod 400` and no trailing
   newline. Check mongot reads it (a compose secret from `environment:` is
   mode 0444 and may or may not end with a newline).
5. **`mongotUser`.** `mongot-user` creates it with the `searchCoordinator` role;
   check `docker logs ruxia-mongot-user` and that mongot syncs
   (`replicationReader.readPreference` is `primaryPreferred`: one node).
6. **Index readiness.** `bun run db:sync` creates the `chunks_vector` index
   (`vectorIndex` in its output: created, updated or unchanged). mongot
   answering `SERVING` does not mean the index is queryable: run a search from
   `mongosh` (`$vectorSearch` on `chunks`) before relying on `search_project`.
7. **VPS capacity.** The limits set here (mongo 1 CPU / 1 GB, mongot 1 CPU / 1
   GB, ollama-embed 2 CPU / 2 GB) are my own. A 400,000 character document is
   about 140 chunks; time one indexing against the queue's 10 minute timeout.
8. **Egress.** `ollama-embed` and `ollama-pull` join the non-internal `egress`
   network to pull `nomic-embed-text` once. Check `docker exec ruxia-ollama-embed
   ollama list` shows it, and that nothing else is on `egress`.
9. **The model is pulled after the API starts.** The API does not wait for
   `ollama-pull`; a document indexed before it ends is retried, then FAILED
   `EMBEDDINGS_UNAVAILABLE` (the member reindexes it). Check the first upload.
10. **Pruning and disk.** The volumes `mongot-data` (the index files) and
    `ollama-data` (the model, about 300 MB) are new; `deploy.sh`'s image pruning
    must not remove them or the old images the next deploy needs. Check
    `docker system df` after a deploy.
