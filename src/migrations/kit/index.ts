// The append-only kit migrations write the translations with: only `upsert*`
// and `retire*`, never a delete (a retired entry stays readable). Frozen: a
// function here never changes meaning, a new one is added instead, as the list
// of migrations grows only at its end.
export { inSession, type KitContext } from "./context";
export {
  retireTranslations,
  translationSeeds,
  upsertTranslations,
} from "./translations";
