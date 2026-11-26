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

/**
 * How much of a log is read first for its header line, which is short.
 * Reading 64 KB of every log for it, and splitting all of it on lines,
 * was 0.26 s of a woken conversation's start on 14 November, which
 * reads the header of each log in its line.
 */
const FIRST_BYTES = 4 * 1024;

/** How much of a log is read at most for its header line. */
const HEADER_BYTES = 64 * 1024;

/** A log's header, or nothing when there is no log there pi wrote. */
export function sessionLogHeader(path: string): SessionLogHeader | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		return headerIn(readHeaderLine(fd));
	} catch {
		// No log there yet, or not one pi wrote: nothing to read.
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** A log's first line: from its first bytes, or more when it is long. */
function readHeaderLine(fd: number): string {
	for (const size of [FIRST_BYTES, HEADER_BYTES]) {
		const buffer = Buffer.alloc(size);
		const read = readSync(fd, buffer, 0, size, 0);
		const text = buffer.toString("utf8", 0, read);
		const end = text.indexOf("\n");
		if (end >= 0) return text.slice(0, end);
		if (read < size) return text;
	}
	return "";
}

function headerIn(line: string): SessionLogHeader | undefined {
	const header: unknown = JSON.parse(line);
	if (typeof header !== "object" || header === null) return undefined;
	const { id, cwd, parentSession } = header as Record<string, unknown>;
	if (typeof id !== "string") return undefined;
	return {
		id,
		...(typeof cwd === "string" ? { cwd } : {}),
		...(typeof parentSession === "string" ? { parentSession } : {}),
	};
}

/**
 * Each indexed session's parent, as its log's header names it: the
 * session a rollover or a fork carried on from. `logs` maps a session's
 * id to its log, as indexSessionFiles finds them. Each log's header is
 * read at most once, however many asks walk through it, and a parent's
 * id is taken from the index by its log's path, so only a parent log
 * the index lacks has its own header read. Walking every open session's
 * line back for the restore file read two headers a step, ancestors
 * shared by many sessions again for each: 0.89 s of seven starts'
 * threads on 26 November.
 */
export function logParents(
	logs: ReadonlyMap<string, string>,
	headerOf: (path: string) => SessionLogHeader | undefined = sessionLogHeader,
): (sessionId: string) => string | undefined {
	const idAt = new Map<string, string>();
	for (const [id, path] of logs) idAt.set(path, id);
	const parents = new Map<string, string | undefined>();
	return (sessionId) => {
		if (parents.has(sessionId)) return parents.get(sessionId);
		const log = logs.get(sessionId);
		const parentLog = log ? headerOf(log)?.parentSession : undefined;
		const parent = parentLog
			? (idAt.get(parentLog) ?? headerOf(parentLog)?.id)
			: undefined;
		parents.set(sessionId, parent);
		return parent;
	};
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
