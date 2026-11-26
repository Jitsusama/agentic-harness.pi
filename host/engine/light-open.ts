/**
 * Open a hosted conversation's log holding only its kept view, without
 * first holding the whole of what the view leaves out.
 *
 * pi's open parses every line of a log whole, and the kept view
 * (kept-history.ts) lets go of what it leaves out only after: the heap
 * peaks at the whole parse first, and the process's resident memory
 * keeps that peak. Opening a 68 MB log and holding its view peaked at
 * 298 MB resident, against 172 MB opened this way. This reads the
 * log line by line as pi does, and once a compaction shows that the
 * view starts after the entries read so far, drops their heavy values:
 * an answer's content, keeping each part's type, which pi's /session
 * counts tool calls by; a tool result's content and details; a
 * summary's text and the system message a compaction keeps; and an
 * extension message's content and details.
 * Nothing the view reads of an entry it leaves out is among those: ids,
 * parents, types, usage and models, user messages and state. Every
 * entry the view holds that was read light is read again whole from its
 * own line. A log with no compaction is read once and held whole, as
 * pi's own open holds it, since the view would hold all of it.
 *
 * pi's own open stands wherever this can't match it: a log pi would
 * migrate and write back, or end without a newline, a file that isn't a
 * log, a session manager that no longer takes preloaded entries as this
 * expects, and a log whose view would hold an entry read light whole,
 * since a light entry must never reach the model.
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

/** A log read with the heavy values of what its view leaves out dropped. */
export interface LightLog {
	/** Its entries, header first, as pi's open would hold them but lighter. */
	readonly entries: unknown[];
	/** How many of `entries` were read light. */
	readonly lightened: number;
	/** The entries given, with each that was read light read again whole. */
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
	// The entries read since the last compaction, each with its line, held
	// whole until a later compaction shows the view starts after them.
	let since: { entry: Record<string, unknown>; span: Span }[] = [];
	let lightened = 0;
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
		// pi's open keeps whatever a line parses to unless it is falsy.
		if (!entry) return;
		entries.push(entry);
		if (!isRecord(entry)) return;
		if (entry.type === "compaction") {
			for (const read of since) {
				if (!lighten(read.entry)) continue;
				spans.set(read.entry, read.span);
				lightened++;
			}
			since = [];
		}
		since.push({ entry, span: { start, length: bytes.length } });
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
	return {
		entries,
		lightened,
		whole: (light) => wholeEntries(file, light, spans),
	};
}

/**
 * Drop `entry`'s heavy values, answering whether it had any. Each value
 * dropped is one the kept view never reads of an entry it leaves out.
 */
