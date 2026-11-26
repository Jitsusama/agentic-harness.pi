/**
 * The key-wide sweep a supervisor runs for its child hosts, which each
 * reap and look over only their own conversation (host/service/child.ts):
 * what a dead host's tools left running under the key, and each command
 * a stop kept or a restart carried that nobody now holds, once it is due.
 * A realm-kind host does both at its start and every STRAY_LOOK_MS
 * (engine.ts). N children on one key doing it would each kill the
 * others' kept commands and race on the files, so none does, and their
 * supervisor calls this once every child it adopted is watched, and on
 * a timer after.
 *
 * Children keep their notes in a folder per conversation under the key's
 * engine folder, beside its store; a host still running conversations in
 * its own process keeps them in the engine folder itself. Both are read.
 * What a conversation named in `spare` started is left alone, as one a
 * live child runs or is starting for, or the in-process host still runs:
 * its own reaps and looks are its own.
 *
 * The process table is read a few environments at a time without holding
 * the loop, as every reap reads it (tool-children.ts). The key's folder
 * holds every conversation it ever stored, so it is listed once, for
 * whom to spare and what to look over alike, only those holding a note
 * are looked over, found without holding the loop, and the sweep's own
 * cgroup is read once for all of them.
 */

import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	type CarriedCalls,
	carriedCalls,
} from "../../lib/internal/shell/kept.ts";
import {
	type CarriedShellsOptions,
	carriedShells,
	KEPT_FILE,
} from "./carried-shells.ts";
import { conversationsUnder, LEFT_FILE, sparedUnder } from "./left-running.ts";
import {
	linuxProcessTable,
	type ProcessTable,
	REAP_WAITED,
	type Reaped,
	reapLeftBehind,
} from "./tool-children.ts";

/** What a sweep is given beside the key and what it spares. */
export interface SweepOptions {
	/** The key's engine folder; host-engine/KEY in the harness's state by default. */
	readonly stateDir?: string;
	readonly table?: ProcessTable;
	/** The calls handed on and not yet said ended; the shell's record by default. */
	readonly carried?: () => CarriedCalls | Promise<CarriedCalls>;
	/** Writes a line to the journal, as each call it stops. */
	readonly say: (line: string) => void;
	readonly report: (error: unknown) => void;
	readonly now?: () => number;
	/** How each kept call is judged running and stopped, and what jobs recorded; the machine's by default. */
	readonly shells?: Pick<
		CarriedShellsOptions,
		"running" | "stop" | "recorded" | "ownCgroup" | "scoped"
	>;
}

/** What a sweep ended: what dead hosts' tools left, and how many folders it looked in. */
export interface Swept {
	readonly reaped: Reaped;
	readonly folders: number;
}

/**
 * Sweep a key for what no live host holds: end what dead hosts' tools
 * left running, and stop each kept or carried command whose conversation
 * nobody holds once it is due, sparing every conversation in `spare`.
 */
export async function sweepUnheld(
	key: string,
	spare: ReadonlySet<string>,
	options: SweepOptions,
): Promise<Swept> {
	const root = options.stateDir ?? join(stateDir("host-engine"), key);
	const { report, say } = options;
	const listed = await conversationsUnder(root, report);
	const folders = [root, ...(await notedFolders(listed))];
	const now = options.now ? { now: options.now } : {};
	const held = (session: string) => spare.has(session);
	const ownCgroup = onceRead(
		options.shells?.ownCgroup ??
			(() => readFileSync("/proc/self/cgroup", "utf8")),
	);
	// Read as a host's start reads them, so the two never disagree on
	// whom to spare, waiting alike while the folder fails to list.
	const spared = await sparedUnder(
		root,
		await (options.carried ?? carriedCalls)(),
		{ report, listed, ...now },
	);
	const reaped = await reapLeftBehind(
		key,
		options.table ?? linuxProcessTable(),
		spared,
		held,
	);
	if (reaped.waited) say(`${REAP_WAITED} under ${key}`);
	if (reaped.groups.length > 0 || reaped.pids.length > 0)
		say(
			`Ended what a host's tools left running under ${key}: groups ${reaped.groups.join(", ") || "none"}, processes ${reaped.pids.join(", ") || "none"}`,
		);
	for (const [index, folder] of folders.entries()) {
		// A held conversation's own folder is its child's to keep: a look
		// drops what a conversation holds from the file it reads, and the
		// child would lose its record of what it carries.
		if (index > 0 && held(basename(folder))) continue;
		try {
			await carriedShells({
				...options.shells,
				ownCgroup,
				stateDir: folder,
				say,
				report,
				...now,
				...(options.table ? { table: options.table } : {}),
				// What jobs recorded is one record for the key, looked at once.
				...(index === 0 ? {} : { recorded: () => [] }),
			}).look(held);
		} catch (error) {
			report(error);
		}
	}
	return { reaped, folders: folders.length };
}

/** `read`, asked once and its answer kept for every later ask. */
function onceRead(read: () => string): () => string {
	let kept: string | undefined;
	return () => {
		kept ??= read();
		return kept;
	};
}

/** Whether a folder holds a note a sweep reads. */
async function holdsNote(folder: string): Promise<boolean> {
	const found = await Promise.all(
		[KEPT_FILE, LEFT_FILE].map((name) =>
			access(join(folder, name)).then(
				() => true,
				() => false,
			),
		),
	);
	return found.includes(true);
}

/**
 * Each of the listed conversations' folders that holds a note; none
 * when the key's folder failed to list, as there is nothing to look over
 * until it lists again.
 */
async function notedFolders(
	listed: readonly string[] | "unread",
): Promise<string[]> {
	if (listed === "unread") return [];
	const noted = await Promise.all(listed.map(holdsNote));
	return listed.filter((_, index) => noted[index]);
}
