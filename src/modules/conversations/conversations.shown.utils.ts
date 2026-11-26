import { isAttachment } from "../attachments";
import { citationsOf } from "../projects/projects.utils";
import type { ActionStatus, MessageDocument, StoredPart } from "./models";

// The parts a client may see: text and thinking, tagged for the union (the
// thinking's signature is never exposed).
export type ShownPart =
  | { __typename: "MessageTextPart"; text: string }
  | { __typename: "MessageThinkingPart"; text: string }
  | ({ __typename: "MessageAttachmentPart" } & ShownAttachment)
  | {
      __typename: "MessageCitationPart";
      documentId: string;
      name: string;
      snippet: string;
      score: number;
    }
  | {
      __typename: "MessageProposedActionPart";
      actionId: string;
      tool: string;
      summary: string | null;
      status: Uppercase<ActionStatus>;
    };

type ShownAttachment = {
  key: string;
  kind: "IMAGE" | "PDF" | "TEXT";
  name: string;
  mime: string;
  bytes: number;
};

// The ids of the proposed actions a message's parts carry.
export const actionIdsOf = (parts: readonly StoredPart[]) =>
  parts.flatMap((part) => (part.type === "proposed-action" ? [part.id] : []));

// `statuses` is where each proposed action stands (an action the store does not
// know reads as expired).
export const shownParts = (
  parts: readonly StoredPart[],
  statuses: ReadonlyMap<string, ActionStatus>,
) =>
  parts.flatMap((part): ShownPart[] => {
    if (part.type === "proposed-action") {
      return [
        {
          __typename: "MessageProposedActionPart" as const,
          actionId: part.id,
          tool: part.tool,
          summary: part.summary ?? null,
          status: (
            statuses.get(part.id) ?? "expired"
          ).toUpperCase() as Uppercase<ActionStatus>,
        },
      ];
    }
    if (part.type === "text") {
      return [{ __typename: "MessageTextPart" as const, text: part.text }];
    }
    if (part.type === "thinking") {
      return part.redacted === undefined
        ? [{ __typename: "MessageThinkingPart" as const, text: part.text }]
        : [];
    }
    if (part.type === "tool-result") {
      return citationsOf(part).map((cited) => ({
        __typename: "MessageCitationPart" as const,
        ...cited,
      }));
    }
    if (isAttachment(part)) {
      return [
        {
          __typename: "MessageAttachmentPart" as const,
          key: part.key,
          kind: part.kind.toUpperCase() as ShownAttachment["kind"],
          name: part.name,
          mime: part.mime,
          bytes: part.bytes,
        },
      ];
    }
    return [];
  });

export const shownRole = (role: MessageDocument["role"]) =>
  role === "user" ? ("USER" as const) : ("ASSISTANT" as const);

export const shownStatus = (status: MessageDocument["status"]) =>
  status.toUpperCase() as "STREAMING" | "DONE" | "FAILED" | "STOPPED";
