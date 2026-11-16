/**
 * What a conversation's bash calls left running once they ended by
 * themselves, kept through its park and its host's restart.
 *
 * A command that ends by itself keeps what it started with `&`, since a
 * server or a long build left running is often the point of it
 * (extensions/shell-workflow/reap.ts), and plain pi keeps it while its
 * session idles. A host reaped it instead at every park: each park
 * closes the conversation, and the close ended every process carrying
 * its marker. On 16 November the attended host's restart parked
 * FEH1HE's conversation and so ended a check run of core #4979 it had
 * left building with `&` (WCJQSG [b675818d]); an hour's idle park ends
 * one the same way.
 *
 * So a park notes, by each call's mark, what the conversation's ended
 * calls left, and every reap after spares those marks: the park's own,
 * the wake's and the next host's at its start. A call running at the
 * park is signalled, and its stop ends what it left by its mark before
 * the park looks, so what is still marked then is what ended calls
 * left. What an extension started carries no call's mark, and still
 * ends with the park. A close, a crash or a kill -9 notes nothing, so
 * what they cut ends as before. A note goes a day after its park, the
 * same day a carried call nobody took up runs (carried-shells.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CarriedCalls } from "../../lib/internal/shell/kept.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { STRAY_FOR_MS } from "./carried-shells.ts";

/** The file, in the host engine's state, that names what parks kept running. */
export const LEFT_FILE = "left-running.json";

/** One call whose leftovers a park kept, as the next reap reads it. */
interface LeftCall {
	readonly session: string;
	readonly mark: string;
	/** When the park noted it, in milliseconds since the epoch. */
	readonly at: number;
}

/** What the engine asks of what parks kept running. */
export interface LeftRunning {
	/** Note that a parking conversation's ended calls, by these marks, left processes running. */
	note(session: string, marks: Iterable<string>): void;
	/** What a reap spares: what is carried, and what parks noted within a day. */
	spared(carried: CarriedCalls): CarriedCalls;
	/** A conversation closed for good: spare no longer what its parks kept. */
	closed(session: string): void;
}

function isLeftCall(value: unknown): value is LeftCall {
	if (typeof value !== "object" || value === null) return false;
	const { session, mark, at } = value as Record<string, unknown>;
	return (
		typeof session === "string" &&
		typeof mark === "string" &&
		typeof at === "number"
	);
}

/** Keep what parks noted in the host engine's state folder. */
export function leftRunning(options: {
	readonly stateDir: string;
	readonly report: (error: unknown) => void;
	readonly now?: () => number;
}): LeftRunning {
	const file = join(options.stateDir, LEFT_FILE);
	const now = options.now ?? Date.now;

	// The notes still within their day, oldest first.
	function read(): LeftCall[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// No file: no park kept anything, or it was unreadable and keeps nothing.
			return [];
		}
		const since = now() - STRAY_FOR_MS;
		return Array.isArray(parsed)
			? parsed.filter(isLeftCall).filter(({ at }) => at > since)
			: [];
	}

	return {
		note(session, marks) {
			const at = now();
			const added = [...marks].map((mark) => ({ session, mark, at }));
			if (added.length === 0) return;
			const fresh = new Set(added.map(({ mark }) => mark));
			const kept = read().filter(({ mark }) => !fresh.has(mark));
			try {
				writeWhole(file, `${JSON.stringify([...kept, ...added])}\n`);
			} catch (error) {
				options.report(error);
			}
		},
		spared(carried) {
			const left = read();
			if (left.length === 0) return carried;
			return {
				marks: new Set([...carried.marks, ...left.map(({ mark }) => mark)]),
				groups: carried.groups,
			};
		},
		closed() {},
	};
}
