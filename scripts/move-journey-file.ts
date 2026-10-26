/**
 * One-shot migrator that moves each quest's Journey from
 * `attachments/journey.md` up to `JOURNEY.md`, beside the README, and
 * points the README's Journey section at the new place.
 *
 * The Journey sat under `attachments/` only because the record and
 * the backup kept nothing else at a quest's top. Both now keep
 * `JOURNEY.md`, so it moves up, where a reader looks for it and where
 * the links its entries carry, written relative to the README they
 * first sat in, resolve again.
 *
 * Each quest moves through the Journey sweep, under its lock, so a
 * live session's writes interleave safely: a Journey file at the old
 * place is folded in at the head, the new file is written, and only
 * then is the old one removed. A session on older code that writes
 * the old file after the move is folded in by the next sweep.
 *
 * Dry run by default, printing each quest it would move with its
 * size, and the total. `--apply` first writes a tarball of the whole
 * quests folder beside it, outside the quests root (`--backup <file>`
 * to choose), prints the one line that restores it, then moves.
 * `--root` points at a store other than the default. Idempotent: a
 * second run finds nothing to move.
 *
 * Run it only once the backup keeps `JOURNEY.md`, or a backup taken
 * in between misses every Journey.
 *
 *   node scripts/move-journey-file.ts [--apply] [--backup <file>]
 *     [--root <path>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dataDir } from "../lib/internal/paths.ts";
import { withQuestLock } from "../lib/internal/quest/io.ts";
import { formerJourneyFilePath } from "../lib/internal/quest/journey.ts";
import { sweepJourneyUnlocked } from "../lib/internal/quest/journey-sweep.ts";
import { questDirs } from "./migrate-journey-file.ts";

/** What moving one quest's Journey would do, or did. */
export interface QuestOutcome {
	quest: string;
	dir: string;
	/** The old file's size in bytes, zero when there was none. */
	bytes: number;
	/** Why the quest could not be moved, if it could not. */
	problem?: string;
}

/** What moving one quest's Journey would do, without writing. */
export function planQuest(dir: string): QuestOutcome {
	const former = formerJourneyFilePath(dir);
	const bytes = existsSync(former) ? statSync(former).size : 0;
	return { quest: basename(dir), dir, bytes };
}

/** Move one quest's Journey up beside its README, under its lock. */
export function moveQuest(dir: string): QuestOutcome {
	const planned = planQuest(dir);
	if (!existsSync(formerJourneyFilePath(dir))) return planned;
	try {
		const moved = withQuestLock(dir, () => sweepJourneyUnlocked(dir));
		return moved === undefined ? { ...planned, problem: "no README" } : planned;
	} catch (error) {
		return {
			...planned,
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

function report(outcomes: readonly QuestOutcome[], verb: string): string {
	const moving = outcomes.filter((o) => o.bytes > 0);
	const bytes = moving.reduce((total, o) => total + o.bytes, 0);
	return [
		...moving.map((o) => `  ${o.quest}: ${o.bytes} bytes`),
		`${verb} ${moving.length} of ${outcomes.length} quests' Journeys, ${bytes} bytes.`,
	].join("\n");
}

function main(): void {
	const args = process.argv.slice(2);
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const root = option("--root") ?? join(dataDir("quest-workflow"), "quests");
	const dirs = questDirs(root);
	if (!args.includes("--apply")) {
		console.log(report(dirs.map(planQuest), "Would move"));
		console.log("\n(dry run: nothing written)");
		return;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup =
		option("--backup") ??
		join(dirname(root), `quests-before-journey-move-${stamp}.tar.gz`);
	execFileSync("tar", ["-czf", backup, "-C", dirname(root), basename(root)]);
	console.log(`Backed up ${root} to ${backup}.`);
	console.log(`Restore with: tar -xzf ${backup} -C ${dirname(root)}`);
	const outcomes = dirs.map(moveQuest);
	console.log(report(outcomes, "Moved"));
	const failed = outcomes.filter((o) => o.problem);
	for (const o of failed) console.error(`${o.quest}: ${o.problem}`);
	if (failed.length > 0) process.exit(1);
}

// Only run when invoked directly, so tests can import the planner
// without touching the live store.
if (import.meta.main) {
	main();
}
