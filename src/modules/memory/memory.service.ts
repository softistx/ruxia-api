import type { AgentObserver, AnyTool } from "@softistx/ai-core";
import { isObjectIdString } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { Viewer } from "../../auth/viewer";
import type { AppMongo } from "../../config/db";
import { invalidInput } from "../../shared/errors";
import type { PersonaDocument } from "../personas/models";
import { itemNotFound, memoryFull } from "./memory.errors";
import type { MemoryMembers, MemoryPersonas } from "./memory.integrity";
import type { MemoryItemDocument, MemorySource } from "./memory.model";
import {
  factsOf,
  MAX_ITEMS,
  MEMORY_TOOLS,
  taintedBy,
  textIssues,
} from "./memory.rules";
import { memoryTools } from "./memory.tools";

// What a run takes of the memory: the facts for the system prompt and the
// tools, both empty when the persona does not keep a memory.
// `observer` watches the run's tool calls: once a tool that is not the
// memory's has been called, `remember` is proposed even when the member
// remembers without asking.
export interface MemoryKit {
  facts: string | null;
  tools: AnyTool[];
  observer: AgentObserver;
}

// The viewer's long-term memory, for one request. Every read and write is
// bound to the viewer (`ownerId`): another member's item, the admin's
// included, is `not-found`.
export class MemoryService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly personas: MemoryPersonas,
    private readonly members: MemoryMembers,
    private readonly viewer: Viewer | null,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("memory: an operation needs a viewer");
    return this.viewer.id;
  }

  private get items() {
    return this.mongo.as(this.actor).db.memoryItems;
  }

  // The viewer's items for a persona they may read (a deleted one's too),
  // newest first.
  async list(personaId: string): Promise<MemoryItemDocument[]> {
    const persona = await this.personas.findIncludingDeleted(personaId);
    return this.itemsOf(persona._id);
  }

  private itemsOf(personaId: ObjectId) {
    return this.items.findMany({
      filter: { ownerId: this.actor, personaId },
      sort: { createdAt: -1, _id: -1 },
      limit: MAX_ITEMS,
    });
  }

  // One of the viewer's items.
  async find(id: string): Promise<MemoryItemDocument> {
    const item = isObjectIdString(id)
      ? await this.items.findFirst({ _id: id, ownerId: this.actor })
      : undefined;
    if (item === undefined) throw itemNotFound();
    return item;
  }

  // Adds an item to the persona's memory (the persona must be readable and not
  // deleted). Refused past 200 items.
  async add(personaId: string, text: string, source: MemorySource) {
    const issues = textIssues(text);
    if (issues.length > 0) throw invalidInput(issues);
    const persona = await this.personas.find(personaId);
    const held = await this.items.count({
      ownerId: this.actor,
      personaId: persona._id,
    });
    if (held >= MAX_ITEMS) throw memoryFull();
    const created = await this.items.create({
      ownerId: this.actor,
      personaId: persona._id,
      text: text.trim(),
      source,
    });
    return this.keepWithinCap(created);
  }

  // The cap is checked after the insert, by rank: the item stays when at most
  // 200 of the member's items for the persona have an id up to its own, and is
  // deleted again when not. Adds that race pass through the same total order,
  // so exactly 200 stay.
  private async keepWithinCap(created: MemoryItemDocument) {
    const rank = await this.items.count({
      ownerId: this.actor,
      personaId: created.personaId,
      _id: { $lte: created._id },
    });
    if (rank <= MAX_ITEMS) return created;
    await this.items.delete(created._id);
    throw memoryFull();
  }

  async update(id: string, text: string) {
    const issues = textIssues(text);
    if (issues.length > 0) throw invalidInput(issues);
    const item = await this.find(id);
    return this.items.update(item._id, { text: text.trim() });
  }

  // Deletes one item and answers its id.
  async delete(id: string): Promise<string> {
    const item = await this.find(id);
    await this.items.delete(item._id);
    return String(item._id);
  }

  // Deletes every item of the persona and answers how many.
  async clear(personaId: string): Promise<number> {
    const persona = await this.personas.findIncludingDeleted(personaId);
    const removed = await this.items.raw.deleteMany({
      ownerId: this.actor,
      personaId: persona._id,
    });
    return removed.deletedCount;
  }

  // What a run gives the persona: its facts and the `remember` and `forget`
  // tools, only when the persona enables memory. `remember` runs without a
  // proposal when the member chose to remember without asking, unless the
  // conversation so far (`history`, the parts of the path) or the run holds
  // output of a tool that is not the memory's.
  async kit(
    persona: Pick<PersonaDocument, "_id" | "tools">,
    history: readonly { type: string; name?: string }[] = [],
  ): Promise<MemoryKit> {
    if (!persona.tools.memory) return { facts: null, tools: [], observer: {} };
    const items = await this.itemsOf(persona._id);
    const { settings } = await this.members.mine();
    const run = { tainted: taintedBy(history) };
    const taint = (call: { name: string }) => {
      if (!(MEMORY_TOOLS as readonly string[]).includes(call.name)) {
        run.tainted = true;
      }
    };
    const tools = memoryTools({
      actions: {
        remember: (text) => this.add(String(persona._id), text, "model"),
        forget: (id) => this.forget(persona._id, id),
      },
      texts: new Map(items.map((item) => [String(item._id), item.text])),
      auto: settings.rememberWithoutAsking,
      tainted: () => run.tainted,
    });
    const shown = items.map((item) => ({
      id: String(item._id),
      text: item.text,
    }));
    return {
      facts: factsOf(shown),
      tools,
      observer: {
        onToolStart: ({ call }) => taint(call),
        onToolCall: ({ call }) => taint(call),
      },
    };
  }

  // Deletes an item of this persona only (the model names an id it read).
  private async forget(personaId: ObjectId, id: string) {
    const item = await this.find(id);
    if (String(item.personaId) !== String(personaId)) throw itemNotFound();
    await this.items.delete(item._id);
  }
}
