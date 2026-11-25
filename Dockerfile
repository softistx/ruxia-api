# syntax=docker/dockerfile:1.10
# Bun bundles the app and its dependencies into dist/server.js, and the
# image holds dist/ (the server and the operator scripts, run with
# `bun dist/scripts/<name>.js`) and the src/**/*.graphqls files, the schema it reads at
# startup: no node_modules, no TypeScript (janus-mail's mails travel inside
# the bundle). Pinned to Bun 1.4.5 exactly (a major alxia
# supports), moved together with ci.yml's setup-bun and @types/bun.

# Every dependency, then bun run build (build.ts): dist/server.js and one
# dist/scripts/<name>.js per operator script (picked up by convention from
# src/scripts, minified, without source maps), and /sdl, the SDL files alone,
# in their src/ tree.
FROM oven/bun:1.4.5 AS build
WORKDIR /app
# The in-memory Mongo and Redis are for the specs only: no binary download
# (redis-memory-server would compile Redis, and the image has no make).
ENV MONGOMS_DISABLE_POSTINSTALL=1 REDISMS_DISABLE_POSTINSTALL=1
COPY package.json bun.lock* bunfig.toml* ./
RUN --mount=type=secret,id=npm_read,env=NPM_SOFTISTX_READ_TOKEN bun install --frozen-lockfile
COPY . .
RUN bun run build
RUN mkdir /sdl && find src -name "*.graphqls" | tar -cf - -T - | tar -xf - -C /sdl

# The bundle and the SDL, which src/http/schema.ts reads at startup, run as
# Bun's own non-root user with the start script's command, written out so
# that Bun is the container's process, and --no-install: with no
# node_modules, Bun would otherwise fetch a package the build left out from
# the registry at startup, where this fails. The server listens on PORT
# (3000). On Alpine, about 200 MB lighter: the bundle is JavaScript, which
# runs the same on musl. A native addon built for glibc alone needs
# oven/bun:1.4.5 here.
FROM oven/bun:1.4.5-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /sdl/src ./src
USER bun
EXPOSE 3000
CMD ["bun", "--no-install", "dist/server.js"]
