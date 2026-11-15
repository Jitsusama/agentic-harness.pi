/**
 * Reading a list's item in a test without reading past its end.
 *
 * With `noUncheckedIndexedAccess` on, `list[0]` may be undefined, so a
 * test that hands it on or reads further into it has to check it first.
 * An `expect(list[0]?.name)` checks a read that ends in a matcher; this
 * is for the rest. It fails the test where the item is missing, saying
 * which index the list lacked, rather than letting a TypeError say so
 * a line or two later.
 */

/** The item at index in list, failing the test when the list has none there. */
export function at<T>(list: readonly T[], index: number): T {
	const item = list[index];
	if (item === undefined)
		throw new Error(
			`expected an item at index ${index}, but the list holds ${list.length}`,
		);
	return item;
}
