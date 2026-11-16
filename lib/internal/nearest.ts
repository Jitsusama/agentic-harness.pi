/**
 * The nearest known word to one typed wrongly, by edit distance, which a
 * command says back when a word or flag isn't one it knows.
 */

/**
 * The known word nearest to `typed`, or none when every one is more than
 * half its length off (two at least); of two as near, the first.
 */
export function nearestWord(
	typed: string,
	known: readonly string[],
): string | undefined {
	const cap = Math.max(2, Math.floor(typed.length / 2));
	let best: { word: string; distance: number } | undefined;
	for (const word of known) {
		const distance = editDistance(typed, word);
		if (distance > cap) continue;
		if (!best || distance < best.distance) best = { word, distance };
	}
	return best?.word;
}

/** How many letters to add, drop or change to make `a` into `b`. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	// One row of the table at a time, walking the row above in step:
	// `diagonal` is the cell above and to the left, `left` the one just
	// filled, and the last cell filled is the distance.
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	let left = b.length;
	for (let i = 1; i <= a.length; i++) {
		const curr = [i];
		let diagonal = i - 1;
		left = i;
		for (const [j, above] of prev.slice(1).entries()) {
			const cost = a[i - 1] === b[j] ? 0 : 1;
			left = Math.min(left + 1, above + 1, diagonal + cost);
			curr.push(left);
			diagonal = above;
		}
		prev = curr;
	}
	return left;
}
