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
 * So a park, or any stop of the host's, such as a restart's of a
 * conversation busy at the drain, notes by each call's mark what the
 * conversation's ended calls left, and every reap after spares those
 * marks: the stop's own, the wake's and the next host's at its start. A
 * call running at the stop is signalled, and its stop ends what it left
 * by its mark before the look, or it is carried to the next host and
 * left out, so what is still marked then is what ended calls left. What
 * an extension started carries no call's mark, and still ends with the
 * stop. A release or pi's replacement in the seat hands the conversation
 * on, and keeps the same way. A close for good notes nothing and drops
 * the conversation's notes, so what its earlier parks kept ends with it,
 * parked or running.
 * A crash or a kill -9 notes nothing, so what they cut ends as before.
 * A note goes a day after its stop, the same day a carried call nobody
 * took up runs (carried-shells.ts). While the notes fail to read for the
 * moment, a reap waits, and a note or a close is said and left undone.
 *
 * A child host notes in its conversation's own folder under the key's
 * engine folder, where a host running conversations in its own process
 * notes in the engine folder itself, and a conversation moves between
 * them. So a child's reaps also spare what the engine folder's notes
 * name, and its close drops its conversation's notes from both; and a
 * host's start, which reaps the whole key, spares every folder's notes
 * (`sparedUnder`), as the supervisor's sweep does (sweep.ts).
 */

import { type Dirent, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isPassingFault } from "../../lib/internal/files/errno.ts";
import { isRecord } from "../../lib/internal/record.ts";
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

/** What is said when the notes failed to read for the moment, so `what` was left undone. */
function unknownNotes(what: string): Error {
	return new Error(
		`Could not ${what}: what parks kept running failed to read for the moment`,
	);
}

/** What the engine asks of what parks kept running. */
export interface LeftRunning {
	/** Note that a stopping conversation's ended calls, by these marks, left processes running. */
	note(session: string, marks: Iterable<string>): void;
	/** What a reap spares: what is carried, and what parks noted within a day. */
	spared(carried: CarriedCalls): CarriedCalls;
	/** A conversation closed for good: spare no longer what its parks kept, answering how many calls' notes went. */
	closed(session: string): number;
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

/** A file's text, nothing when it is missing or unreadable for good, or "unread" while it fails to read for the moment. */
type NoteText = string | undefined | "unread";

/** The notes a file's text holds still within their day, oldest first, none when there is no text or it doesn't parse. */
function notesIn(text: string | undefined, since: number): LeftCall[] {
	if (text === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Unreadable: it keeps nothing, as no file would.
		return [];
	}
	return Array.isArray(parsed)
		? parsed.filter(isLeftCall).filter(({ at }) => at > since)
		: [];
}

/** How a failed read of a notes file reads: "unread" for a fault of the moment, else no file. */
function textOnFault(error: unknown): NoteText {
	// No file: no park kept anything, or it was unreadable and keeps nothing.
	return isPassingFault(error) ? "unread" : undefined;
}

function readNow(file: string): NoteText {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		return textOnFault(error);
	}
}

/** `carried`, sparing also what `left` names. */
function spare(carried: CarriedCalls, left: readonly LeftCall[]): CarriedCalls {
	if (left.length === 0) return carried;
	return {
		...carried,
		marks: new Set([...carried.marks, ...left.map(({ mark }) => mark)]),
	};
}

/** What a reap spares beside `carried` from these files' texts: it waits while any of them is unread. */
function sparedFrom(
	carried: CarriedCalls,
	texts: readonly NoteText[],
	since: number,
): CarriedCalls {
	if (texts.includes("unread")) return { ...carried, unread: true };
	return spare(
		carried,
		texts.flatMap((text) =>
			notesIn(text === "unread" ? undefined : text, since),
		),
	);
}

/**
 * What a host's start, reaping the whole key, spares beside `carried`:
 * what parks noted in the key's engine folder and in each conversation's
 * folder under it, which children keep, read without holding the loop.
 */
export async function sparedUnder(
	stateDir: string,
	carried: CarriedCalls,
	options: {
		readonly report: (error: unknown) => void;
		readonly now?: () => number;
	},
): Promise<CarriedCalls> {
	let entries: Dirent[];
	try {
		entries = await readdir(stateDir, { withFileTypes: true });
	} catch (error) {
		if (isPassingFault(error)) return { ...carried, unread: true };
		// No folder yet: no host under the key has noted anything.
		if (!(isRecord(error) && error.code === "ENOENT")) options.report(error);
		return carried;
	}
	const files = [
		join(stateDir, LEFT_FILE),
		...entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(stateDir, entry.name, LEFT_FILE)),
	];
	const texts = await Promise.all(
		// Most conversations' folders hold no note: nothing to spare there.
		files.map((file) => readFile(file, "utf8").catch(textOnFault)),
	);
	return sparedFrom(carried, texts, (options.now ?? Date.now)() - STRAY_FOR_MS);
}

/** Keep what parks noted in the host engine's state folder, or a child's own folder under it. */
export function leftRunning(options: {
	readonly stateDir: string;
	/** The folder the notes go in at each use, rather than `stateDir`, as a child host keeps its own. */
	readonly keptIn?: () => string;
	readonly report: (error: unknown) => void;
	readonly now?: () => number;
}): LeftRunning {
	const keptIn = options.keptIn ?? (() => options.stateDir);
	const leftFile = () => join(keptIn(), LEFT_FILE);
	const now = options.now ?? Date.now;
	// Its own file first, then the engine folder's, when a child keeps its own.
	function files(): string[] {
		const own = leftFile();
		const root = join(options.stateDir, LEFT_FILE);
		return own === root ? [own] : [own, root];
	}

	// A file's notes still within their day, oldest first, or nothing while
	// it fails to read for the moment and what it says isn't known.
	function readOf(file: string): LeftCall[] | undefined {
		const text = readNow(file);
		if (text === "unread") return undefined;
		return notesIn(text, now() - STRAY_FOR_MS);
	}

	return {
		note(session, marks) {
			const at = now();
			const added = [...marks].map((mark) => ({ session, mark, at }));
			if (added.length === 0) return;
			const fresh = new Set(added.map(({ mark }) => mark));
			const left = readOf(leftFile());
			// Writing only these would lose the notes it couldn't read.
			if (left === undefined) {
				options.report(unknownNotes(`note ${session}'s calls`));
				return;
			}
			const kept = left.filter(({ mark }) => !fresh.has(mark));
			try {
				writeWhole(leftFile(), `${JSON.stringify([...kept, ...added])}\n`);
			} catch (error) {
				options.report(error);
			}
		},
		spared(carried) {
			return sparedFrom(carried, files().map(readNow), now() - STRAY_FOR_MS);
		},
		closed(session) {
			let ended = 0;
			// The engine folder's file is another host's too: a note it writes
			// between this read and write is lost, and its call then ends at
			// the next reap, as it did before notes were kept at all.
			for (const file of files()) {
				const left = readOf(file);
				// Its notes there stay to their day's end, sparing more, never less.
				if (left === undefined) {
					options.report(unknownNotes(`end ${session}'s notes`));
					continue;
				}
				const kept = left.filter((call) => call.session !== session);
				if (kept.length === left.length) continue;
				ended += left.length - kept.length;
				try {
					writeWhole(file, `${JSON.stringify(kept)}\n`);
				} catch (error) {
					options.report(error);
				}
			}
			return ended;
		},
	};
}
