import { describe, expect, test } from "bun:test";
import { settingsPatch, settingsView } from "./members.utils";

const base = {
  settings: {
    pushPreviews: true,
    voiceAutoPlay: false,
    defaultPersonaId: "p1",
    rememberWithoutAsking: false,
  },
};

describe("settingsPatch", () => {
  test("keeps what the input leaves out", () => {
    expect(settingsPatch(base, {})).toEqual({ settings: base.settings });
  });

  test("changes only what it names, the language as the locale", () => {
    const patch = settingsPatch(base, { language: "EN", voiceAutoPlay: true });
    expect(patch.locale).toBe("en");
    expect(patch.settings.voiceAutoPlay).toBe(true);
    expect(patch.settings.pushPreviews).toBe(true);
  });

  test("null clears the default persona", () => {
    expect(
      settingsPatch(base, { defaultPersonaId: null }).settings.defaultPersonaId,
    ).toBeNull();
  });
});

describe("settingsView", () => {
  test("shows the locale as the language beside the settings", () => {
    const view = settingsView({ locale: "en", ...base } as never);
    expect(view).toEqual({ language: "EN", ...base.settings });
  });
});
