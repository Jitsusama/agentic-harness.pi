/**
 * The rounds this process is still settling, whichever load of the
 * extension runs them.
 *
 * A council whose session reloads goes on in the load the reload
 * replaced: it asks every reviewer, files their findings and writes the
 * ledger last. The reloaded session reads that round open on the
 * ledger as its own, and once the reviewers' leases end, a collect, a
 * stop or a judge's collect would file the same findings the old load
 * is filing (PV3TE0's council on #2007, 22 November). The marks live on
 * the process rather than the module, so the new load sees the old
 * one's, and a round held here is still being run.
 */

/** Where the marks are kept, the same for every load in the process. */
const MARKS = Symbol.for("agentic-harness.review-integration.settling");

/** Each round marked, by what marked it, so that one can clear its own. */
function marks(): Map<string, object> {
	const held: unknown = Reflect.get(globalThis, MARKS);
	if (held instanceof Map) return held;
	const made = new Map<string, object>();
	Reflect.set(globalThis, MARKS, made);
	return made;
}

/** Mark `runId` as being settled here, by `by`. */
export function settlingHere(runId: string, by: object): void {
	marks().set(runId, by);
}

/** Clear every round `by` marked, once its call has answered or thrown. */
export function settledHere(by: object): void {
	const held = marks();
	for (const [runId, marker] of held) {
		if (marker === by) held.delete(runId);
	}
}

/** Whether this process is still settling `runId`. */
export function isSettlingHere(runId: string): boolean {
	return marks().has(runId);
}
