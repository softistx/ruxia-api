import { describe, expect, test } from "bun:test";
import { escapeHtml } from "./escape";

describe("escapeHtml", () => {
  test("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jo'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jo&#39;&lt;/a&gt;",
    );
  });

  test("leaves plain text alone", () => {
    expect(escapeHtml("Bonjour")).toBe("Bonjour");
  });
});
