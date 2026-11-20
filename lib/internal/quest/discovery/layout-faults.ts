/**
 * The health record of quest layout faults: a quest folder with no
 * README, a nested quest, a document out of place. A walk skips each,
 * and every session start finds the same ones again, so a notice on
 * the screen at each start or reload asked nothing new of the person
 * and read as the reload failing. Each fault is written here once, the
 * first time a walk finds it, as a JSON line naming when, where and
 * what, and nothing reaches the screen.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "../../../core/internal/file-lock.ts";
import { stateDir } from "../../paths.ts";
import { isRecord } from "../../record.ts";
import type { DiscoveryError } from "./discovery.ts";

/** The record's file name, under the quest workflow's state folder. */
const RECORD_NAME = "layout-faults.jsonl";

/** Where the layout faults are kept on this machine. */
export function layoutFaultsFile(): string {
	return join(stateDir("quest-workflow"), RECORD_NAME);
}

/**
 * Write each of `faults` not already in the record at `file`, once,
 * and answer how many were new. Sessions start together after a
 * restart, so the read and the append are held under the file's lock,
 * and two that find the same fault write it once between them.
 */
export async function keepLayoutFaults(
	faults: readonly DiscoveryError[],
	file: string = layoutFaultsFile(),
	now: () => Date = () => new Date(),
): Promise<number> {
	if (faults.length === 0) return 0;
	mkdirSync(dirname(file), { recursive: true });
	return withFileLock(file, async () => {
		const known = recordedFaults(file);
		const lines: string[] = [];
		for (const fault of faults) {
			const key = faultKey(fault.path, fault.message);
			if (known.has(key)) continue;
			known.add(key);
			const at = now().toISOString();
			lines.push(
				JSON.stringify({ at, path: fault.path, message: fault.message }),
			);
		}
		if (lines.length > 0) appendFileSync(file, `${lines.join("\n")}\n`);
		return lines.length;
	});
}

/** The faults the record at `file` already holds, by path and message. */
function recordedFaults(file: string): Set<string> {
	const known = new Set<string>();
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// No record yet: nothing is known, and the first append makes it.
		return known;
	}
	for (const line of text.split("\n")) {
		const fault = faultOf(line);
		if (fault) known.add(faultKey(fault.path, fault.message));
	}
	return known;
}

/** A recorded line read back as a fault, or undefined when it isn't one. */
function faultOf(line: string): DiscoveryError | undefined {
	if (line.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// A line cut short by a crash mid-append names no fault; the
		// fault it was writing is written again when next found.
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const { path, message } = parsed;
	if (typeof path !== "string" || typeof message !== "string") return undefined;
	return { path, message };
}

/** One fault's identity: the same message about the same path. */
function faultKey(path: string, message: string): string {
	return `${path}\u0000${message}`;
}
