/**
 * A quest tree of one quest and one plan, settled on disk, for the tests
 * that count what discovery reads of it and what it leaves for the next
 * process.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The one quest's id. */
export const ID = "QEST-20260604-AAA111";

/** The quest's README, at a status. */
export function readme(status: string): string {
	return [
		"---",
		`id: ${ID}`,
		"kind: quest",
		"parent: null",
		`status: ${status}`,
		"priority: active",
		"rank: 1",
		"started: 2026-06-04",
		"updated: 2026-06-04",
		"aliases: []",
		"sessions: []",
		"---",
		"",
		"# Alpha",
		"",
	].join("\n");
}

/** A plan under the quest. */
export function plan(title = "A Plan", id = "PLAN-20260604-BBB222"): string {
	return [
		"---",
		`id: ${id}`,
		"kind: plan",
		`quest: ${ID}`,
		"stage: think",
		"updated: 2026-06-04",
		"---",
		"",
		`# ${title}`,
		"",
	].join("\n");
}

/** Write a file and date it well before now, as a settled file would be. */
export function writeSettled(path: string, text: string): void {
	writeFileSync(path, text);
	settle(path);
}

/** Date a file or folder well before now, as a settled one would be. */
export function settle(path: string): void {
	const past = new Date(Date.now() - 60_000);
	utimesSync(path, past, past);
}

/** Where a tree's quests root, README and plan are. */
export interface SettledTree {
	readonly root: string;
	readonly readmePath: string;
	readonly planPath: string;
}

/** A fresh tree under the system's temporary folder, settled. */
export function settledTree(): SettledTree {
	const root = mkdtempSync(join(tmpdir(), "disc-reads-"));
	const dir = join(root, ID);
	mkdirSync(join(dir, "plans"), { recursive: true });
	const readmePath = join(dir, "README.md");
	const planPath = join(dir, "plans", "PLAN-20260604-BBB222.md");
	writeSettled(readmePath, readme("active"));
	writeSettled(planPath, plan());
	settle(dir);
	settle(root);
	return { root, readmePath, planPath };
}
