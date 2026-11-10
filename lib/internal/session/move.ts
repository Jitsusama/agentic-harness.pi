/**
 * Moving a session: ending a pi the moment it is free, so a host can
 * take its file up under the same session id and address, or ending a
 * hosted conversation so plain pi can.
 *
 * The person asks it with the steer act `move` (lib/mesh/steer.ts),
 * naming where to: a host of the session's realm by its kind, or `pi`.
 * The session waits until nothing of its own is out (free.ts), so no
 * run, job, prompt or typed word is lost and nothing races its end,
 * then writes a note here and ends as Close does. The note is what the
 * move's other half reads: the cutover adopts the file it names into
 * that host and takes the note away (host/cutover/), and a release's
 * note stays, read as a `released` entry of restore.json, until a plain
 * pi starts the session again and takes it away itself.
 *
 * One file a session, `<session>.json`, in its realm's `moves/` folder
 * of the package's state, written whole: a host serves one realm, as
 * the mesh and the steer inboxes do.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import { isRecord } from "../record.ts";
import { writeWhole } from "../write-whole.ts";

/** Where a session moves to: a host of its realm, by kind, or plain pi. */
export const MOVE_TARGETS = ["attended", "background", "pi"] as const;

/** One of MOVE_TARGETS. */
export type MoveTarget = (typeof MOVE_TARGETS)[number];

/** Whether a value names where a session can move to. */
export function isMoveTarget(value: unknown): value is MoveTarget {
	return (MOVE_TARGETS as readonly unknown[]).includes(value);
}

/** What a session that moved left for whoever takes it up. */
export interface MoveNote {
	readonly session: string;
	/** Its log, which the host adopts or `pi --session` opens. */
	readonly sessionFile: string;
	/** The folder it ran in. */
	readonly cwd: string;
	readonly to: MoveTarget;
	/** When it ended to move, as an ISO time. */
	readonly at: string;
	/** The mesh addresses it answered to, its signature first. */
	readonly addresses: readonly string[];
	readonly quest?: string;
	readonly title?: string;
	/** The host it left, by key (`work-attended`), when it left one. */
	readonly from?: string;
	/**
	 * The process it ended in, so a reader can see a pi gone; a hosted
	 * conversation's is its host's, which outlives it, so a release is
	 * seen done by the host's list instead.
	 */
	readonly pid: number;
}

/** The folder move notes are kept in. */
export function moveFolder(): string {
	return stateDir("moves");
}

const NOTE = ".json";

function noteFile(folder: string, session: string): string {
	return join(folder, `${session.replace(/[^A-Za-z0-9-]/g, "_")}${NOTE}`);
}

/** Leave the note a session's move is taken up by. */
export function writeMoveNote(
	note: MoveNote,
	folder: string = moveFolder(),
): void {
	mkdirSync(folder, { recursive: true });
	writeWhole(noteFile(folder, note.session), `${JSON.stringify(note)}\n`);
}

/** The note a session's move left, if it left one. */
export function readMoveNote(
	session: string,
	folder: string = moveFolder(),
): MoveNote | undefined {
	return readNote(noteFile(folder, session));
}

/** Every note a move left and nobody has taken up, oldest first. */
export function readMoveNotes(folder: string = moveFolder()): MoveNote[] {
	let names: string[];
	try {
		names = readdirSync(folder).filter((name) => name.endsWith(NOTE));
	} catch {
		// No folder: nothing has moved.
		return [];
	}
	return names
		.map((name) => readNote(join(folder, name)))
		.filter((note): note is MoveNote => note !== undefined)
		.sort((one, other) => one.at.localeCompare(other.at));
}

/** The move was taken up: its note goes. */
export function removeMoveNote(
	session: string,
	folder: string = moveFolder(),
): void {
	rmSync(noteFile(folder, session), { force: true });
}

function readNote(path: string): MoveNote | undefined {
	try {
		return moveNoteFrom(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// Missing, half-written by an older writer, or not JSON: no note.
		return undefined;
	}
}

/** A move note read from outside, or nothing when it is not one. */
export function moveNoteFrom(value: unknown): MoveNote | undefined {
	if (!isRecord(value)) return undefined;
	const { session, sessionFile, cwd, to, at, addresses, pid } = value;
	if (
		typeof session !== "string" ||
		session === "" ||
		typeof sessionFile !== "string" ||
		!sessionFile.startsWith("/") ||
		typeof cwd !== "string" ||
		!isMoveTarget(to) ||
		typeof at !== "string" ||
		!Array.isArray(addresses) ||
		!addresses.every((one) => typeof one === "string") ||
		typeof pid !== "number"
	) {
		return undefined;
	}
	const text = (key: string) => {
		const one = value[key];
		return typeof one === "string" && one !== "" ? { [key]: one } : {};
	};
	return {
		session,
		sessionFile,
		cwd,
		to,
		at,
		addresses,
		...text("quest"),
		...text("title"),
		...text("from"),
		pid,
	};
}
