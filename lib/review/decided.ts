/**
 * What has already been settled about a change's findings.
 *
 * Deciding a finding has an effect somewhere else: promoting puts it in
 * a draft, dismissing drops it, queueing makes it work. None of those
 * leave a mark on the finding, so a listing of what was raised reads
 * identically before and after a session of deciding, and the second
 * reader cannot tell a finding nobody has looked at from one already
 * dealt with.
 *
 * That was noticed once and solved once, for fixes only. This is the
 * same fact for the other two verdicts, so it is recorded the same way:
 * one small ledger per change, beside the findings themselves.
 *
 * It is deliberately not the fix queue. A queued fix carries how to do
 * it, the commit that did it and the reason it was abandoned; a verdict
 * carries none of that. Merging them would put four optional fields on
 * a record that mostly wants two.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChangeRef } from "./change.js";
import { changeKey } from "./keys.js";

/**
 * What was decided.
 *
 * `fix` is here for completeness of the record even though the fix
 * queue owns the work, so one read answers "has this been dealt with"
 * for every verdict rather than for two of three.
 *
 * Named for the tool's `settle` parameter, and deliberately not
 * `Verdict`, which this library already uses for what you say about a
 * whole change: approve, request changes, comment. Those are different
 * kinds of judgement and sharing a name would invite passing one where
 * the other belongs.
 */
export type Settlement = "promote" | "dismiss" | "fix";

/** One settled finding. */
export interface Decision {
	findingId: number;
	verdict: Settlement;
	/** What the decider said, when they said anything. */
	note?: string;
	decidedAt: string;
}

/** The ledger of what has been settled on one change. */
export interface DecisionLedger {
	/**
	 * Settle a finding, or re-settle one.
	 *
	 * Changing your mind is ordinary, so unlike a fix outcome this
	 * overwrites rather than refusing. What would be wrong is silence:
	 * a re-decision that kept the old verdict would make the listing
	 * lie.
	 */
	record(
		change: ChangeRef,
		findingId: number,
		verdict: Settlement,
		note?: string,
	): Promise<Decision>;
	/** Every decision on this change, oldest first. */
	list(change: ChangeRef): Promise<Decision[]>;
}

/** Where one change's decisions live. */
function fileFor(root: string, change: ChangeRef): string {
	return join(root, `${changeKey(change)}.json`);
}

/** Read the ledger, treating anything unreadable as empty. */
async function read(path: string): Promise<Decision[]> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return Array.isArray(parsed) ? (parsed as Decision[]) : [];
	} catch {
		// Absent, truncated or not JSON: nothing has been decided that we
		// can prove, and refusing to read would block the whole listing
		// over a record that is only an aid to the reader.
		return [];
	}
}

/** A ledger of decisions, stored under `root`. */
export function createDecisionLedger(root: string): DecisionLedger {
	return {
		async record(change, findingId, verdict, note) {
			const path = fileFor(root, change);
			const held = await read(path);
			const decision: Decision = {
				findingId,
				verdict,
				...(note === undefined ? {} : { note }),
				decidedAt: new Date().toISOString(),
			};
			// Replace in place so a re-decision keeps its position, which
			// keeps the listing order stable across a change of mind.
			const at = held.findIndex((one) => one.findingId === findingId);
			if (at === -1) held.push(decision);
			else held[at] = decision;

			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(held, null, 2)}\n`, "utf8");
			return decision;
		},

		async list(change) {
			return await read(fileFor(root, change));
		},
	};
}
