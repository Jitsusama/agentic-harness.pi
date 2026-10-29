/**
 * Which session may keep the machine queue, by the rules its code gives
 * turns by.
 *
 * Any session may keep the queue, and turns go by the code of whichever
 * takes its lock. A session whose code is older gives them by older
 * rules: from 14:06 to 19:00 on 29 October nine sessions that had
 * stopped following their install kept it under rules from before VM
 * starts were paced, and six VMs started within two and a half minutes.
 * So each keeper says the version of its rules in the queue folder, and
 * one with an older version leaves keeping to the newer while that one
 * keeps. Once none has kept for {@link NEWER_KEEPER_MS}, as after the
 * install is rolled back, the older keeps again.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../record.ts";

/** How long a newer keeper counts as keeping after it last kept. */
export const NEWER_KEEPER_MS = 60_000;

/** The file naming the newest rules a keeper kept by, and when. */
const RULES_FILE = "rules.json";

interface Seen {
	readonly version: number;
	readonly at: number;
}

function seenIn(dir: string): Seen | undefined {
	try {
		const seen: unknown = JSON.parse(
			readFileSync(join(dir, RULES_FILE), "utf8"),
		);
		if (
			isRecord(seen) &&
			typeof seen.version === "number" &&
			typeof seen.at === "number"
		) {
			return { version: seen.version, at: seen.at };
		}
	} catch {
		// No file, or one being replaced: no newer keeper is known.
	}
	return undefined;
}

/**
 * Whether a keeper whose rules are `version` may keep the queue at `dir`
 * now, saying so in the folder when it may. False while a keeper with
 * newer rules has kept within {@link NEWER_KEEPER_MS}.
 */
export function mayKeep(dir: string, version: number, now: number): boolean {
	const seen = seenIn(dir);
	if (seen && seen.version > version && now - seen.at < NEWER_KEEPER_MS) {
		return false;
	}
	const file = join(dir, RULES_FILE);
	const next = `${file}.${process.pid}`;
	try {
		writeFileSync(next, `${JSON.stringify({ version, at: now })}\n`);
		renameSync(next, file);
	} catch {
		// Unwritten, the next keep says it; this one still keeps.
	}
	return true;
}