function lighten(entry: Record<string, unknown>): boolean {
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		entry.summary = "";
		delete entry.systemMessage;
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

/** Why a light open let pi's own open read its log after all. */
export class LightFellBack extends Error {}

/**
 * A report that holds what it is told until `sayTo` names where it goes,
 * then says it there, as it says all it is told after. Made apart from
 * any open, so what kept-history keeps of it keeps no open's log alive.
 */
class HeldReport {
	/** What it was told before it had anywhere to say it. */
	readonly held: unknown[] = [];
	private to: Report | undefined;

	/** Says `what` where it goes, or holds it until that is named. */
	readonly report: Report = (what) => {
		if (this.to) this.to(what);
		else this.held.push(what);
	};

	/** Says what it holds to `to`, and all it is told after. */
	sayTo(to: Report): void {
		this.to = to;
		for (const what of this.held.splice(0)) to(what);
	}
}

/** The session layers already told they are not what the light open reads. */
const toldUnlike = new WeakSet<LightPi>();

/**
 * `file` opened light and holding its kept view, in the folder that
 * stands nearest the one it names when that one is gone (as
 * gone-folder.ts's `openStanding`), or undefined when pi's own open
 * should open it. What went wrong on the way is said as a LightFellBack
 * when pi's open is left to read it, and as it was said otherwise; that
 * pi's session layer is not what this reads is said once for each layer.
 */
export function openKept(
	pi: LightPi,
	file: string,
	report: Report = () => {},
	home: string = homedir(),
): StandingOpen | undefined {
	const { SessionManager: Manager, version } = pi;
	const unlike = (why: string): undefined => {
		if (toldUnlike.has(pi)) return undefined;
		toldUnlike.add(pi);
		report(
			new LightFellBack(
				`Light opens are off, so every log is read whole first: ${why}`,
			),
		);
		return undefined;
	};
	if (typeof Manager !== "function" || typeof version !== "number")
		return unlike(
			"pi no longer has the session manager or log version it reads",
		);
	const said = new HeldReport();
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
			// What pi is given, to check it took it unchanged; a copy kept past
			// the check would hold every entry the kept view lets go of.
			const read = [...log.entries];
			// pi's own open builds its manager so when its header scan fails.
			const manager: unknown = Reflect.construct(Manager, [
				cwd ?? headerCwd ?? process.cwd(),
				dirname(path),
				path,
				true,
				undefined,
				log.entries,
			]);
			if (!took(manager, log.entries, read, path, header.id))
				throw new NotLikePi(
					"pi's session manager no longer takes a log's entries as the light open expects",
				);
			return manager;
		};
		const standing = standingOpen(open, home);
		holdKeptHistory(standing.manager, said.report, log.whole);
		// A log with nothing read light is held as pi's own open holds it,
		// so it stands whether or not the view could be taken.
		if (leftOutOf(standing.manager) || log.lightened === 0) {
			said.sayTo(report);
			return standing;
		}
		said.report(new Error("its kept view would hold entries read light"));
	} catch (error) {
		if (error instanceof NotLikePi) return unlike(error.message);
		said.report(error);
	}
	said.sayTo((what) => report(fellBack(file, what)));
	return undefined;
}

/**
 * `what`, said while opening `file` light, as the reason it fell back:
 * an error as a LightFellBack, and anything else as it was said.
 */
function fellBack(file: string, what: unknown): unknown {
	if (!(what instanceof Error)) return what;
	const why = what.message;
	return new LightFellBack(
		`The light open of ${file} fell back to pi's own open: ${why}`,
	);
}

/**
 * `file` opened holding its kept view: light when it can be, and
 * otherwise by `openWhole`, pi's own open. Why a light open fell back is
 * said only when pi's own open says nothing of its own, since a cause
 * both meet (a view that can't be built) is told best by the open that
 * stands; anything that isn't an error is always said.
 */
export function openHeld(
	pi: LightPi,
	file: string,
	report: Report,
	openWhole: (file: string, report: Report) => StandingOpen,
	home: string = homedir(),
): StandingOpen {
	const fell: unknown[] = [];
	const kept = openKept(
		pi,
		file,
		(what) => {
			if (what instanceof LightFellBack) fell.push(what);
			else report(what);
		},
		home,
	);
	if (kept) return kept;
	let saidWhole = false;
	const standing = openWhole(file, (what) => {
		saidWhole = true;
		report(what);
	});
	if (!saidWhole) for (const what of fell) report(what);
	return standing;
}

/** pi's session manager is not what the light open builds on. */
class NotLikePi extends Error {}

/**
 * Whether pi built `manager` over `entries` for `path`, as its open of
 * that file would: holding those very entries, unmigrated and unchanged
 * from `read`, indexed by them alone, and naming the log's own session.
 */
function took(
	manager: unknown,
	entries: unknown[],
	read: readonly unknown[],
	path: string,
	id: unknown,
): manager is SessionManager {
	if (!holdsLikePi(manager)) return false;
	if (manager.fileEntries !== entries || entries.length !== read.length)
		return false;
	if (!entries.every((entry, i) => entry === read[i])) return false;
	const readSet = new Set(read);
	for (const entry of manager.byId.values())
		if (!readSet.has(entry)) return false;
	return (
		manager.getSessionFile() === path &&
		manager.getSessionId() === id &&
		manager.flushed
	);
}
