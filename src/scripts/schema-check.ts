import { printSchemaWithDirectives } from "@graphql-tools/utils";
import { lexicographicSortSchema } from "graphql";
import { schemaGaps } from "@/graphql/schema-gaps";
import { allowedUndocumented } from "@/graphql/undocumented-allowed";
import { schema } from "@/http/schema";

// Fails (exit 1) when an element of the MERGED schema (the one the server runs
// and schema.graphql prints: our SDL plus what the packages add) has no
// description, and prints each missing coordinate (`Type.field(arg:)`). The
// MCP server hands the schema to agents as the only reference of the API, so
// an undocumented element is a defect. The few that packages declare bare are
// listed in undocumented-allowed.ts; a stale entry fails too. Run by
// `bun run verify` through `schema:check`.
const { missing, stale } = schemaGaps(
  printSchemaWithDirectives(lexicographicSortSchema(schema)),
  allowedUndocumented,
);
if (missing.length > 0) {
  console.error(`${missing.length} schema element(s) without a description:`);
  for (const c of missing) console.error(`  ${c}`);
}
if (stale.length > 0) {
  console.error(
    `${stale.length} allowed entr(ies) now documented: remove them from src/graphql/undocumented-allowed.ts:`,
  );
  for (const c of stale) console.error(`  ${c}`);
}
process.exit(missing.length + stale.length > 0 ? 1 : 0);
