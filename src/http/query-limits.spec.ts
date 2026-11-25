import { describe, expect, test } from "bun:test";
import { queryPost } from "~/app";
import { cyclicApi } from "~/cyclic-api";
import { BODY_LIMIT } from "../app";
import {
  MAX_QUERY_COST,
  MAX_QUERY_DEPTH,
  MAX_QUERY_FIELDS,
} from "./query-limits";

// The request limits (src/http/query-limits.ts) over a schema that cycles
// (test/cyclic-api.ts): the real one has no cycle until the catalogue lands.
// Documents sized to a domain screen come back with their modules, each
// against its own heaviest legitimate query.
async function run(query: string, variables?: Record<string, unknown>) {
  const response = await queryPost(cyclicApi, query, variables);
  return { status: response.status, body: await response.json() };
}

// `node { children { parent { children … { id } } } }`, `laps` times, each
// `children` with the given `first` argument (as written, e.g. "(first: 1)";
// the schema's default 50 when none), ending on `tail`.
const cycle = (laps: number, first = "", tail = "id") => {
  let inner = tail;
  for (let i = 0; i < laps; i += 1)
    inner = `children${first} { parent { ${inner} } }`;
  return `{ node { ${inner} } }`;
};

const codes = (body: { errors?: { extensions: { code: string } }[] }) =>
  (body.errors ?? []).map((e) => e.extensions.code);

describe("the query depth", () => {
  test("an operation is accepted at the maximum and refused one level past it", async () => {
    // 4 laps: 1 + 4 * 2 + 1 = 10 levels, the maximum.
    const atMax = await run(cycle(4, "(first: 1)"));
    expect(atMax.body.errors).toBeUndefined();

    // 6 laps: 14 levels. `depth` is the real one, `max` the limit.
    const tooDeep = await run(cycle(6, "(first: 1)"));
    expect(tooDeep.body.data).toBeUndefined();
    expect(tooDeep.body.errors).toHaveLength(1);
    expect(tooDeep.body.errors[0].extensions).toMatchObject({
      code: "validation.errors.query-too-deep",
      params: { depth: 14, max: MAX_QUERY_DEPTH },
    });
    expect(tooDeep.body.errors[0].message).toContain(String(MAX_QUERY_DEPTH));

    // One level past the maximum is already refused.
    const oneMore = await run(cycle(4, "(first: 1)", "parent { id }"));
    expect(oneMore.body.errors[0].extensions).toMatchObject({
      code: "validation.errors.query-too-deep",
      params: { depth: MAX_QUERY_DEPTH + 1, max: MAX_QUERY_DEPTH },
    });

    // Hidden behind a fragment, it is still refused.
    const fragment = `query { ...F } fragment F on Query ${cycle(6, "(first: 1)")}`;
    expect(codes((await run(fragment)).body)).toContain(
      "validation.errors.query-too-deep",
    );
  });

  test("introspection is not limited by depth or cost", async () => {
    const answer = await run(
      "{ __schema { types { fields { type { ofType { ofType { ofType { name } } } } } } } }",
    );
    expect(answer.body.errors).toBeUndefined();
  });
});

describe("the query cost", () => {
  test("a document of 600 aliases of a deep cycle is refused (too wide), a realistic screen is accepted", async () => {
    // 600 aliases of a depth-7 cycle, under the body limit and under the
    // parser's 15 000 tokens (@softistx/alxia-graphql 0.9: past it, GRAPHQL_PARSE_FAILED).
    const aliases = Array.from(
      { length: 600 },
      (_, i) => `a${i}: node { ...F }`,
    ).join(" ");
    const wide = `query { ${aliases} } fragment F on Node { children(first: 1) { parent { children(first: 1) { parent { children(first: 1) { id } } } } } }`;
    expect(wide.length).toBeLessThan(BODY_LIMIT);
    const refused = await run(wide);
    expect(refused.body.errors[0].extensions).toMatchObject({
      code: "validation.errors.query-too-wide",
      params: { maxFields: MAX_QUERY_FIELDS },
    });
    expect(refused.body.errors[0].extensions.params.fields).toBeGreaterThan(
      MAX_QUERY_FIELDS,
    );

    // Few fields, but the cycle at the schema's defaults: 50 per lap.
    const heavy = await run(cycle(4));
    expect(heavy.body.errors[0].extensions).toMatchObject({
      code: "validation.errors.query-too-costly",
      params: { maxCost: MAX_QUERY_COST },
    });
    expect(heavy.body.errors[0].extensions.params.cost).toBeGreaterThan(
      MAX_QUERY_COST,
    );

    // A screen: a node with its parent and a page of children.
    const screen = "{ node { id parent { id children(first: 10) { id } } } }";
    expect((await run(screen)).body.errors).toBeUndefined();
    // The two laps of the cycle at its defaults still pass.
    expect((await run(cycle(2))).body.errors).toBeUndefined();
  });

  test("a sibling with a negative first does not hide a heavy query", async () => {
    const heavy = cycle(4).slice(1, -1);
    const bypass = `{ ${heavy} other: node { children(first: -2147483648) { id } } }`;
    expect(codes((await run(bypass)).body)).toContain(
      "validation.errors.query-too-costly",
    );
  });

  test("a variable first counts at its maximum (100), like the literal", async () => {
    const withFirst = (first: string, declared = "") =>
      `query${declared} { node { children(first: ${first}) { parent { children(first: ${first}) { parent { children(first: ${first}) { id } } } } } } }`;
    const variable = await run(withFirst("$n", "($n: Int)"), { n: 1 });
    const literal = await run(withFirst("100"));
    expect(codes(variable.body)).toEqual(codes(literal.body));
    expect(codes(variable.body)).toContain(
      "validation.errors.query-too-costly",
    );
  });

  test("a huge literal first on a list is refused by its cost", async () => {
    const answer = await run("{ node { children(first: 2147483647) { id } } }");
    expect(codes(answer.body)).toContain("validation.errors.query-too-costly");
  });
});

describe("the query breadth", () => {
  test("3000 aliases of __typename are refused: they cost nothing, but count as fields", async () => {
    const aliases = Array.from({ length: 3000 }, (_, i) => `a${i}: __typename`);
    const answer = await run(`{ ${aliases.join(" ")} }`);
    expect(answer.body.errors[0].extensions).toMatchObject({
      code: "validation.errors.query-too-wide",
      params: { fields: 3000, maxFields: MAX_QUERY_FIELDS },
    });
  });

  test("600 aliases of a cheap query are refused", async () => {
    const aliases = Array.from({ length: 600 }, (_, i) => `a${i}: node { id }`);
    expect(codes((await run(`{ ${aliases.join(" ")} }`)).body)).toEqual([
      "validation.errors.query-too-wide",
    ]);
  });

  test("a fragment counts at each use", async () => {
    const uses = Array.from({ length: 300 }, (_, i) => `a${i}: node { ...F }`);
    const answer = await run(`{ ${uses.join(" ")} } fragment F on Node { id }`);
    expect(codes(answer.body)).toEqual(["validation.errors.query-too-wide"]);
  });
});
