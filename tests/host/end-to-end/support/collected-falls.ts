/**
 * What a quiet child's collection says it took off, read back from the
 * child's own line as the engine's collectedLine writes it:
 * `Collected while quiet in 900 ms, Pss 695 MB to 228 MB, heap 132 of
 * 541 MB to 115 of 139 MB (...)`, with `Pss unread` where the child
 * couldn't read its Pss. Read from that line rather than a state line,
 * which may have been sent before the collection (F2 on #2104). The
 * real-engine case that judges it runs only in test:host, so the bars
 * it judges by live here, where a unit test replays recorded lines
 * against them.
 */

/**
 * The least, in MB, a quiet child's collection must take off its heap.
 * Twenty-five collections on 23 and 24 November took 96 to 830 MB off
 * (208 to 112 the least), and two made no-ops took 0, so this is a third
 * under the least seen. A collection cut to a scavenge of the young
 * generation, which the reads around it could set off with no collection
 * at all, took 29 MB off what the heap used (24 November), and passed
 * when any fall did (F11 on #2129); this fails it, with room to spare.
 *
 * The fall is of what the heap used or of its size, whichever is more. A
 * collection V8 ran by itself while the open settled can leave the quiet
 * one little to free: on 27 November it took 17 MB off what the heap used,
 * 132 to 115, yet its size fell from 541 MB to 139. How far a scavenge
 * shrinks the heap's size was never measured, so whether this bar fails
 * one on its size is untested; it is PSS_FALL_MB that tells a real
 * collection apart.
 */
export const HEAP_FALL_MB = 64;

/**
 * The least, in MB, a quiet child's collection must take off its Pss,
 * where it read its Pss. The one recorded on pi's engine, on 27
 * November, fell 467 MB, from 695 to 228, though an earlier collection
 * had left it only 17 MB of used heap to free, so this is a third of
 * that least fall, rounded down. A collection that frees nothing gives
 * nothing back to the system, and a scavenge frees only what the young
 * generation held, so neither takes this much off what the process
 * holds.
 */
export const PSS_FALL_MB = 155;

/** What a quiet collection's line says it took off, in MB. */
export interface CollectedFalls {
	/** The heap it went from and to, as `900 of 950 MB to 112 of 300 MB`, or `unread` where no line says one. */
	readonly words: string;
	/** How far the heap fell, of what it used or of its size, whichever is more; nothing where no line says a heap. */
	readonly heap?: number;
	/** How far the Pss fell; nothing where the line says it went unread, or no line says a heap. */
	readonly pss?: number;
}

/** A collection's line up to its heap, the Pss before and after it where it was read. */
const COLLECTED =
	/Collected while quiet in \d+ ms, Pss (?:(?<pssBefore>\d+) MB to (?<pssAfter>\d+) MB|unread), heap (?<before>(?<usedBefore>\d+) of (?<sizeBefore>\d+) MB) to (?<after>(?<usedAfter>\d+) of (?<sizeAfter>\d+) MB)/;

/**
 * What the first collection `said` names a heap for took off: its heap's
 * fall, the larger of what it used and its size, and its Pss's fall
 * where both sides were read.
 */
export function collectedFalls(said: string): CollectedFalls {
	const read = COLLECTED.exec(said)?.groups;
	if (read === undefined) return { words: "unread" };
	const mb = (name: string) => Number(read[name]);
	const heap = Math.max(
		mb("usedBefore") - mb("usedAfter"),
		mb("sizeBefore") - mb("sizeAfter"),
	);
	const words = `${read.before} to ${read.after}`;
	return read.pssBefore === undefined
		? { words, heap }
		: { words, heap, pss: mb("pssBefore") - mb("pssAfter") };
}
