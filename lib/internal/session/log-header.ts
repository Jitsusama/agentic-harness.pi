/**
 * A session log's header, and whether a log carries another one on.
 *
 * pi switching into a log can mean another conversation (a resume, a
 * new session) or the same one in a fresh log (a rollover, which writes
 * the fresh log with the old one named as its `parentSession`; see
 * rollover.ts). What a session holds for its conversation, its quest
 * and its background jobs, goes with it only in the second case, and
 * the header is how the two are told apart.
 */

import { closeSync, openSync, readSync } from "node:fs";

/** The fields of a log's first line that say whose it is. */
export interface SessionLogHeader {
	readonly id: string;
	readonly cwd?: string;
	readonly parentSession?: string;
}

/** How much of a log is read for its header line, which is short. */
const HEADER_BYTES = 64 * 1024;

/** A log's header, or nothing when there is no log there pi wrote. */
export function sessionLogHeader(path: string): SessionLogHeader | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(HEADER_BYTES);
		const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
		const line = buffer.toString("utf8", 0, read).split("\n")[0] ?? "";
		const header: unknown = JSON.parse(line);
		if (typeof header !== "object" || header === null) return undefined;
		const { id, cwd, parentSession } = header as Record<string, unknown>;
		if (typeof id !== "string") return undefined;
		return {
			id,
			...(typeof cwd === "string" ? { cwd } : {}),
			...(typeof parentSession === "string" ? { parentSession } : {}),
		};
	} catch {
		// No log there yet, or not one pi wrote: nothing to read.
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The id of the session that carries `from` on, when the log at
 * `target` names the log `from` as its parent; otherwise nothing.
 */
export function carriedOnIn(
	target: string | undefined,
	from: string | undefined,
): string | undefined {
	if (!target || !from) return undefined;
	const header = sessionLogHeader(target);
	return header?.parentSession === from ? header.id : undefined;
}
