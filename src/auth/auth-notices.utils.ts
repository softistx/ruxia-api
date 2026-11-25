// When a recovery code was used, as the notice words it: the date and time in
// the account's language, in UTC.
export const whenOf = (at: Date, locale: "en" | "fr") =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at);
