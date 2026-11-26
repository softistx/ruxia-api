import { estimateTokens, type Message, type Part } from "@softistx/ai-core";
import { compact, type StoredMessage } from "@softistx/ai-memory";
import { type Expandable, isAttachment } from "../../attachments";
import {
  docIdOf,
  fromFirstMember,
  summaryAnchor,
  toStored,
} from "../conversations.history.utils";
import { compactionBudget } from "../conversations.rules";
import { attachmentTokens, contextOf } from "../conversations.utils";
import type { MessageDocument } from "../models";

export interface ContextOptions {
  window: number;
  systemTokens: number;
  summarize: (messages: Message[]) => Promise<string>;
  expand: (lists: readonly Expandable[]) => Promise<Part[][]>;
  // What decided actions tell the model, by the id of the member's message
  // each heads (`ActionsService.outcomes`).
  preface?: ReadonlyMap<string, Part[]>;
}

// What a stored summary is: the text, its size and when it was written.
export interface StoredSummary {
  text: string;
  tokens: number;
  createdAt: Date;
}

// The fold of a conversation's context, for one request. `store` writes a
// summary on the message it covers (the messages service's own collection).
export class ContextService {
  constructor(
    private readonly store: (
      messageId: string,
      summary: StoredSummary,
    ) => Promise<unknown>,
    private readonly now: () => Date,
  ) {}

  // The context of a model call over `path`: the summary stored on the deepest
  // message that has one, and the messages after it, folded again when they
  // pass the budget. The new summary is stored on the message it covers through
  // (`summaryAnchor`: only when the fold ends on a whole message; the summary
  // then holds for every branch below it, and a fold that ends inside an
  // answer serves this call only). The fold sees an attachment as its name;
  // `expand` then gives the model the real parts of the kept messages that
  // carry one. The context starts on a member's message.
  async context(path: readonly MessageDocument[], options: ContextOptions) {
    const preface = options.preface ?? new Map<string, Part[]>();
    const { summary, start } = contextOf(path);
    const result = await this.folded(
      toStored(path.slice(start), preface),
      path,
      summary,
      compactionBudget(options.window, options.systemTokens),
      options.summarize,
    );
    const anchor =
      result.throughMessageId === undefined
        ? undefined
        : summaryAnchor(path, result.throughMessageId);
    if (result.summary !== undefined && anchor !== undefined) {
      await this.store(anchor, {
        text: result.summary,
        tokens: estimateTokens(result.summary),
        createdAt: this.now(),
      });
    }
    return {
      summary: result.summary ?? summary?.text ?? null,
      messages: fromFirstMember(
        await this.withFiles(result.messages, path, options.expand, preface),
      ),
    };
  }

  // Folds to the budget. The attachments of the messages the fold keeps are
  // only then estimated (`attachmentTokens`): when they push the context past
  // the budget it is folded once more, to what is left of it. Folded
  // messages' attachments cost nothing, so a conversation that carried many
  // files long ago is not folded for them.
  private async folded(
    stored: StoredMessage[],
    path: readonly MessageDocument[],
    summary: { text: string } | null,
    budget: number,
    summarize: (messages: Message[]) => Promise<string>,
  ) {
    const run = (limit: number) =>
      compact(stored, {
        budget: limit,
        summarize,
        ...(summary && { summary: { text: summary.text } }),
      });
    const first = await run(budget);
    const ids = new Set(first.messages.map((message) => docIdOf(message.id)));
    const reserved = attachmentTokens(
      path.filter((message) => ids.has(String(message._id))),
    );
    if (reserved === 0 || first.tokens + reserved <= budget) return first;
    return run(Math.max(0, budget - reserved));
  }

  // The messages the model reads: those that carry an attachment get its real
  // parts (one `expand` for the whole request, so its size budget is shared),
  // the others are as the fold left them.
  private async withFiles(
    kept: readonly StoredMessage[],
    path: readonly MessageDocument[],
    expand: (lists: readonly Expandable[]) => Promise<Part[][]>,
    preface: ReadonlyMap<string, Part[]>,
  ): Promise<Message[]> {
    const byId = new Map(path.map((message) => [String(message._id), message]));
    const docs = kept.map((stored) => byId.get(docIdOf(stored.id)));
    const carrying = docs.filter(
      (doc) => doc?.parts.some(isAttachment) === true,
    ) as MessageDocument[];
    const expanded = await expand(carrying.map((doc) => doc.parts));
    return kept.map((stored, index) => {
      const at = carrying.indexOf(docs[index] as MessageDocument);
      const doc = docs[index];
      return doc !== undefined && at !== -1
        ? {
            role: doc.role,
            parts: [
              ...(preface.get(String(doc._id)) ?? []),
              ...(expanded[at] as Part[]),
            ],
          }
        : stored.message;
    });
  }
}
