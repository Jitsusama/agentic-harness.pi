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
 * since a light entry must never reach the model. A log pi's own open
 * reads as it reads any, such as one whose leaf's branch passes no
 * compaction, is left to it with nothing said. Where a log's header
 * alone leaves it to pi, it is read no further than its header, so the
 * log is not parsed twice: once here and again whole by pi.
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";
import type { Entry } from "../../lib/internal/session/rollover.ts";
import {
	openStanding,
	type StandingOpen,
	standingOpen,
} from "./gone-folder.ts";
import { holdKeptHistory, holdsLikePi, leftOutOf } from "./kept-history.ts";
import type { SessionManager } from "./pi-session.ts";

/** How much of a log one read takes, as pi's own open reads it. */
const READ_SIZE = 1024 * 1024;

/**
 * How much of a log one read takes in looking for its header, which
 * takes a few hundred bytes; a longer one is read on until it ends or
 * the look reaches its limit.
 */
const HEADER_READ_SIZE = 4096;

/**
 * How much of a log a look for its header reads at most, as pi's own
 * header scan does: 1 MiB. A header not found by then is left to the
 * light read, which stops at it all the same when it leaves the log to
 * pi; pi's open also reads its log whole then. Were pi's limit to grow,
 * a header between the two would cost a light read up to it, never a
 * wrong open, since the light read checks it too.
 */
const HEADER_SCAN_LIMIT = 1024 * 1024;

/** What `firstEntry` answers when its look reached its limit first. */
const UNSEEN: unique symbol = Symbol("header unseen");

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
 * should read it: a file that isn't a log, one whose last line is
 * unfinished, which pi's open ends with a newline of its own, and one
 * whose header `takes` turns down, which is read no further than it.
 */
