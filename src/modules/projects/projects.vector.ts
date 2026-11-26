// The port to where the chunks' vectors are searched. Two implementations: the
// production one, MongoDB's `$vectorSearch` (`projects.vector.mongo.ts`), and
// an in-memory cosine one for the specs (mongodb-memory-server does not run
// `$vectorSearch`). Both hold the same rule: a search is bound to one owner AND
// one project, and nothing of another comes back.

// A piece of a document with its vector. Its identity is (documentId, ordinal),
// so writing it again replaces it: an indexing that is retried leaves no copy.
export interface VectorChunk {
  ownerId: string;
  projectId: string;
  documentId: string;
  ordinal: number;
  text: string;
  vector: number[];
}

// What a search found: the chunk's text and where it comes from, and its score,
// from 0 (opposite) to 1 (the same direction): cosine similarity mapped to
// `(1 + cosine) / 2`, which is what `$vectorSearch` gives for a cosine index.
export interface VectorHit {
  documentId: string;
  ordinal: number;
  text: string;
  score: number;
}

// What a removal names: always an owner, then a project or a document of it.
export interface VectorScope {
  ownerId: string;
  projectId?: string;
  documentId?: string;
}

export interface VectorQuery {
  ownerId: string;
  projectId: string;
  vector: number[];
  limit: number;
}

export interface VectorIndex {
  upsert(chunks: readonly VectorChunk[]): Promise<void>;
  // Removes the chunks of `scope`; answers how many.
  remove(scope: VectorScope): Promise<number>;
  // The `limit` best chunks of the owner's project, best first.
  search(query: VectorQuery): Promise<VectorHit[]>;
}

// The cosine similarity of two vectors, mapped to 0..1; 0 for a zero vector or
// vectors of other lengths.
export function similarity(a: readonly number[], b: readonly number[]) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return (1 + dot / Math.sqrt(normA * normB)) / 2;
}

const keyOf = (chunk: Pick<VectorChunk, "documentId" | "ordinal">) =>
  `${chunk.documentId}:${chunk.ordinal}`;

// The in-memory index, for the specs: a map by (document, ordinal), searched
// by brute force. It applies the owner and project filter exactly as the
// production one does.
export function memoryVectorIndex(): VectorIndex & {
  all(): readonly VectorChunk[];
} {
  const held = new Map<string, VectorChunk>();
  return {
    all: () => [...held.values()],
    async upsert(chunks) {
      for (const chunk of chunks) held.set(keyOf(chunk), chunk);
    },
    async remove(scope) {
      let removed = 0;
      for (const [key, chunk] of held) {
        const named =
          chunk.ownerId === scope.ownerId &&
          (scope.projectId === undefined ||
            chunk.projectId === scope.projectId) &&
          (scope.documentId === undefined ||
            chunk.documentId === scope.documentId);
        if (named && held.delete(key)) removed += 1;
      }
      return removed;
    },
    async search(query) {
      return [...held.values()]
        .filter(
          (chunk) =>
            chunk.ownerId === query.ownerId &&
            chunk.projectId === query.projectId,
        )
        .map((chunk) => ({
          documentId: chunk.documentId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          score: similarity(chunk.vector, query.vector),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit);
    },
  };
}
