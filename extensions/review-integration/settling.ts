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

/**
 * The shape of what is kept. A load that changes it bumps this, and its
 * record sits under a key of its own, so two loads of different shapes
 * never replace each other's marks in the very reload that brings the
 * change; a newer load should also read the older keys it knows.
 */
const VERSION = 1;

/** Where this version's marks are kept, the same for every load in the process. */
const MARKS = Symbol.for(
	`agentic-harness.review-integration.settling.v${VERSION}`,
);

/** A round marked: what marked it, so that one can clear its own, and when. */
interface Mark {
	readonly by: object;
	readonly since: number;
}

/** The process's record of the rounds it is settling. */
interface Marks {
	readonly version: typeof VERSION;
	readonly held: Map<string, Mark>;
}

/** Whether a value is this version's record. */
function isMarks(value: unknown): value is Marks {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "version") === VERSION &&
		Reflect.get(value, "held") instanceof Map
	);
}

/** The process's marks, made on first use. */
function marks(): Map<string, Mark> {
	const kept: unknown = Reflect.get(globalThis, MARKS);
	if (isMarks(kept)) return kept.held;
	const made: Marks = { version: VERSION, held: new Map() };
	Reflect.set(globalThis, MARKS, made);
	return made.held;
}

/** Mark `runId` as being settled here, by `by`, from `now`. */
export function settlingHere(
	runId: string,
	by: object,
	now: number = Date.now(),
): void {
	marks().set(runId, { by, since: now });
}

/** Clear every round `by` marked, once its call has answered or thrown. */
export function settledHere(by: object): void {
	const held = marks();
	for (const [runId, mark] of held) {
		if (mark.by === by) held.delete(runId);
	}
}

/** Since when this process has been settling `runId`, or nothing when it isn't. */
export function settlingSince(runId: string): number | undefined {
	return marks().get(runId)?.since;
}

/** Whether this process is still settling `runId`. */
export function isSettlingHere(runId: string): boolean {
	return marks().has(runId);
}
