/**
 * The health record of quest layout faults: a quest folder with no
 * README, a nested quest, a document out of place. A walk skips each,
 * and every session start finds the same ones again, so a notice on
 * the screen at each start or reload asked nothing new of the person
 * and read as the reload failing.
 *
 * The record holds the faults the latest walk of a quests root found,
 * each with when it was first seen, so a reader can tell what holds now:
 * a fault since fixed drops out, and one that comes back counts as new.
 * A fault new to the record goes to the system's journal at warning,
 * once; a record that can't be written goes there with every fault it
 * would have held, at each start until it can be. Nothing reaches the
 * screen.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "../../../core/internal/file-lock.ts";
import { atomicWriteFile } from "../../../core/internal/notes/io.ts";
import { stateDir } from "../../paths.ts";
import { isRecord } from "../../record.ts";
import { journalCommand, sayInJournal } from "../../session/journal.ts";
import type { DiscoveryError } from "./discovery.ts";

/** The record's file name, under the quest workflow's state folder. */
const RECORD_NAME = "layout-faults.json";

/** A fault the record holds, with when a start first found it. */
export interface KeptLayoutFault extends DiscoveryError {
	readonly since: string;
}

/**
 * The record as written: the quests root walked, when the walk was
 * made, and what it found.
 */
export interface LayoutFaultsRecord {
	readonly root: string;
	readonly checkedAt: string;
	readonly faults: readonly KeptLayoutFault[];
}

/**
 * The record read back: none written yet, which is a tidy tree's state
 * or a write that has failed every time (said in the journal), one that
 * can't be read, and why, or the record itself.
 */
export type LayoutFaultsReading =
	| { readonly kind: "none" }
	| { readonly kind: "unreadable"; readonly reason: string }
	| { readonly kind: "read"; readonly record: LayoutFaultsRecord };

/** What keepLayoutFaults may be told, each with a default for pi. */
export interface KeepLayoutFaultsOptions {
	/** The record's path. */
	readonly file?: string;
	/** The clock. */
	readonly now?: () => Date;
	/** Where new faults or a failed write are said, a line each. */
	readonly journal?: (lines: readonly string[]) => void;
}

/** Where the layout faults are kept on this machine. */
export function layoutFaultsFile(): string {
	return join(stateDir("quest-workflow"), RECORD_NAME);
}

/**
 * Replace the record with `faults`, the ones a walk of `root` just
 * found, keeping when each was first seen, and journal each one the
 * record didn't hold. Call it straight after the walk, since the walk's
 * time is taken here. It answers the new faults and never rejects: a
 * record that can't be written is journalled with the faults, and the
 * next start writes it. Sessions start together after a restart, so the
 * read and the write are held under the file's lock, and a walk older
 * than the record's leaves it as it is.
 */
export async function keepLayoutFaults(
	root: string,
	faults: readonly DiscoveryError[],
	options: KeepLayoutFaultsOptions = {},
): Promise<readonly DiscoveryError[]> {
	const file = options.file ?? layoutFaultsFile();
	const at = (options.now ?? (() => new Date()))().toISOString();
	const journal = options.journal ?? warnInJournal;
	const say = (lines: readonly string[]) => {
		if (lines.length === 0) return;
		try {
			journal(lines);
		} catch {
			// The journal is the record's last word: when it can't be
			// told either, there is nowhere left to say it, and the start
			// must not fail over a log line.
		}
	};
	try {
		// The lock's own file sits beside the record, so its folder comes first.
		mkdirSync(dirname(file), { recursive: true });
		const fresh = await withFileLock(file, async () =>
			replaceRecord(file, root, faults, at),
		);
		say(fresh.map(faultLine));
		return fresh;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		say([
			`quest-workflow: the quest layout record ${JSON.stringify(file)} couldn't be written: ${JSON.stringify(reason)}`,
			...faults.map(faultLine),
		]);
		return [];
	}
}

/** The record at `file`, read back for what it holds. */
export function readLayoutFaults(
	file: string = layoutFaultsFile(),
): LayoutFaultsReading {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { kind: "none" };
		return { kind: "unreadable", reason: String(error) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { kind: "unreadable", reason: String(error) };
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.root !== "string" ||
		typeof parsed.checkedAt !== "string" ||
		!Array.isArray(parsed.faults)
	)
		return { kind: "unreadable", reason: "not a layout faults record" };
	return {
		kind: "read",
		record: {
			root: parsed.root,
			checkedAt: parsed.checkedAt,
			faults: parsed.faults.flatMap((fault) => keptFaultOf(fault) ?? []),
		},
	};
}

/**
 * Write `faults` as the record at `file`, from a walk of `root` made
 * `at`, and answer the ones it didn't already hold. A start that finds
 * none and no record writes nothing, so a machine with a tidy tree has
 * no file; one that can't read the record writes it afresh. A walk of
 * the same root a little older than the record's changes nothing, since
 * a start racing it has written what holds; only a little, so a record
 * stamped ahead of the clock, or with no date, can't freeze it.
 */
function replaceRecord(
	file: string,
	root: string,
	faults: readonly DiscoveryError[],
	at: string,
): DiscoveryError[] {
	const reading = readLayoutFaults(file);
	if (faults.length === 0 && reading.kind === "none") return [];
	const before =
		reading.kind === "read" && reading.record.root === root
			? reading.record
			: undefined;
	if (before && racedBy(before.checkedAt, at)) return [];
	const since = new Map(
		(before?.faults ?? []).map((fault) => [faultKey(fault), fault.since]),
	);
	const kept = new Map<string, KeptLayoutFault>();
	const fresh: DiscoveryError[] = [];
	for (const fault of faults) {
		const key = faultKey(fault);
		if (kept.has(key)) continue;
		const first = since.get(key);
		if (first === undefined) fresh.push(fault);
		kept.set(key, {
			path: fault.path,
			message: fault.message,
			since: first ?? at,
		});
	}
	const record: LayoutFaultsRecord = {
		root,
		checkedAt: at,
		faults: [...kept.values()],
	};
	atomicWriteFile(file, `${JSON.stringify(record, null, "\t")}\n`);
	return fresh;
}

/** One recorded fault read back, or undefined when it isn't one. */
function keptFaultOf(value: unknown): KeptLayoutFault | undefined {
	if (!isRecord(value)) return undefined;
	const { path, message, since } = value;
	if (
		typeof path !== "string" ||
		typeof message !== "string" ||
		typeof since !== "string"
	)
		return undefined;
	return { path, message, since };
}

/**
 * The longest a walk can trail a racing start's: sessions that start
 * together after a restart walk within seconds of each other.
 */
const RACE_MS = 60_000;

/** Whether a record checked `checkedAt` is a racing start's, newer than `at`. */
function racedBy(checkedAt: string, at: string): boolean {
	const ahead = Date.parse(checkedAt) - Date.parse(at);
	return ahead > 0 && ahead <= RACE_MS;
}

/** One fault's identity: the same message about the same path. */
function faultKey(fault: DiscoveryError): string {
	return `${fault.path}\u0000${fault.message}`;
}

/**
 * A fault as one journal line. The path and the message are quoted as
 * JSON, so a folder's name can't break the line in two: the journal
 * reads a line opening `<N>` as written at level N.
 */
function faultLine(fault: DiscoveryError): string {
	return `quest-workflow: a quest layout fault at ${JSON.stringify(fault.path)}: ${JSON.stringify(fault.message)}`;
}

/** Say `lines` in the system's journal at warning, in one write. */
function warnInJournal(lines: readonly string[]): void {
	sayInJournal(lines.join("\n"), journalCommand("warning"));
}
