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
 *
 * Two may want one note: the cutover, to adopt the log into a host, and
 * a join in the session's own window that takes the move back when the
 * cutover gives up, to run `pi --session` there instead (H2's move in
 * place, 11 November). Each claims the note by renaming it to a name of
 * its own before acting on it, and a rename whose source has gone fails,
 * so exactly one of the two acts and the log never gets two writers.
 * A claimed note is no longer `<session>.json`, so no other reader sees
 * it; a cutover that dies holding one leaves it for the next to give
 * back (restoreStrandedClaims).
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
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

/** Between a session's name and the pid of the cutover adopting it. */
const ADOPTING = ".adopting-";

/** Between a session's name and the pid of the join taking it back. */
const TAKEN = ".taken-";

const STRANDED = /^(.+)\.adopting-(\d+)$/;

function nameOf(session: string): string {
	return session.replace(/[^A-Za-z0-9-]/g, "_");
}

function noteFile(folder: string, session: string): string {
	return join(folder, `${nameOf(session)}${NOTE}`);
}

function adoptingFile(folder: string, session: string, pid: number): string {
	return join(folder, `${nameOf(session)}${ADOPTING}${pid}`);
}

/** Whether a rename's source had gone, the one failure a claim expects. */
function isGone(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** Rename `from` to `to`: true once done, false when `from` had gone. */
function claim(from: string, to: string): boolean {
	try {
		renameSync(from, to);
		return true;
	} catch (error) {
		if (isGone(error)) return false;
		throw error;
	}
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

/**
 * Where a session's note stands: `waiting` for a cutover to take it up,
 * `claimed` by a cutover adopting the log now, or `none` at all, as once
 * it was taken up or taken back, or when it was never left.
 */
export type NoteState = "waiting" | "claimed" | "none";

/** Where the note `session`'s move left stands now. */
export function noteState(
	session: string,
	folder: string = moveFolder(),
): NoteState {
	if (readMoveNote(session, folder) !== undefined) return "waiting";
	const claimed = `${nameOf(session)}${ADOPTING}`;
	try {
		return readdirSync(folder).some((name) => name.startsWith(claimed))
			? "claimed"
			: "none";
	} catch {
		// No folder: no note was ever left.
		return "none";
	}
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

/** The move was taken up: its note goes, claimed or not. */
export function removeMoveNote(
	session: string,
	folder: string = moveFolder(),
): void {
	rmSync(noteFile(folder, session), { force: true });
	const claimed = `${nameOf(session)}${ADOPTING}`;
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder: no claim to take away either.
		return;
	}
	for (const name of names)
		if (name.startsWith(claimed)) rmSync(join(folder, name), { force: true });
}

/**
 * Claim a session's note for the cutover running as `pid`, before it
 * asks a host to adopt the log: the note, or nothing when it has gone,
 * taken back by the session's join or never left. Give it back if the
 * host won't adopt, and remove it once one has.
 */
export function claimMoveNote(
	session: string,
	pid: number,
	folder: string = moveFolder(),
): MoveNote | undefined {
	const held = adoptingFile(folder, session, pid);
	if (!claim(noteFile(folder, session), held)) return undefined;
	const note = readNote(held);
	if (note === undefined) claim(held, noteFile(folder, session));
	return note;
}

/** Give a claimed note back, as the host wouldn't adopt its log. */
export function giveBackMoveNote(
	session: string,
	pid: number,
	folder: string = moveFolder(),
): void {
	claim(adoptingFile(folder, session, pid), noteFile(folder, session));
}

/** What a join asking for its session's move back was told. */
export type TakeBack = "taken" | "adopting";

/**
 * Take a session's move back for the join running as `pid`, so it can
 * run `pi --session` in the session's own window: "taken" once the note
 * is the join's and gone, so no cutover adopts the log; "adopting" when
 * the cutover holds the note or it has already gone, with the log in a
 * host or on its way, and the join should view it there instead. A note
 * the cutover gives back can be taken on a later ask.
 */
export function takeBackMove(
	session: string,
	pid: number,
	folder: string = moveFolder(),
): TakeBack {
	const taken = join(folder, `${nameOf(session)}${TAKEN}${pid}`);
	if (!claim(noteFile(folder, session), taken)) return "adopting";
	rmSync(taken, { force: true });
	return "taken";
}

/**
 * Give back every note a cutover claimed and died holding, judged by
 * whether its pid still runs, so the next cutover or join can take it.
 * A note written again since stays, and the stranded claim goes.
 */
export function restoreStrandedClaims(
	alive: (pid: number) => boolean,
	folder: string = moveFolder(),
): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder: nothing has moved.
		return;
	}
	for (const name of names) {
		const stranded = STRANDED.exec(name);
		if (!stranded || alive(Number(stranded[2]))) continue;
		const back = join(folder, `${stranded[1]}${NOTE}`);
		if (names.includes(`${stranded[1]}${NOTE}`))
			rmSync(join(folder, name), { force: true });
		else claim(join(folder, name), back);
	}
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
