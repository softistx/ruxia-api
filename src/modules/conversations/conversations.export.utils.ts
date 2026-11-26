import { joinedText } from "./conversations.utils";
import type { ConversationDocument, MessageDocument } from "./models";

const labels = {
  fr: { you: "Vous", untitled: "Sans titre" },
  en: { you: "You", untitled: "Untitled" },
} as const;

export const markdownType = "text/markdown";
export const jsonType = "application/json";

// The branch shown as Markdown: a title, then each message under the name of
// who wrote it. Reasoning, tool calls and ids are left out.
export function markdownOf(
  conversation: Pick<ConversationDocument, "title" | "personaSnapshot">,
  path: readonly MessageDocument[],
  locale: string,
) {
  const words = locale.startsWith("fr") ? labels.fr : labels.en;
  const name = conversation.personaSnapshot.name;
  const blocks = path.map(
    (message) =>
      `## ${message.role === "user" ? words.you : name}\n\n${joinedText(message.parts)}`,
  );
  return `# ${conversation.title ?? words.untitled}\n\n${blocks.join("\n\n")}\n`;
}

// The whole tree as JSON: every message with its `parentId`, so each branch
// can be rebuilt, and the leaf that was shown.
export function jsonOf(
  conversation: ConversationDocument,
  tree: readonly MessageDocument[],
) {
  return JSON.stringify(
    {
      conversation: {
        id: String(conversation._id),
        title: conversation.title,
        persona: conversation.personaSnapshot.name,
        modelId: conversation.modelId,
        activeLeafId:
          conversation.activeLeafId === null
            ? null
            : String(conversation.activeLeafId),
        createdAt: conversation.createdAt,
      },
      messages: tree.map((message) => ({
        id: String(message._id),
        parentId: message.parentId === null ? null : String(message.parentId),
        role: message.role,
        text: joinedText(message.parts),
        modelId: message.modelId,
        status: message.status,
        pinned: message.pinned,
        reactions: message.reactions.map((reaction) => reaction.emoji),
        createdAt: message.createdAt,
      })),
    },
    null,
    2,
  );
}
