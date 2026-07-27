/**
 * As much of a rendered view as a budget affords.
 *
 * Whole lines only. Half a line is not a smaller truth, it is a
 * wrong one: a caller who reads "butto" has been handed a node
 * that does not exist, and a request row cut mid-url points at
 * somewhere nobody asked for.
 *
 * Never none, either. An answer that cut everything tells the
 * caller nothing about where they are, so a single line over
 * budget is still returned. The budget is a presentation default,
 * and the payload it cut is stored rather than lost.
 *
 * This knows nothing about what it is cutting. What to do about a
 * cut view differs by family, since narrowing a page read and
 * narrowing a request listing use different words, so the advice
 * belongs to whoever knows those words.
 */

/** A view cut to fit, and what fitting it cost. */
export interface BudgetedView {
	/** The view, whole lines only. */
	readonly text: string;
	/** Lines the render produced. */
	readonly total: number;
	/** Lines this view carries. */
	readonly shown: number;
	/** Lines cut, which is zero when it all fit. */
	readonly cut: number;
}

/** Keep the leading whole lines of a view that fit a byte budget. */
export function withinLineBudget(
	rendered: string,
	budget: number,
): BudgetedView {
	const lines = rendered.length === 0 ? [] : rendered.split("\n");
	const kept: string[] = [];
	let spent = 0;
	for (const line of lines) {
		// The newline this line costs once it is joined back up.
		const cost = Buffer.byteLength(line, "utf-8") + 1;
		if (kept.length > 0 && spent + cost > budget) break;
		kept.push(line);
		spent += cost;
	}
	return {
		text: kept.join("\n"),
		total: lines.length,
		shown: kept.length,
		cut: lines.length - kept.length,
	};
}
