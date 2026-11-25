// The production build: `dist/server.js` and one `dist/scripts/<name>.js` per
// operator script, all with --target=bun. Run by `bun run build` after
// `generate`. A new script is picked up by convention, never listed here:
//   - src/scripts/<name>.ts   (a name with no dot: db-sync, db-migrate). A
//     dot-less top-level .ts is an entry point, so a helper there needs a
//     dotted name (db-migrate.utils.ts) or a folder
//   - src/scripts/<name>/index.ts   (admin-create, ...)
// `schema-print` is a development tool (it writes schema.graphql into the
// repository), so it is the one name left out. The build fails when an asset
// the image needs is missing.
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";

const root = import.meta.dir;
const devOnly = new Set(["schema-print"]);

const scripts = new Map<string, string>();
for (const file of new Glob("src/scripts/*.ts").scanSync(root)) {
  const name = file.slice("src/scripts/".length, -".ts".length);
  if (!name.includes(".") && !devOnly.has(name)) scripts.set(name, file);
}
for (const file of new Glob("src/scripts/*/index.ts").scanSync(root)) {
  const name = file.split("/")[2] as string;
  if (!devOnly.has(name)) scripts.set(name, file);
}

// Assets the image copies or the code reads at runtime.
const sdl = [...new Glob("src/**/*.graphqls").scanSync(root)];
const required = [
  "src/server.ts",
  "src/migrations/index.ts",
  ...scripts.values(),
];
const missing = required.filter((file) => !existsSync(join(root, file)));
if (sdl.length === 0) missing.push("src/**/*.graphqls");
if (missing.length > 0) {
  console.error(`build failed, missing: ${missing.join(", ")}`);
  process.exit(1);
}

await rm(join(root, "dist/scripts"), { recursive: true, force: true });
const server = await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "bun",
  minify: true,
  sourcemap: "linked",
});
const builds = [server];
for (const [name, file] of scripts) {
  builds.push(
    await Bun.build({
      entrypoints: [file],
      outdir: "dist/scripts",
      naming: `${name}.js`,
      target: "bun",
      // Minified and without maps: six source maps would add about 30 MB to
      // the image. For a readable trace run `bun src/scripts/<name>/index.ts`.
      minify: true,
      sourcemap: "none",
    }),
  );
}
for (const r of builds) {
  if (!r.success) {
    for (const log of r.logs) console.error(String(log));
    process.exit(1);
  }
}

const outputs = await readdir(join(root, "dist/scripts"), {
  withFileTypes: true,
});
const stray = outputs.filter((e) => e.isDirectory()).map((e) => e.name);
const absent = [...scripts.keys()].filter(
  (n) => !existsSync(join(root, `dist/scripts/${n}.js`)),
);
if (stray.length > 0 || absent.length > 0) {
  console.error(
    `build failed, stray folders: ${stray.join(", ")}; missing outputs: ${absent.join(", ")}`,
  );
  process.exit(1);
}
console.log(
  `built dist/server.js and ${scripts.size} scripts: ${[...scripts.keys()].sort().join(", ")}`,
);
