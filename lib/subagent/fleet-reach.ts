/**
 * Where a session's fleets keep their reports, and which of those run
 * folders are its own: what a strict parent may read of pi's state.
 *
 * A fleet's answer names each job's report under the fleet's run
 * folder, in pi's state, which the strict profile keeps from the
 * session's commands and from pi's file tools alike. So a strict parent
 * couldn't read the reports its own fleet had just written (on 28
 * November, two fleets finished 4/4 with every report unread), and ran
 * the fleet again with each job writing into its tree. The parent's
 * read reach gains the run folders the fleet ledger names under its
 * own session, read-only, and nothing else of the state folder: not
 * another session's runs, not a review round's transcripts, not the
 * ledger itself.
 *
 * Read rather than the reports moved under a folder the parent reaches,
 * since every folder a strict command reaches it may also write, or
 * every other strict session reaches as well: its supervisor reads its
 * instructions from the run folder, and a parent that could write there
 * could rewrite them.
 *
 * Synchronous, since the sandbox asks it as it wraps each command and
 * checks each file tool's call, both of which answer at once.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../internal/paths.ts";
import { ReviewerArtifactsStore } from "./artifacts.ts";
import { safeSegment } from "./errno.ts";

/** Where the subagent tool keeps its fleets' run folders and ledger. */
export function fleetStateDir(): string {
	return stateDir("subagent-workflow");
}

/** Where the fleet ledger is kept, under the fleets' state folder. */
export function fleetLedgerDir(state: string): string {
	return join(state, "fleets");
}

/** The session a ledger record names, as far as this reads one. */
function sessionOfRecord(text: string): { id: string; session?: string } {
	const record: unknown = JSON.parse(text);
	if (typeof record !== "object" || record === null) {
		throw new Error("not a fleet record");
	}
	const { id, session } = record as Record<string, unknown>;
	if (typeof id !== "string") throw new Error("not a fleet record");
	return typeof session === "string" ? { id, session } : { id };
}

/**
 * The run folders of the fleets `session` dispatched, as the ledger
 * under `state` holds them: for as long as the ledger keeps a fleet,
 * which is as long as the sweep keeps its folder. None for a session
 * not known, and a record that won't read gives none.
 */
export function ownFleetRuns(
	session: string | undefined,
	state: string = fleetStateDir(),
): string[] {
	if (session === undefined || session === "") return [];
	let files: string[];
	try {
		files = readdirSync(fleetLedgerDir(state));
	} catch {
		// No ledger at all, as for a session that never ran a fleet.
		return [];
	}
	const store = new ReviewerArtifactsStore(state);
	const runs: string[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		let text: string;
		try {
			text = readFileSync(join(fleetLedgerDir(state), file), "utf8");
		} catch {
			continue;
		}
		// Most records are other sessions', so they go unparsed.
		if (!text.includes(session)) continue;
		try {
			const record = sessionOfRecord(text);
			// Only the record its own id names, so a file put there under
			// another name gives no folder but its own.
			if (
				record.session === session &&
				file === `${safeSegment(record.id)}.json`
			) {
				runs.push(store.rootPaths(record.id).runDir);
			}
		} catch {
			// A record that won't read reaches nothing.
		}
	}
	return runs;
}

/**
 * Whether a fleet run named `runId` would share another session's run
 * folder: the ledger holds it under another session, or a record that
 * won't read, or its folder is there with no record to say whose it is.
 * A fleet the session named so would write its reports beside that
 * session's, and its strict parent would read them.
 */
export function anotherSessionsRun(
	runId: string,
	session: string | undefined,
	state: string = fleetStateDir(),
): boolean {
	const record = join(fleetLedgerDir(state), `${safeSegment(runId)}.json`);
	let text: string | undefined;
	try {
		text = readFileSync(record, "utf8");
	} catch {
		text = undefined;
	}
	if (text === undefined) {
		return existsSync(
			new ReviewerArtifactsStore(state).rootPaths(runId).runDir,
		);
	}
	try {
		return sessionOfRecord(text).session !== session;
	} catch {
		return true;
	}
}
