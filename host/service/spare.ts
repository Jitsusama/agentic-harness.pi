/**
 * A warm spare child: one started before any conversation wants it, so
 * the wake that takes it skips what every child otherwise pays first.
 * On 24 November a wake took 12.1 s at the median from its unit's start
 * to ready, 3.4 s of it building pi's session services, and a probe
 * built those services in 6.3 to 13.6 s cold but 0.4 to 0.5 s once the
 * same process had built them for another folder: pi keeps the
 * package's extension factories for the whole process, since the
 * package declares `pi.sessionStateKeyed`.
 *
 * A spare's slot file holds `{"spare": true}`. The child loads the
 * host's pi, builds its session services once for a folder of its own,
 * collects, writes SLOT.warm and waits for its slot file to name what it
 * starts as, then starts as any child does. The supervisor takes a spare
 * by renaming SLOT.warm to SLOT.taken before it writes the slot, and a
 * spare leaves by unlinking SLOT.warm: only one of the two can land, so
 * a spare never leaves a take unanswered, nor is one taken once it has
 * gone. It leaves, exiting 0, when its install moves, when it holds more
 * than SPARE_MOST_BYTES, when a take names nothing within TAKE_WITHIN_MS,
 * and when its warm fails; its supervisor starts another.
 */

import { readFileSync } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { isRecord } from "../../lib/internal/record.ts";

/** What a spare may hold, in bytes, once collected, before another replaces it. */
export const SPARE_MOST_BYTES = 200 * 1024 * 1024;

/** How long, in ms, a taken spare waits for its slot to name what it starts as. */
export const TAKE_WITHIN_MS = 60_000;

/** How often, in ms, a spare looks again at its install and its size. */
export const SPARE_LOOK_MS = 60_000;

/** How often, in ms, a spare reads its slot file for a take. */
export const SLOT_LOOK_MS = 250;

const MB = 1024 * 1024;
const MS_PER_SECOND = 1000;

/** How a spare's wait ended: taken, so it starts, or left, and why. */
export type SpareEnd = { readonly taken: true } | { readonly left: string };

/** The marks beside a spare's slot file that settle a take against a leave. */
export interface SpareMarks {
	/** Written once warm; renamed to `taken` by a take, unlinked by a leave. */
	readonly warm: string;
	readonly taken: string;
}

/** The marks beside `slotFile`, SLOT.json. */
export function spareMarks(slotFile: string): SpareMarks {
	const base = slotFile.replace(/\.json$/, "");
	return { warm: `${base}.warm`, taken: `${base}.taken` };
}

/** Whether `slotFile` holds a spare's `{"spare": true}`, read as it stands now. */
export function isSpareSlot(slotFile: string): boolean {
	return heldNow(slotFile) === "spare";
}

/**
 * What `slotFile` holds now: a spare's mark, something else a child
 * starts from, or nothing readable, as one renamed into place mid-read.
 */
function heldNow(slotFile: string): "spare" | "named" | "unread" {
	let held: unknown;
	try {
		held = JSON.parse(readFileSync(slotFile, "utf8"));
	} catch {
		// Gone or half written: read again on the next look.
		return "unread";
	}
	if (!isRecord(held)) return "named";
	return held.spare === true ? "spare" : "named";
}

/** What a spare's wait is given. */
export interface SpareWait {
	readonly slotFile: string;
	/** Load the host's pi and build its services once, so the take finds them built. */
	readonly warm: () => Promise<void>;
	/** Why the spare's code no longer fits, once its install has moved; none while it fits. */
	readonly moved: () => Promise<string | undefined>;
	/** What the spare holds now, in bytes, collected first where it can be; none unread. */
	readonly size: () => number | undefined;
	readonly report: (said: string) => void;
	readonly lookMs?: number;
	readonly slotLookMs?: number;
	readonly takeWithinMs?: number;
	readonly mostBytes?: number;
}

/**
 * Warm the spare, then wait until a take names what it starts as, or
 * until it has reason to leave and its leave lands before any take.
 */
export async function spareUntilTaken(wait: SpareWait): Promise<SpareEnd> {
	const lookMs = wait.lookMs ?? SPARE_LOOK_MS;
	const slotLookMs = wait.slotLookMs ?? SLOT_LOOK_MS;
	const takeWithinMs = wait.takeWithinMs ?? TAKE_WITHIN_MS;
	const mostBytes = wait.mostBytes ?? SPARE_MOST_BYTES;
	const marks = spareMarks(wait.slotFile);
	const began = Date.now();
	try {
		await wait.warm();
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return { left: `its warm failed: ${why}` };
	}
	const warmed = Date.now() - began;
	const overSize = () => {
		const held = wait.size();
		return held !== undefined && held > mostBytes
			? `it holds ${Math.round(held / MB)} MB, past the ${Math.round(mostBytes / MB)} MB a spare may`
			: undefined;
	};
	const held = wait.size();
	wait.report(
		`A warm spare: warmed in ${(warmed / MS_PER_SECOND).toFixed(1)} s, holding ${held === undefined ? "an unread size" : `${Math.round(held / MB)} MB`}`,
	);
	const tooBig = overSize();
	if (tooBig) return { left: tooBig };
	await writeFile(marks.warm, "");
	let lookedAt = Date.now();
	let takenAt: number | undefined;
	for (;;) {
		if (heldNow(wait.slotFile) === "named") return { taken: true };
		if (takenAt === undefined && (await exists(marks.taken)))
			takenAt = Date.now();
		if (takenAt !== undefined) {
			if (Date.now() - takenAt > takeWithinMs)
				return {
					left: `it was taken, but its slot named nothing within ${takeWithinMs / MS_PER_SECOND} s`,
				};
		} else if (Date.now() - lookedAt >= lookMs) {
			lookedAt = Date.now();
			// A take renames one mark into the other, so with both gone the
			// slot was cleared, and nothing will ever take this spare.
			if (!((await exists(marks.warm)) || (await exists(marks.taken))))
				return { left: "its slot was cleared" };
			const why = (await wait.moved()) ?? overSize();
			if (why && (await leave(marks))) return { left: why };
		}
		await pause(slotLookMs);
	}
}

/**
 * Take the spare whose marks are `marks`, for its supervisor: true when
 * the take landed, false when the spare had left, or never warmed.
 */
export async function takeSpare(marks: SpareMarks): Promise<boolean> {
	try {
		await rename(marks.warm, marks.taken);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

/** Leave, unless a take has landed first: true when the leave landed. */
async function leave(marks: SpareMarks): Promise<boolean> {
	try {
		await unlink(marks.warm);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		// Not there, or unreadable: no take has landed that it can see.
		return false;
	}
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
