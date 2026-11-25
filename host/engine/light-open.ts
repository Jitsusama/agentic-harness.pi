/**
 * Open a hosted conversation's log holding only its kept view, without
 * first holding the whole of what the view leaves out.
 *
 * pi's open parses every line of a log whole, and the kept view
 * (kept-history.ts) lets go of what it leaves out only after: the heap
 * peaks at the whole parse first, and the process's resident memory
 * keeps that peak. Opening a 68 MB log and holding its view peaked at
 * 297 MB resident, against 207 MB opened this way. This reads the
 * log line by line as pi does, but drops each entry's heavy values as it
 * parses it: an answer's content, keeping each part's type, which pi's
 * /session counts tool calls by; a tool result's content and details; a
 * summary's text; and an extension message's content and details.
 * Nothing the view reads of an entry it leaves out is among those: ids,
 * parents, types, usage and models, user messages and state. Every
 * entry the view holds is read again whole from its own line.
 *
 * pi's own open stands wherever this can't match it: a log pi would
 * migrate and write back, or end without a newline, a file that isn't a
 * log, a session manager that no longer takes preloaded entries as this
 * expects, and a log the view would hold whole, whose light entries
 * must never reach the model.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";
import type { Entry } from "../../lib/internal/session/rollover.ts";
import { type StandingOpen, standingOpen } from "./gone-folder.ts";
import { holdKeptHistory, holdsLikePi, leftOutOf } from "./kept-history.ts";
import type { SessionManager } from "./pi-session.ts";

/** How much of a log one read takes, as pi's own open reads it. */
const READ_SIZE = 1024 * 1024;

/** The byte that ends each of a log's lines. */
const NEWLINE = 0x0a;

/** Where a line sits in its file, in bytes, its newline left out. */
interface Span {
	readonly start: number;
	readonly length: number;
}

/** A log read with its entries' heavy values dropped. */
export interface LightLog {
	/** Its entries, header first, as pi's open would hold them but lighter. */
	readonly entries: unknown[];
	/** `entries`, each one read light read again whole from its line. */
	whole(entries: readonly Entry[]): Entry[];
}

/**
 * `file` read light, `size` bytes a read, or undefined when pi's own open
 * should read it: a file that isn't a log, or one whose last line is
 * unfinished, which pi's open ends with a newline of its own.
 */
export function readLight(
	file: string,
	size: number = READ_SIZE,
): LightLog | undefined {
	const entries: unknown[] = [];
	const spans = new WeakMap<object, Span>();
	const take = (bytes: Buffer, start: number): void => {
		const line = bytes.toString("utf8");
		if (!line.trim()) return;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			// pi's open skips a line that isn't JSON, so this does too.
			return;
		}
		// pi's open keeps whatever a line parses to but null and false.
		if (!entry) return;
		if (isRecord(entry) && lighten(entry))
			spans.set(entry, { start, length: bytes.length });
		entries.push(entry);
	};
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(size);
		// The bytes of a line begun in an earlier read, copied out of it.
		let begun: Buffer[] = [];
		let lineStart = 0;
		for (;;) {
			const read = readSync(fd, buffer, 0, size, null);
			if (read === 0) break;
			const chunk = buffer.subarray(0, read);
			let from = 0;
			for (
				let end = chunk.indexOf(NEWLINE, from);
				end !== -1;
				end = chunk.indexOf(NEWLINE, from)
			) {
				const rest = chunk.subarray(from, end);
				const bytes = begun.length > 0 ? Buffer.concat([...begun, rest]) : rest;
				begun = [];
				take(bytes, lineStart);
				lineStart += bytes.length + 1;
				from = end + 1;
			}
			if (from < read) begun.push(Buffer.from(chunk.subarray(from)));
		}
		if (begun.length > 0) return undefined;
	} finally {
		closeSync(fd);
	}
	const header = entries[0];
	if (!isRecord(header) || header.type !== "session") return undefined;
	if (typeof header.id !== "string") return undefined;
	return { entries, whole: (light) => wholeEntries(file, light, spans) };
}

/**
 * Drop `entry`'s heavy values, answering whether it had any. Each value
 * dropped is one the kept view never reads of an entry it leaves out.
 */
