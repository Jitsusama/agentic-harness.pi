/**
 * Sweeping ended sessions' trees, a few minutes after a session starts
 * and every hour after.
 *
 * At a session's start rather than its end, since a session that is
 * killed never runs its end, and any later start sees every owner that
 * has ended since. A few minutes in, so a session's first turns don't
 * share the disk with a removal, and every hour, since a session can run
 * for days. Off the turn, and never waited on: what it did goes to a log
 * beside the trees' records, one JSON line a sweep.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	listTreeProviders,
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../lib/core/work/index.ts";
import { createTreeMemory } from "../../lib/core/work/memory.ts";
import {
	type SweepOutcome,
	sweepEndedTrees,
} from "../../lib/core/work/sweep.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import { discoverQuests } from "../../lib/internal/quest/discovery.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace-root.ts";
import { unattendedExec } from "../../lib/internal/unattended-exec.ts";
import { treeRecordDir } from "./broker.ts";

/** How long after a session starts its first sweep runs. */
const FIRST_SWEEP_MS = 3 * 60 * 1000;

/** How often a session sweeps after its first. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

let first: ReturnType<typeof setTimeout> | undefined;
let every: ReturnType<typeof setInterval> | undefined;

/** Sweep a while after each session starts and hourly, until it ends. */
export function registerTreeSweeps(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		stopSweeps();
		first = setTimeout(() => void sweepOnce(pi), FIRST_SWEEP_MS);
		every = setInterval(() => void sweepOnce(pi), SWEEP_EVERY_MS);
		// Neither keeps a pi that is otherwise done from exiting.
		first.unref();
		every.unref();
	});
	pi.on("session_shutdown", () => stopSweeps());
}

function stopSweeps(): void {
	if (first !== undefined) clearTimeout(first);
	if (every !== undefined) clearInterval(every);
	first = undefined;
	every = undefined;
}

/** One sweep, logged, which never throws into a timer. */
async function sweepOnce(pi: ExtensionAPI): Promise<void> {
	const dir = stateDir("work");
	const started = Date.now();
	let line: Record<string, unknown>;
	try {
		// A quest holds trees the broker knows nothing of, and says so
		// when asked, as it does for reclaim.
		const claims: TreeClaims = { paths: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);
		const outcome = await sweepEndedTrees({
			exec: unattendedExec(),
			memory: createTreeMemory(treeRecordDir()),
			claims: claims.paths,
			lockPath: join(dir, "sweep.lock"),
			wentWithFinishedWork: inFinishedQuest,
			providers: listTreeProviders,
		});
		line = said(outcome);
	} catch (error) {
		line = { failed: error instanceof Error ? error.message : String(error) };
	}
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "sweep.log"),
			`${JSON.stringify({
				at: new Date(started).toISOString(),
				pid: process.pid,
				ms: Date.now() - started,
				...line,
			})}\n`,
		);
	} catch {
		// The log is for reading afterwards; a sweep that can't write it
		// has still done what it did, and a timer has nobody to tell.
	}
}

/** The statuses a quest has once its work is done. */
const FINISHED = new Set(["concluded", "retired"]);

/**
 * Whether a git folder lay in the scratch folder of a quest that has
 * concluded or retired. Conclude takes the whole scratch folder, and a
 * clone in it goes too, leaving the trees cut from it with nothing.
 */
function inFinishedQuest(gitDir: string): boolean {
	const within = relative(questWorkspacesRoot(), gitDir);
	if (within.startsWith("..") || isAbsolute(within)) return false;
	const id = within.split(sep)[0];
	const { index } = discoverQuests(join(dataDir("quest-workflow"), "quests"));
	const status = index.quests.get(id)?.doc.frontMatter.status;
	return status !== undefined && FINISHED.has(status);
}

/** A sweep's outcome as its log line holds it. */
function said(outcome: SweepOutcome): Record<string, unknown> {
	if (outcome.skipped !== undefined) return { skipped: outcome.skipped };
	return {
		taken: outcome.taken,
		refused: outcome.refused,
		kept: outcome.kept.length,
	};
}
