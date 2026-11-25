// THE order of names in a list (subjects, topics, accounts): case ignored,
// Unicode-normalised (NFC) so that a composed "é" and a decomposed "e" + U+0301
// are one letter, compared with `localeCompare`. Two names that compare equal
// are ties, which the caller breaks by id: a keyset cursor must test "equal"
// with `compareNames(...) === 0`, never with `===`, or a name could be
// skipped across a page boundary.
export const nameKey = (name: string) => name.normalize("NFC").toLowerCase();

export const compareNames = (a: string, b: string) =>
  nameKey(a).localeCompare(nameKey(b));

// Names, then ids, as a sort comparator.
export const byNameThenId = <T>(
  name: (item: T) => string,
  id: (item: T) => string,
) => {
  return (a: T, b: T) =>
    compareNames(name(a), name(b)) || id(a).localeCompare(id(b));
};