export function readLight(
	file: string,
	size: number = READ_SIZE,
	takes: (header: unknown) => boolean = () => true,
): LightLog | undefined {
	const entries: unknown[] = [];
	const spans = new WeakMap<object, Span>();
	// The entries read since the last compaction, each with its line: each
	// compaction makes those before it lighter, since the view of a branch
	// passing it starts there at the latest. A branch that passes none
	// would hold them, so its log falls back to pi's own open.
	let since: { entry: Record<string, unknown>; span: Span }[] = [];
	let lightened = 0;
	const end = eachLine(file, size, (bytes, start) => {
		const entry = lineValue(bytes);
		if (entry === undefined) return true;
		if (entries.length === 0 && !takes(entry)) return false;
		entries.push(entry);
		if (!isRecord(entry)) return true;
		if (entry.type === "compaction") {
			for (const read of since) {
				if (!lighten(read.entry)) continue;
				spans.set(read.entry, read.span);
				lightened++;
			}
			since = [];
		}
		since.push({ entry, span: { start, length: bytes.length } });
		return true;
	});
	if (end === "unfinished") return undefined;
	// A header `takes` turned down stopped the read before it was kept, so
	// no header is held and the log is pi's.
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
 * How a read of a log's lines ended: at the file's end, inside a line
 * the file never finished, where `take` stopped it, or at its limit.
 */
type LinesEnd = "ended" | "unfinished" | "stopped" | "limited";

/**
 * Hand each of `file`'s lines to `take`, its newline left out, with the
 * byte it starts at, reading `size` bytes at a time, until `take` answers
 * false or `limit` bytes are read. A line's bytes are good only until
 * `take` returns.
 */
function eachLine(
	file: string,
	size: number,
	take: (bytes: Buffer, start: number) => boolean,
	limit: number = Number.POSITIVE_INFINITY,
): LinesEnd {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(size);
		// The bytes of a line begun in an earlier read, copied out of it.
		let begun: Buffer[] = [];
		let lineStart = 0;
		let scanned = 0;
		for (;;) {
			if (scanned >= limit) return "limited";
			const wanted = Math.min(size, limit - scanned);
			const read = readSync(fd, buffer, 0, wanted, null);
			if (read === 0) return begun.length > 0 ? "unfinished" : "ended";
			scanned += read;
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
				if (!take(bytes, lineStart)) return "stopped";
				lineStart += bytes.length + 1;
				from = end + 1;
			}
			if (from < read) begun.push(Buffer.from(chunk.subarray(from)));
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * What a line's `bytes` parse to as pi's open keeps them, or undefined
 * for a line it skips: a blank one, one that isn't JSON, or one whose
 * value is falsy.
 */
function lineValue(bytes: Buffer): unknown {
	const line = bytes.toString("utf8");
	if (!line.trim()) return undefined;
	try {
		return JSON.parse(line) || undefined;
	} catch {
		// pi's open skips a line that isn't JSON, so this does too.
		return undefined;
	}
}

/**
 * The first entry pi's open would keep of `file`, its header, reading no
 * further than the line that holds it; undefined when it keeps none, and
 * UNSEEN when it lies past what a look for it reads.
 */
function firstEntry(file: string): unknown {
	let first: unknown;
	const end = eachLine(
		file,
		HEADER_READ_SIZE,
		(bytes) => {
			first = lineValue(bytes);
			return first === undefined;
		},
		HEADER_SCAN_LIMIT,
	);
	return end === "limited" ? UNSEEN : first;
}

/** A log header the light open can stand on, as far as it reads one. */
interface LightHeader {
	readonly id: string;
	readonly cwd: string;
}

/**
 * `entry` as a header whose log the light open reads, or undefined for
 * one it leaves to pi's own open: a header that isn't a session's, or
 * names no id; a log pi would migrate and write back whole, over its
 * light entries; and one naming no folder, which pi's own open fills in
 * with the process's own.
 */
function lightHeader(entry: unknown, version: number): LightHeader | undefined {
	if (!isRecord(entry) || entry.type !== "session") return undefined;
	if (entry.version !== version) return undefined;
	const { id, cwd } = entry;
	if (typeof id !== "string" || typeof cwd !== "string") return undefined;
	return { id, cwd };
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
 * That pi's session layer is not what the light open reads, so every
 * later open is left to pi's own: said once, whatever pi's open says.
 */
export class LightOpensOff extends Error {}

/** Every session manager a light open stood with entries read lighter. */
const openedLight = new WeakSet<object>();

/**
 * Whether `manager` is one a light open stood with entries read lighter,
 * which only it tells from a manager pi's own open built.
 */
export function heldLight(manager: unknown): boolean {
	return typeof manager === "object" && manager !== null
		? openedLight.has(manager)
		: false;
}

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
 * pi's session layer is not what this reads is said once for each layer,
 * which every later open then leaves to pi's own unread.
 */
export function openKept(
	pi: LightPi,
	file: string,
	report: Report = () => {},
	home: string = homedir(),
): StandingOpen | undefined {
	if (toldUnlike.has(pi)) return undefined;
	const { SessionManager: Manager, version } = pi;
	const unlike = (why: string): undefined => {
		toldUnlike.add(pi);
		report(
			new LightOpensOff(
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
		// A log its header leaves to pi is read no further, since pi's own
		// open parses the whole of it again. One whose header lies past a
		// look's limit is read light up to its header, which the light read
		// checks before it reads on, as it does a header written over since
		// the look.
		const first = firstEntry(file);
		if (first !== UNSEEN && !lightHeader(first, version)) return undefined;
		const log = readLight(
			file,
			READ_SIZE,
			(entry) => lightHeader(entry, version) !== undefined,
		);
		if (!log) return undefined;
		// The header the light read took, as the view and manager read it.
		const header = lightHeader(log.entries[0], version);
		if (!header) return undefined;
		const path = resolve(file);
		const headerCwd = header.cwd;
		const open = (cwd?: string): SessionManager => {
			// What pi is given, to check it took it unchanged; a copy kept past
			// the check would hold every entry the kept view lets go of.
			const read = [...log.entries];
			// pi's own open builds its manager so when its header scan fails.
			const manager: unknown = Reflect.construct(Manager, [
				cwd ?? headerCwd,
				dirname(path),
				path,
				true,
				undefined,
				log.entries,
			]);
			if (took(manager, log.entries, read, path, header.id)) return manager;
			// pi starts a new session for a log gone by the time it looks, which
			// says nothing of its shape: that open alone falls back.
			if (!existsSync(path))
				throw new Error(`${path} was gone as pi opened it`);
			throw new NotLikePi(
				"pi's session manager no longer takes a log's entries as the light open expects",
			);
		};
		const standing = standingOpen(open, home);
		const unheld = holdQuietly(standing.manager, log.whole, said);
		// A log with nothing read light is held as pi's own open holds it,
		// so it stands whether or not the view could be taken.
		if (leftOutOf(standing.manager) || log.lightened === 0) {
			if (unheld) said.report(unheld);
			said.sayTo(report);
			if (log.lightened > 0) openedLight.add(standing.manager);
			return standing;
		}
		// Kept history left the log whole, as it would pi's own open of it,
		// such as one whose leaf's branch passes no compaction: an ordinary
		// log, which pi's own open reads, with nothing said of it: what this
		// manager's hold said, pi's own open's hold says of its own.
		if (!unheld) return undefined;
		const why = unheld.cause instanceof Error ? unheld.cause : unheld;
		said.report(
			new Error(`its kept view couldn't be built: ${why.message}`, {
				cause: why,
			}),
		);
	} catch (error) {
		if (error instanceof NotLikePi) return unlike(error.message);
		said.report(error);
	}
	said.sayTo((what) => report(fellBack(file, what)));
	return undefined;
}

/**
 * Have `manager` hold its kept view, reading light entries whole by
 * `whole`, and answer the hold's own failure, kept back from `said`:
 * where pi's open is left to read the log, that failure is why, not what
 * it says. All else the hold says, then or later, goes to `said`. Made
 * apart from the open, whose closures share one context, so the report
 * the held conversation keeps for its life keeps no open's log alive.
 */
function holdQuietly(
	manager: SessionManager,
	whole: LightLog["whole"],
	said: HeldReport,
): Error | undefined {
	let unheld: Error | undefined;
	let holding = true;
	holdKeptHistory(
		manager,
		(what) => {
			if (holding && !unheld && what instanceof Error) unheld = what;
			else said.report(what);
		},
		whole,
	);
	holding = false;
	return unheld;
}

/**
 * `what`, said while opening `file` light, as the reason it fell back:
 * an error as a LightFellBack, and anything else as it was said.
 */
function fellBack(file: string, what: unknown): unknown {
	if (!(what instanceof Error)) return what;
	return new LightFellBack(
		`The light open of ${file} fell back to pi's own open: ${what.message}`,
		{ cause: what },
	);
}

/**
 * `file` opened holding its kept view: light when it can be, and
 * otherwise by `openWhole`, pi's own open. Why a light open fell back is
 * said only when pi's own open says nothing of its own, since a cause
 * both meet (a view that can't be built) is told best by the open that
 * stands; anything else, the notice that light opens are off among it,
 * is always said.
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

/**
 * The host's open of a conversation's log, holding its kept view: light
 * when it can be, and otherwise by pi's own open of `sessions`, in the
 * folder that stands nearest the one the log names when that one is gone,
 * as a tree released once its change merged is, rather than have pi
 * refuse it. `version` is the log version pi writes.
 */
export function hostOpen(
	sessions: Parameters<typeof openStanding>[0],
	version: unknown,
	report: Report,
): (file: string) => StandingOpen {
	const pi: LightPi = { SessionManager: sessions, version };
	const openWhole = (file: string, say: Report): StandingOpen => {
		const { manager, left } = openStanding(sessions, file);
		return {
			manager: holdKeptHistory(manager, say),
			...(left ? { left } : {}),
		};
	};
	return (file) => {
		const standing = openHeld(pi, file, report, openWhole);
		const { manager, left } = standing;
		if (left)
			report(
				`Conversation ${manager.getSessionId()}'s folder ${left} is gone, so it opens in ${manager.getCwd()}`,
			);
		return standing;
	};
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
