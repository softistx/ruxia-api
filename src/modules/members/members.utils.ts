import type { MemberSettingsInput } from "../../generated/graphql/resolvers";
import type { MemberDocument } from "./members.model";

// The update that applies a settings input to a member: only what the input
// names changes (`defaultPersonaId: null` clears it, absent keeps it). The
// language is the document's `locale`, answered back so the caller can mirror
// it on the account.
export function settingsPatch(
  member: Pick<MemberDocument, "settings">,
  input: MemberSettingsInput,
) {
  const { settings } = member;
  return {
    ...(input.language !== undefined &&
      input.language !== null && {
        locale: input.language === "EN" ? ("en" as const) : ("fr" as const),
      }),
    settings: {
      pushPreviews: input.pushPreviews ?? settings.pushPreviews,
      voiceAutoPlay: input.voiceAutoPlay ?? settings.voiceAutoPlay,
      defaultPersonaId:
        input.defaultPersonaId === undefined
          ? settings.defaultPersonaId
          : input.defaultPersonaId,
      rememberWithoutAsking:
        input.rememberWithoutAsking ?? settings.rememberWithoutAsking,
    },
  };
}

// A member's settings as the GraphQL type shows them.
export function settingsView(member: MemberDocument) {
  return {
    language: member.locale === "en" ? ("EN" as const) : ("FR" as const),
    ...member.settings,
  };
}
