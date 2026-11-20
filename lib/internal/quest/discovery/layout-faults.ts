/**
 * The health record of quest layout faults: a quest folder with no
 * README, a nested quest, a document out of place. A walk skips each,
 * and every session start finds the same ones again, so a notice on
 * the screen at each start or reload asked nothing new of the person
 * and read as the reload failing.
 *
 * The record holds the faults the latest start found, each with when it
 * was first seen, so a reader can tell what holds now: a fault since
 * fixed drops out, and one that comes back counts as new. A fault new
 * to the record, and a record that can't be written, go to the system's
 * journal at warning, once; nothing reaches the screen.
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

/** The record as written: when it was checked, and what it found. */
export interface LayoutFaultsRecord {
	readonly checkedAt: string;
	readonly faults: readonly KeptLayoutFault[];
}

/** What keepLayoutFaults may be told, each with a default for pi. */
export interface KeepLayoutFaultsOptions {
	/** The record's path. */
	readonly file?: string;
	/** The clock. */
	readonly now?: () => Date;
	/** Where a new fault or a failed write is said. */
	readonly journal?: (line: string) => void;
}

/** Where the layout faults are kept on this machine. */
export function layoutFaultsFile(): string {
	return join(stateDir("quest-workflow"), RECORD_NAME);
}

/**
 * Replace the record with `faults`, the ones a start just found,
 * keeping when each was first seen, and journal each one the record
 * didn't hold. It answers the new faults and never rejects: a record
 * that can't be written is journalled, and the next start writes it.
 * Sessions start together after a restart, so the read and the write
 * are held under the file's lock.
 */
export async function keepLayoutFaults(
	faults: readonly DiscoveryError[],
	options: KeepLayoutFaultsOptions = {},
): Promise<readonly DiscoveryError[]> {
	const file = options.file ?? layoutFaultsFile();
	const now = options.now ?? (() => new Date());
	const journal = options.journal ?? warnInJournal;
	try {
		// The lock's own file sits beside the record, so its folder comes first.
		mkdirSync(dirname(file), { recursive: true });
		const fresh = await withFileLock(file, async () =>
			replaceRecord(file, faults, now().toISOString()),
		);
		for (const fault of fresh)
			journal(
				`quest-workflow: ${fault.path} is skipped from the quest index: ${fault.message}`,
			);
		return fresh;
	} catch (error) {
		journal(
			`quest-workflow: the quest layout record ${file} couldn't be written: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/** The record at `file`, or undefined when there is none to read. */
export function readLayoutFaults(
	file: string = layoutFaultsFile(),
): LayoutFaultsRecord | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// No record yet: no start has found a fault to write.
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Written whole and renamed into place, so an unreadable record
		// is someone else's edit; the next start writes it afresh.
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.checkedAt !== "string")
		return undefined;
	const faults = Array.isArray(parsed.faults) ? parsed.faults : [];
	return {
		checkedAt: parsed.checkedAt,
		faults: faults.flatMap((fault) => keptFaultOf(fault) ?? []),
	};
}

/**
 * Write `faults` as the record at `file`, checked `at`, and answer the
 * ones it didn't already hold. A start that finds none and no record
 * writes nothing, so a machine with a tidy tree has no file.
 */
function replaceRecord(
	file: string,
	faults: readonly DiscoveryError[],
	at: string,
): DiscoveryError[] {
	const before = readLayoutFaults(file);
	if (faults.length === 0 && before === undefined) return [];
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

/** One fault's identity: the same message about the same path. */
function faultKey(fault: DiscoveryError): string {
	return `${fault.path}\u0000${fault.message}`;
}

/** Say `line` in the system's journal at warning. */
function warnInJournal(line: string): void {
	sayInJournal(line, journalCommand("warning"));
}
