/**
 * What a session's log in pi's store says for `pi-carry`: whether its
 * pi ever ran a turn of its own, and which sessions a later one took up,
 * read from the logs' first and last lines alone, since a log runs to
 * tens of megabytes and the store to a thousand of them.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

/** How far into a log its header, or from its end its last line, is looked for. */
const EDGE_BYTES = 64 * 1024;

/**
 * Whether the log at `file` holds nothing stamped after its header's
 * own moment: a session pi rolled over into whose pi died before a turn.
 * A log whose start can't be read, or none, says nothing, so its session
 * is carried as before.
 */
export function neverRan(file: string | undefined): boolean {
	if (file === undefined) return false;
	const first = readEdge(file, "first");
	const last = readEdge(file, "last");
	if (first === undefined || last === undefined) return false;
	const started = stampOf(first);
	const ended = stampOf(last);
	return started !== undefined && ended !== undefined && ended <= started;
}

/**
 * The sessions a later one continued, by id: each one whose log another
 * log's header names as its parent, as pi writes when one session rolls
 * over into the next. `logs` is the store's index, by session id.
 */
export function continuedSessions(
	logs: ReadonlyMap<string, string>,
): Set<string> {
	const continued = new Set<string>();
	for (const file of logs.values()) {
		const header = readEdge(file, "first");
		const parent = header === undefined ? undefined : parentOf(header);
		if (parent !== undefined) continued.add(sessionIdOf(parent));
	}
	return continued;
}

/** A log's session id, from its name, as pi's store indexes it. */
function sessionIdOf(file: string): string {
	const name = basename(file, ".jsonl");
	return name.slice(name.lastIndexOf("_") + 1);
}

/** A log's first or last whole line, or undefined when unreadable. */
function readEdge(file: string, edge: "first" | "last"): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = statSync(file).size;
		const from = edge === "first" ? 0 : Math.max(0, size - EDGE_BYTES);
		const buffer = Buffer.alloc(Math.min(size, EDGE_BYTES));
		const got = readSync(fd, buffer, 0, buffer.length, from);
		const lines = buffer
			.subarray(0, got)
			.toString("utf8")
			.split("\n")
			.filter((line) => line.trim() !== "");
		// The last edge's first line may be cut short where the read began,
		// and the first edge's last; neither is the one read.
		return edge === "first" ? lines[0] : lines[lines.length - 1];
	} catch {
		// Gone or unreadable since the listing: it says nothing either way.
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** A line's JSON object, or undefined for one cut short or not JSON. */
function objectOf(line: string): object | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? parsed : undefined;
	} catch {
		// A line cut short or not JSON: nothing to read from it.
		return undefined;
	}
}

/** The moment a log's line is stamped with, or undefined. */
function stampOf(line: string): number | undefined {
	const entry = objectOf(line);
	const stamp = entry && "timestamp" in entry ? entry.timestamp : undefined;
	if (typeof stamp !== "string") return undefined;
	const at = Date.parse(stamp);
	return Number.isNaN(at) ? undefined : at;
}

/** The log a header names as its session's parent, or undefined. */
function parentOf(line: string): string | undefined {
	const header = objectOf(line);
	const parent =
		header && "parentSession" in header ? header.parentSession : undefined;
	return typeof parent === "string" && parent !== "" ? parent : undefined;
}
