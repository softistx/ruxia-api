import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";

// Guards first: an attachment is a member's, and the service reads only that
// member's files.
export const attachments: Resolvers = {
  Query: {
    attachment: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.attachments.find(id);
    },
  },
  Mutation: {
    deleteAttachment: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.attachments.remove(id);
    },
  },
  Attachment: {
    id: (file) => String(file._id),
    kind: (file) => file.kind.toUpperCase() as "IMAGE" | "PDF" | "TEXT",
    conversationId: (file) =>
      file.conversationId === null ? null : String(file.conversationId),
    messageId: (file) =>
      file.messageId === null ? null : String(file.messageId),
  },
};
