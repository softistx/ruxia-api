import { parseAcceptLanguage, pickLocale } from "@softistx/mail";

const mailLocales = ["fr", "en"] as const;
export type MailLocale = (typeof mailLocales)[number];

// The language a mail is written in: the request's Accept-Language among
// French and English, else French.
export function mailLocaleOf(request: Request): MailLocale {
  return pickLocale(
    parseAcceptLanguage(request.headers.get("accept-language")),
    mailLocales,
    "fr",
  );
}
