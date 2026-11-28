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
 * checks each file tool's call, both of which answer at once. So each
 * record is read once a process: on 28 November optimus's ledger held
 * 1,970 records, 7.7 MB, and reading them all took 229 ms, at every
 * strict command and every file tool's read, where the strict profile
 * otherwise costs 20 to 35 ms. Another session may not take a run id
 * whose record or folder is there (`anotherSessionsRun`), so a record
 * another session's stays so for as long as its file is listed. One
 * the sweep removed, folder and all, may be named again by anyone, so
 * the few records that read as this session's are read again at each
 * ask, and the one a fleet of this process is about to be named is
 * forgotten before it runs.
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

/** What a ledger file was read to say: whose run, and its run id. */
interface Read {
	readonly id: string;
	readonly session?: string;
}

/**
 * What each ledger's files said, by ledger folder and file name. Only a
 * record that read is kept, so one caught half written is read again.
 */
const readByLedger = new Map<string, Map<string, Read>>();

/**
 * What one ledger file says of whose run it holds, read once and kept
 * while the file is listed; undefined while it won't read, or when its
 * name isn't the one its own id gives, so a file put there under
 * another name reaches no folder but its own.
 */
function readOf(
	ledger: string,
	file: string,
	known: Map<string, Read>,
): Read | undefined {
	const kept = known.get(file);
	if (kept !== undefined) return kept;
	try {
		const record = sessionOfRecord(readFileSync(join(ledger, file), "utf8"));
		if (file !== `${safeSegment(record.id)}.json`) return undefined;
		known.set(file, record);
		return record;
	} catch {
		// Gone since the listing, or half written: read again next time.
		return undefined;
	}
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
	const ledger = fleetLedgerDir(state);
	let files: string[];
	try {
		files = readdirSync(ledger);
	} catch {
		// No ledger at all, as for a session that never ran a fleet.
		return [];
	}
	const known = readByLedger.get(ledger) ?? new Map<string, Read>();
	readByLedger.set(ledger, known);
	const listed = new Set(files);
	// A record the sweep removed reaches nothing, and is forgotten.
	for (const file of known.keys()) if (!listed.has(file)) known.delete(file);
	const store = new ReviewerArtifactsStore(state);
	const runs: string[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		// What reached this session's folder is checked again each time.
		if (known.get(file)?.session === session) known.delete(file);
		const record = readOf(ledger, file, known);
		if (record?.session === session) {
			runs.push(store.rootPaths(record.id).runDir);
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
	const file = `${safeSegment(runId)}.json`;
	const record = join(fleetLedgerDir(state), file);
	// This process may be about to write the record anew, so what it
	// last read of it says nothing.
	readByLedger.get(fleetLedgerDir(state))?.delete(file);
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
