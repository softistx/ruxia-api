import type { ObjectId } from "mongodb";
import type { AttachmentPart } from "../attachments";
import type {
  ConversationDocument,
  MessageDocument,
  MessageTurn,
  MessageUsage,
  StoredPart,
} from "./models";

// What a run's end writes on its assistant message.
export interface Finish {
  status: "done" | "stopped" | "failed";
  parts: StoredPart[];
  // How the parts group in the SDK's messages (a DONE answer only).
  turns?: MessageTurn[];
  usage: MessageUsage | null;
  cost: number | null;
  finishReason: string | null;
  errorCode: string | null;
}

// What a send writes: the member's text under `parentId` (or, for a
// regenerate, the member's message that already exists), and the reply whose id
// is the run's.
export type Exchange = {
  conversation: ConversationDocument;
  modelId: string;
  // The run's id, made by the send before it claims the run; made here when
  // left out.
  assistantId?: ObjectId;
} & (
  | {
      parentId: ObjectId | null;
      text: string;
      // The member's files, checked by `AttachmentsService.require`.
      attachments?: readonly AttachmentPart[];
    }
  | { user: MessageDocument }
);

// The documents an exchange writes, as the values `create` takes (pure: the
// service writes them in its transaction, and links the files).

// The member's message: its text, then the files it carries.
export const userMessageDoc = (input: {
  id: ObjectId;
  actor: string;
  conversationId: ObjectId;
  parentId: ObjectId | null;
  text: string;
  files: readonly AttachmentPart[];
  at: Date;
}) => ({
  _id: input.id,
  ownerId: input.actor,
  conversationId: input.conversationId,
  parentId: input.parentId,
  role: "user" as const,
  parts: [{ type: "text" as const, text: input.text }, ...input.files],
  searchText: input.text,
  status: "done" as const,
  createdAt: input.at,
});

// The reply being written: empty and STREAMING, its id the run's.
export const assistantMessageDoc = (input: {
  actor: string;
  conversationId: ObjectId;
  assistantId: ObjectId;
  parentId: ObjectId;
  modelId: string;
  at: Date;
}) => ({
  _id: input.assistantId,
  ownerId: input.actor,
  conversationId: input.conversationId,
  parentId: input.parentId,
  role: "assistant" as const,
  modelId: input.modelId,
  status: "streaming" as const,
  createdAt: input.at,
});
