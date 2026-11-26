import type { Resolvers } from "@/generated/graphql/resolvers";
import {
  joinedText,
  shownParts,
  shownRole,
  shownStatus,
} from "../conversations.utils";

// Type fields only: a message is reached through its conversation, whose
// query checked the viewer owns it. The thinking signatures never leave.
export const messages: Resolvers = {
  Message: {
    id: (message) => String(message._id),
    conversationId: (message) => String(message.conversationId),
    parentId: (message) =>
      message.parentId === null ? null : String(message.parentId),
    role: (message) => shownRole(message.role),
    text: (message) => joinedText(message.parts),
    parts: (message) => shownParts(message.parts),
    status: (message) => shownStatus(message.status),
    siblings: (message, _, ctx) => ctx.services.messages.siblings(message),
    reactions: (message) => message.reactions.map((reaction) => reaction.emoji),
    runId: (message) =>
      message.status === "streaming" ? String(message._id) : null,
  },
};
