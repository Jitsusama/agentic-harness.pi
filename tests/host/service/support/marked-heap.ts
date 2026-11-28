/**
 * A process whose heap holds a known marker and a known class, for the
 * heap-summary tests: a string of MARKER_CHARS and THINGS instances of
 * MarkedThing. Run as a program,
 *
 *   node tests/host/service/support/marked-heap.ts BEFORE AFTER
 *
 * it writes a heap snapshot to BEFORE while holding neither, then one to
 * AFTER while holding both, so the two differ by what it holds and no
 * more: node's own sources are strings past 64 KiB too, in either.
 */
import { createHash } from "node:crypto";
import { writeHeapSnapshot } from "node:v8";

/** How long the marker is: 100 KiB of one-byte characters. */
export const MARKER_CHARS = 100 * 1024;
/** How many MarkedThing instances the process holds. */
export const THINGS = 1000;
/** The marker's opening, a hash's own name. */
const SEED = "heap-summary marker";

/**
 * The marker: hex of a chain of hashes, each of the one before, so no
 * slice of it repeats and it can be made again where it is checked.
 */
export function markerText(): string {
	const parts: string[] = [];
	let last = SEED;
	let length = 0;
	while (length < MARKER_CHARS) {
		last = createHash("sha256").update(last).digest("hex");
		parts.push(last);
		length += last.length;
	}
	// Joined flat, as one string of its own size rather than a rope.
	return parts.join("").slice(0, MARKER_CHARS);
}

/** A class with enough fields that its thousand instances rank among a summary's largest rows. */
export class MarkedThing {
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
	readonly e: number;
	readonly f: number;
	readonly g: number;
	readonly h: number;

	constructor(index: number) {
		this.a = index;
		this.b = index;
		this.c = index;
		this.d = index;
		this.e = index;
		this.f = index;
		this.g = index;
		this.h = index;
	}
}

if (import.meta.main) {
	const [before, after] = process.argv.slice(2);
	if (before === undefined || after === undefined)
		throw new Error("Usage: marked-heap.ts BEFORE AFTER");
	writeHeapSnapshot(before);
	const held = {
		marker: markerText(),
		things: Array.from(
			{ length: THINGS },
			(_, index) => new MarkedThing(index),
		),
	};
	writeHeapSnapshot(after);
	// Read after the write, so nothing collects them before it.
	process.stdout.write(`${held.marker.length} ${held.things.length}\n`);
}
