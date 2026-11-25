import { generateObject, type Message } from "@softistx/ai-core";
import { z } from "zod";
import type { AppMongo } from "../../../config/db";
import type { ModelAdapters } from "../conversations.adapters";
import type { ConversationModels } from "../conversations.integrity";
import type { ConversationDocument } from "../models";

const titleSchema = z.object({ title: z.string().trim().min(1).max(80) });

const instruction =
  "Write a short title (a few words, no quotes) for this conversation, in the language the member writes in.";

const textMessage = (role: Message["role"], text: string): Message => ({
  role,
  parts: [{ type: "text", text }],
});

// Names a conversation after its first exchange, with a cheap model.
export class TitlesService {
  constructor(
    private readonly mongo: Pick<AppMongo, "db">,
    private readonly models: ConversationModels,
    private readonly adapters: ModelAdapters,
    // The cheap model; the conversation's own when it is not available.
    private readonly titleModelId: string,
    private readonly warn: (message: string) => void,
  ) {}

  // The model to title with: the cheap one, else the conversation's own.
  private async modelFor(conversation: ConversationDocument) {
    try {
      return await this.models.requireAvailable(this.titleModelId);
    } catch {
      return this.models.requireAvailable(conversation.modelId);
    }
  }

  // Writes the title once: only while it is still null, so a title is never
  // overwritten. A failure is logged without any content and leaves it null.
  async name(
    conversation: ConversationDocument,
    exchange: { user: string; reply: string },
  ): Promise<string | null> {
    try {
      const model = await this.modelFor(conversation);
      const { object } = await generateObject(
        this.adapters.adapterFor(model),
        {
          system: [{ text: instruction }],
          messages: [
            textMessage("user", exchange.user),
            textMessage("assistant", exchange.reply),
            textMessage("user", "Title this conversation."),
          ],
          maxTokens: 64,
        },
        titleSchema,
      );
      const done = await this.mongo.db.conversations.raw.updateOne(
        { _id: conversation._id, title: null },
        { $set: { title: object.title, updatedAt: new Date() } },
      );
      return done.matchedCount === 0 ? null : object.title;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.warn(
        `conversation title failed: ${typeof code === "string" ? code : (error as Error).name}`,
      );
      return null;
    }
  }
}
