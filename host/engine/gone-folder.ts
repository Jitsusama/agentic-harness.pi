/**
 * Where a conversation opens when the folder its log names is gone, as a
 * tree released once its change merged is: the nearest folder above it
 * that still stands, or the home folder, rather than pi refusing the
 * whole conversation at its start (pi's MissingSessionCwdError).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { SessionManager, SessionManagerStatics } from "./pi-session.ts";

/** The custom message that tells a conversation its folder moved. */
export const FOLDER_GONE_TYPE = "host-folder-gone";

/** A conversation's log, opened in a folder that stands. */
export interface StandingOpen {
	readonly manager: SessionManager;
	/** The folder its log names, gone when it opened; absent when it stands. */
	readonly left?: string;
}

/** How much of a log is read for its header's folder before pi opens it. */
const HEADER_BYTES = 64 * 1024;

/**
 * Open the log at `file` as pi does, in the folder that stands nearest
 * the one it names when that one is gone.
 */
export function openStanding(
	sessions: Pick<SessionManagerStatics, "open">,
	file: string,
	home: string = homedir(),
): StandingOpen {
	return standingOpen(
		(cwd) => sessions.open(file, undefined, cwd),
		home,
		namedFolder(file),
	);
}

/**
 * A log opened by `open` in the folder it names, or in the folder that
 * stands nearest it when that one is gone. Given the folder it `named`,
 * a gone one is known before the open, so the log is read once rather
 * than once in the gone folder and again where it stands.
 */
export function standingOpen(
	open: (cwd?: string) => SessionManager,
	home: string = homedir(),
	named?: string,
): StandingOpen {
	// Resolved as pi resolves it: an empty one is the process's own folder.
	const folder = named === undefined ? undefined : resolve(named);
	if (folder !== undefined && isGone(folder))
		return { manager: open(standingFolder(folder, home)), left: folder };
	const manager = open();
	const left = manager.getCwd();
	if (!left || !isGone(left)) return { manager };
	return { manager: open(standingFolder(left, home)), left };
}

/**
 * The nearest folder above `gone` that still exists, or `home` when only
 * the root does, or `fallback` when home is gone or is the root itself:
 * a conversation never opens at the root unasked.
 */
export function standingFolder(
	gone: string,
	home: string,
	fallback: string = tmpdir(),
): string {
	for (let at = dirname(gone); at !== dirname(at); at = dirname(at))
		if (!isGone(at)) return at;
	return home !== dirname(home) && !isGone(home) ? home : fallback;
}

/**
 * The folder the session header on `file`'s first line names, as pi's
 * open reads it, or nothing when the first line isn't a session header
 * naming one within HEADER_BYTES: pi's own open then says which it is.
 */
function namedFolder(file: string): string | undefined {
	let line: string;
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.allocUnsafe(HEADER_BYTES);
			const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
			const end = buffer.subarray(0, read).indexOf("\n");
			// A header cut off at HEADER_BYTES fails to parse below.
			line = buffer.toString("utf8", 0, end === -1 ? read : end);
		} finally {
			closeSync(fd);
		}
	} catch {
		// A log that can't be read here is left to pi's open, which says why.
		return undefined;
	}
	let header: unknown;
	try {
		header = JSON.parse(line);
	} catch {
		// A first line that isn't JSON is no header; pi's open reads past it.
		return undefined;
	}
	if (typeof header !== "object" || header === null) return undefined;
	const type: unknown = Reflect.get(header, "type");
	const id: unknown = Reflect.get(header, "id");
	const cwd: unknown = Reflect.get(header, "cwd");
	return type === "session" && typeof id === "string" && typeof cwd === "string"
		? cwd
		: undefined;
}

/**
 * Whether nothing is at `path`. A folder that can't be read, as one
 * behind a lock or a mount gone stale, is no proof it is gone, so only
 * the system saying there is no such entry moves a conversation.
 */
function isGone(path: string): boolean {
	try {
		statSync(path);
		return false;
	} catch (error) {
		const code =
			error instanceof Error ? Reflect.get(error, "code") : undefined;
		return code === "ENOENT" || code === "ENOTDIR";
	}
}

/** What a conversation is told when it opens somewhere other than its log says. */
export function folderGoneLine(left: string, now: string): string {
	return `The folder this conversation was in, ${left}, is gone, so it opened in ${now} instead. Commands run there now, and a path under the old folder no longer exists.`;
}

/**
 * Whether the newest folder-gone message in `entries` already tells of
 * this same move, so a conversation reopened across restarts is told once.
 */
export function toldOfMove(
	entries: readonly object[],
	left: string,
	now: string,
): boolean {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (Reflect.get(entry ?? {}, "customType") !== FOLDER_GONE_TYPE) continue;
		const details: unknown = Reflect.get(entry ?? {}, "details");
		if (typeof details !== "object" || details === null) return false;
		return (
			Reflect.get(details, "left") === left &&
			Reflect.get(details, "now") === now
		);
	}
	return false;
}
