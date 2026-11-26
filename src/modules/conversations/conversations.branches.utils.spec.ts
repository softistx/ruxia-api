import { describe, expect, test } from "bun:test";
import { deepestLeaf, siblingsOf } from "./conversations.branches.utils";

const node = (id: string, parentId: string | null, second: number) => ({
  _id: id,
  parentId,
  createdAt: new Date(second * 1000),
});
// a -> b -> c ; a -> d (later) ; root2 beside a (later)
const tree = [
  node("a", null, 1),
  node("b", "a", 2),
  node("c", "b", 3),
  node("d", "a", 4),
  node("root2", null, 5),
  node("e", "root2", 5),
];

describe("siblingsOf", () => {
  test("lists the messages of one parent in creation order, roots included", () => {
    expect(siblingsOf(tree, tree[3] as never)).toEqual({
      ids: ["b", "d"],
      index: 1,
    });
    expect(siblingsOf(tree, tree[0] as never)).toEqual({
      ids: ["a", "root2"],
      index: 0,
    });
  });
});

describe("deepestLeaf", () => {
  test("follows the latest child at each step", () => {
    expect(deepestLeaf(tree, "a")).toBe("d");
    expect(deepestLeaf(tree, "b")).toBe("c");
    expect(deepestLeaf(tree, "c")).toBe("c");
    expect(deepestLeaf(tree, "root2")).toBe("e");
  });

  test("breaks a tie on the id", () => {
    const tied = [node("p", null, 1), node("x", "p", 2), node("y", "p", 2)];
    expect(deepestLeaf(tied, "p")).toBe("y");
  });
});
