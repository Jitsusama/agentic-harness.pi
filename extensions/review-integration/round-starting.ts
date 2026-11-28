/**
 * The roster rounds on a Mac that have taken their start but have yet
 * to leave the folder their reviewers run under, so the next start
 * counts them.
 *
 * A round takes its start, then reads its change again, rebuilds its
 * prompt and cuts its tree before its folder is made, which on a loaded
 * Mac took minutes. Read by its folders alone, such a round was seen by
 * neither the count nor the age, so a second start could pass beside it
 * on a reading it was about to spend (the #2454 council's four
 * mediums). So a Mac's round leaves a mark as its start is granted,
 * named for the moment it was taken, and the mark counts as a round
 * just started until a roster folder named at or after that moment
 * shows it, the round gives its start back, or
 * {@link MARK_HELD_FOR_MS} passes, past which a round with no folder has
 * died before its reviewers.
 *
 * A mark is written after the line grants the start, outside its lock,
 * so for those few milliseconds another look could miss it; the line
 * spaces a Mac's starts minutes apart (`MAC_SPACING_MS`), so no look
 * passes in them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rosterStartOf } from "../../lib/core/review/ask/start-spacing.ts";
import { type RunningRound, rosterRoundsRunning } from "./round-running.ts";

/**
 * How long a start's mark holds a Mac's starts with no folder to show
 * for it. A round's rebuild and tree cut took minutes on a loaded Mac,
 * so a quarter hour leaves room for the slowest; a round with no folder
 * after that has failed, and holds nothing longer.
 */
export const MARK_HELD_FOR_MS = 15 * 60_000;

/** The folder beside the transcripts' `runs` that marks are kept in. */
const MARKS = "starting";

/** How a mark is named: the start's moment in milliseconds, then its own id. */
const MARK = /^(\d+)-[0-9a-f-]+\.mark$/;

/** The runId a mark's round is shown under, since it has none yet. */
const TAKING_START = "a round taking its start";

/**
 * Leaves a mark under `stateDir` for a start taken at `at`, answering
 * what takes it away again, for a round that gives its start back.
 */
export async function markStart(
	stateDir: string,
	at: number = Date.now(),
): Promise<() => Promise<void>> {
	const folder = join(stateDir, MARKS);
	await mkdir(folder, { recursive: true });
	const mark = join(folder, `${at}-${randomUUID()}.mark`);
	await writeFile(mark, "", { flag: "wx" });
	return () => rm(mark, { force: true });
}

/**
 * The rounds under `stateDir` that took their start but have no roster
 * folder yet, newest first. Each folder named at or after a mark shows
 * the earliest mark before it, one each, so a round's folder never
 * shows two starts; marks past {@link MARK_HELD_FOR_MS} are dropped.
 */
export async function roundsTakingStart(
	stateDir: string,
	now: number = Date.now(),
): Promise<RunningRound[]> {
	const folder = join(stateDir, MARKS);
	const marks: number[] = [];
	for (const name of await entriesIn(folder)) {
		const at = Number(MARK.exec(name)?.[1] ?? Number.NaN);
		if (!Number.isFinite(at)) continue;
		if (now - at >= MARK_HELD_FOR_MS) {
			await rm(join(folder, name), { force: true });
			continue;
		}
		marks.push(at);
	}
	if (marks.length === 0) return [];
	marks.sort((a, b) => a - b);
	const folders = (await entriesIn(join(stateDir, "runs")))
		.map(rosterStartOf)
		.filter((at): at is number => at !== undefined && at >= (marks[0] ?? 0))
		.sort((a, b) => a - b);
	const shown = new Set<number>();
	for (const at of folders) {
		const index = marks.findIndex((mark, i) => !shown.has(i) && mark <= at);
		if (index !== -1) shown.add(index);
	}
	return marks
		.filter((_, i) => !shown.has(i))
		.reverse()
		.map((at) => ({
			runId: TAKING_START,
			reviewersRunning: 0,
			runningMs: Math.max(0, now - at),
		}));
}

/**
 * Every roster round under `stateDir` a Mac counts before it starts
 * another: those still taking their start, then those running.
 */
export async function roundsStartingOrRunning(
	stateDir: string,
): Promise<RunningRound[]> {
	const taking = await roundsTakingStart(stateDir);
	return [...taking, ...(await rosterRoundsRunning(stateDir))];
}

/** The names in `folder`, or none when it can't be read. */
async function entriesIn(folder: string): Promise<string[]> {
	try {
		return await readdir(folder);
	} catch {
		// No folder yet: no round has left a mark, or a transcript, here.
		return [];
	}
}