function lighten(entry: Record<string, unknown>): boolean {
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		entry.summary = "";
		return true;
	}
	if (entry.type === "custom_message") {
		entry.content = "";
		delete entry.details;
		return true;
	}
	if (entry.type !== "message" || !isRecord(entry.message)) return false;
	const message = entry.message;
	if (message.role === "assistant") {
		message.content = Array.isArray(message.content)
			? message.content.map((part) =>
					isRecord(part) ? { type: part.type } : part,
				)
			: [];
		return true;
	}
	if (message.role === "toolResult") {
		message.content = [];
		delete message.details;
		return true;
	}
	return false;
}

/** `light`, each entry `spans` places read again whole from `file`. */
function wholeEntries(
	file: string,
	light: readonly Entry[],
	spans: WeakMap<object, Span>,
): Entry[] {
	let fd: number | undefined;
	try {
		return light.map((entry) => {
			const span = spans.get(entry);
			if (!span) return entry;
			fd ??= openSync(file, "r");
			const bytes = Buffer.alloc(span.length);
			const read = readSync(fd, bytes, 0, span.length, span.start);
			const again = lineEntry(bytes.subarray(0, read));
			if (again?.id !== entry.id)
				throw new Error(
					`${file} changed as it opened: the line of entry ${entry.id} no longer holds it`,
				);
			return again;
		});
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The entry `bytes` hold, or undefined when they hold none. */
function lineEntry(bytes: Buffer): Entry | undefined {
	try {
		const entry: unknown = JSON.parse(bytes.toString("utf8"));
		return isEntry(entry) ? entry : undefined;
	} catch {
		// A line that no longer parses holds no entry.
		return undefined;
	}
}

/** Whether `value` is a log entry, as far as the view reads one. */
function isEntry(value: unknown): value is Entry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.id === "string"
	);
}

/** pi's session layer, as the light open builds a manager from it. */
export interface LightPi {
	/** pi's SessionManager class, whose constructor takes preloaded entries. */
	readonly SessionManager: unknown;
	/** The log version pi writes, which it migrates every older log to. */
	readonly version: unknown;
}

/** Says what to say, or the error that stopped something. */
type Report = (said: unknown) => void;

/**
 * `file` opened light and holding its kept view, in the folder that
 * stands nearest the one it names when that one is gone (as
 * gone-folder.ts's `openStanding`), or undefined when pi's own open
 * should open it, said when that is because something failed.
 */
export function openKept(
	pi: LightPi,
	file: string,
	report: Report = () => {},
	home: string = homedir(),
): StandingOpen | undefined {
	const { SessionManager: Manager, version } = pi;
	if (typeof Manager !== "function" || typeof version !== "number")
		return undefined;
	try {
		const log = readLight(file);
		if (!log) return undefined;
		const header = log.entries[0];
		// pi migrates an older log and writes it back whole, which would
		// write the light entries over it.
		if (!isRecord(header) || header.version !== version) return undefined;
		const path = resolve(file);
		const headerCwd = typeof header.cwd === "string" ? header.cwd : undefined;
		const open = (cwd?: string): SessionManager => {
			// pi's own open builds its manager so when its header scan fails.
			const manager: unknown = Reflect.construct(Manager, [
				cwd ?? headerCwd ?? process.cwd(),
				dirname(path),
				path,
				true,
				undefined,
				log.entries,
			]);
			if (!took(manager, log.entries, path))
				throw new NotLikePi(
					"pi's session manager no longer takes a log's entries as the light open expects",
				);
			return manager;
		};
		const standing = standingOpen(open, home);
		holdKeptHistory(standing.manager, report, log.whole);
		return leftOutOf(standing.manager) ? standing : undefined;
	} catch (error) {
		if (!(error instanceof NotLikePi)) report(error);
		return undefined;
	}
}

/** pi's session manager is not what the light open builds on. */
class NotLikePi extends Error {}

/**
 * Whether pi built `manager` over `entries` for `path`, as its open of
 * that file would: holding those very entries, unmigrated.
 */
function took(
	manager: unknown,
	entries: unknown[],
	path: string,
): manager is SessionManager {
	return (
		holdsLikePi(manager) &&
		manager.fileEntries === entries &&
		manager.getSessionFile() === path &&
		manager.flushed
	);
}
