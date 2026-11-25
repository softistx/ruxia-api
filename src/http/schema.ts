import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeTypeDefs } from "@graphql-tools/merge";
import { scalarResolvers, scalarTypeDefs } from "@softistx/graphql-scalars";
import {
  constraintTypeDefs,
  withValidation,
} from "@softistx/graphql-validation";
import { createSchema } from "@softistx/graxia";
import { resolvers } from "../modules";
import type { Context } from "./context";

// Every src/**/*.graphqls, one per module or entity, merged into one schema:
// each file may declare its own `type Query`. Read at startup from src/,
// beside dist/: `../..` of src/http/ under `bun dev` and `bun test`, `..` of dist/
// for the bundle (`bundled`), where the image copies the SDL files.
// A bundled script (/app/dist/scripts) is not `bundled`: its `../../src` is /app/src too.
const bundled = basename(import.meta.dir) === "dist";
const typeDefs = mergeTypeDefs([
  scalarTypeDefs,
  constraintTypeDefs,
  ...loadFilesSync(
    join(import.meta.dir, bundled ? ".." : join("..", ".."), "src"),
    {
      extensions: ["graphqls"],
    },
  ),
]);

export const schema = withValidation(
  createSchema<Context>()({
    typeDefs,
    incremental: false,
    resolvers: [scalarResolvers, resolvers],
  }),
);
