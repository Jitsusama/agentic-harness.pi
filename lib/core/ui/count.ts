/**
 * Writing a count the way a person would say it.
 *
 * The alternative writes itself and reads badly: `${n} tree(s)` is correct for every
 * n and natural for none, and the single-item case is the common one, so the tell
 * shows constantly. One surface here had a private helper for this and the other two
 * spelled `(s)` inline in fifty places, which meant a session could show `1 branch`
 * and `1 tree(s)` a line apart.
 */

/**
 * A number and its noun, pluralized.
 *
 * Pass `plural` for a noun that does not simply take an s: `count(2, "entry",
 * "entries")`. Zero takes the plural, as English does: nought trees, not nought tree.
 */
export function count(n: number, singular: string, plural?: string): string {
	return `${n} ${noun(n, singular, plural)}`;
}

/**
 * Just the noun, for a sentence that has already said the number or does not want
 * to. `${found.length} in ${noun(found.length, "tree")}` reads oddly; `Found 3, in 2
 * trees` does not.
 */
export function noun(n: number, singular: string, plural?: string): string {
	return n === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * The verb to agree with a count: `is` for one, `are` otherwise.
 *
 * Here because a sentence built around a count usually needs it, and a caller
 * reaching for a ternary at the call site is how `1 trees are` happens.
 */
export function verb(n: number, singular: string, plural: string): string {
	return n === 1 ? singular : plural;
}
