// What the tree needs of a message: its place and its age.
export interface Node {
  _id: { toString(): string };
  parentId: { toString(): string } | null;
  createdAt: Date;
}

// Creation order, the id breaking a tie.
export function byCreation(a: Node, b: Node) {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  if (delta !== 0) return delta;
  return String(a._id) < String(b._id) ? -1 : 1;
}

// The ids of the messages that share `message`'s parent, in creation order,
// and where `message` stands among them.
export function siblingsOf(nodes: readonly Node[], message: Node) {
  const parent = message.parentId === null ? null : String(message.parentId);
  const ids = nodes
    .filter(
      (node) =>
        (node.parentId === null ? null : String(node.parentId)) === parent,
    )
    .sort(byCreation)
    .map((node) => String(node._id));
  return { ids, index: Math.max(0, ids.indexOf(String(message._id))) };
}

// The deepest leaf at or below `startId`: at each step the latest child.
export function deepestLeaf<T extends Node>(
  nodes: readonly T[],
  startId: string,
) {
  const children = new Map<string, T[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const key = String(node.parentId);
    children.set(key, [...(children.get(key) ?? []), node]);
  }
  let current = startId;
  for (;;) {
    const latest = children.get(current)?.sort(byCreation).at(-1);
    if (latest === undefined) return current;
    current = String(latest._id);
  }
}
