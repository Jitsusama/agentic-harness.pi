/**
 * One-shot migrator that moves every quest's Journey out of its
 * README into `attachments/journey.md`, leaving the README's section
 * as one pointer line (and, while the backup reads only the README
 * and documents, one comment line carrying what the Journey cites).
 *
 * It goes through the same planner the quest tool's sweep uses
 * (lib/internal/quest/journey-sweep.ts), one quest at a time under
 * that quest's lock, so a live session's writes interleave safely.
 *
 * Checked before it is trusted, per quest and in total:
 *
 * - every line it moves is in the Journey file afterwards, as many
 *   times as it was in the section;
 * - every dated entry readers found before, they find after, in the
 *   same order;
 * - the record audit calls no more attachments uncited than before,
 *   so the backup keeps all it kept.
 *
 * Dry run by default, printing what it would move and the README
 * bytes it would save. `--apply` first writes a tarball of the whole
 * quests folder (`--backup <file>`, by default beside the folder),
 * then migrates, then checks, exiting non-zero if any check fails.
 * `--root` points at a store other than the default. Idempotent: a
 * second run finds nothing to move.
 *
 *   node scripts/migrate-journey-file.ts [--apply] [--backup <file>]
 *     [--root <path>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { auditQuestRecord } from "@jitsusama/agentic-harness.core/quest/record-audit";
import { dataDir } from "../lib/internal/paths.ts";
import { isId, prefixOf } from "../lib/internal/quest/id.ts";
import {
	JOURNEY_POINTER,
	journeyBody,
	journeyEntriesFrom,
	journeyFilePath,
	questJourneyLines,
	readmeJourneySection,
} from "../lib/internal/quest/journey.ts";
import {
	CITATIONS_OPENING,
	listAttachments,
	planJourneySweep,
	sweepJourney,
} from "../lib/internal/quest/journey-sweep.ts";

/** What one quest's migration moved and what it checked. */
export interface QuestOutcome {
	quest: string;
	dir: string;
	movedLines: number;
	entries: number;
	readmeBytesBefore: number;
	readmeBytesAfter: number;
	problems: string[];
}

/** Every quest folder under a root, subquests included. */
export function questDirs(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (!isId(name) || prefixOf(name) !== "QEST") continue;
			const path = join(dir, name);
			if (!statSync(path).isDirectory()) continue;
			if (existsSync(join(path, "README.md"))) found.push(path);
			walk(path);
		}
	};
	walk(root);
	return found;
}

/** What migrating one quest would do, without writing. */
export function planQuest(dir: string): QuestOutcome {
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	const file = journeyFilePath(dir);
	const journey = existsSync(file) ? readFileSync(file, "utf8") : undefined;
	const plan = planJourneySweep(readme, {
		journey,
		citations: { quest: basename(dir), attachments: listAttachments(dir) },
	});
	return {
		quest: basename(dir),
		dir,
		movedLines: plan?.moved ?? 0,
		entries: journeyEntriesFrom(questJourneyLines(dir, readme)).length,
		readmeBytesBefore: Buffer.byteLength(readme),
		readmeBytesAfter: Buffer.byteLength(plan?.readme ?? readme),
		problems: [],
	};
}

/** Migrate one quest and check that nothing was lost. */
export function migrateQuest(dir: string): QuestOutcome {
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	const file = journeyFilePath(dir);
	const fileBefore = existsSync(file) ? readFileSync(file, "utf8") : "";
	const linesBefore = movableLines(readme);
	const entriesBefore = journeyEntriesFrom(questJourneyLines(dir, readme));
	const uncitedBefore = new Set(auditQuestRecord(dir).uncited);

	sweepJourney(dir);

	const readmeAfter = readFileSync(join(dir, "README.md"), "utf8");
	const fileAfter = readFileSync(file, "utf8");
	const problems: string[] = [];
	const remaining = countLines(journeyBody(fileAfter));
	for (const line of journeyBody(fileBefore)) take(remaining, line);
	for (const line of linesBefore) {
		if (!take(remaining, line))
			problems.push(`lost a line: ${line.slice(0, 80)}`);
	}
	const entriesAfter = journeyEntriesFrom(questJourneyLines(dir, readmeAfter));
	if (JSON.stringify(entriesAfter) !== JSON.stringify(entriesBefore)) {
		problems.push(
			`entries changed: ${entriesBefore.length} before, ${entriesAfter.length} after`,
		);
	}
	const newlyUncited = auditQuestRecord(dir).uncited.filter(
		(rel) => !uncitedBefore.has(rel),
	);
	if (newlyUncited.length > 0) {
		problems.push(`newly uncited: ${newlyUncited.slice(0, 5).join(", ")}`);
	}
	return {
		quest: basename(dir),
		dir,
		movedLines: linesBefore.length,
		entries: entriesAfter.length,
		readmeBytesBefore: Buffer.byteLength(readme),
		readmeBytesAfter: Buffer.byteLength(readmeAfter),
		problems,
	};
}

/** The non-blank lines of a README's Journey a sweep moves. */
function movableLines(readme: string): string[] {
	const section = readmeJourneySection(readme)?.lines ?? [];
	return section.filter(
		(l) =>
			l.trim() !== "" &&
			l.trim() !== JOURNEY_POINTER &&
			!l.startsWith(CITATIONS_OPENING),
	);
}

function countLines(lines: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
	return counts;
}

function take(counts: Map<string, number>, line: string): boolean {
	const n = counts.get(line) ?? 0;
	if (n === 0) return false;
	counts.set(line, n - 1);
	return true;
}

function summarise(outcomes: readonly QuestOutcome[]): string {
	const sum = (pick: (o: QuestOutcome) => number) =>
		outcomes.reduce((a, o) => a + pick(o), 0);
	const touched = outcomes.filter(
		(o) => o.movedLines > 0 || o.readmeBytesAfter !== o.readmeBytesBefore,
	);
	const biggest = [...outcomes]
		.sort(
			(a, b) =>
				b.readmeBytesBefore -
				b.readmeBytesAfter -
				(a.readmeBytesBefore - a.readmeBytesAfter),
		)
		.slice(0, 5)
		.map(
			(o) =>
				`  ${o.quest}: README ${o.readmeBytesBefore} -> ${o.readmeBytesAfter} bytes, ${o.entries} entries`,
		);
	return [
		`Quests: ${outcomes.length}, changed: ${touched.length}`,
		`Lines moved: ${sum((o) => o.movedLines)}; dated entries: ${sum((o) => o.entries)}`,
		`README bytes: ${sum((o) => o.readmeBytesBefore)} -> ${sum((o) => o.readmeBytesAfter)}`,
		"Most saved:",
		...biggest,
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
		console.log(summarise(dirs.map(planQuest)));
		console.log("\n(dry run: nothing moved)");
		return;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup =
		option("--backup") ??
		join(dirname(root), `quests-before-journey-${stamp}.tar.gz`);
	execFileSync("tar", ["-czf", backup, "-C", dirname(root), basename(root)]);
	console.log(`Backed up ${root} to ${backup}.`);
	const outcomes = dirs.map(migrateQuest);
	console.log(summarise(outcomes));
	const failed = outcomes.filter((o) => o.problems.length > 0);
	for (const o of failed) console.error(`${o.quest}: ${o.problems.join("; ")}`);
	if (failed.length > 0) {
		console.error(
			`\n${failed.length} quests failed a check; restore from ${backup}.`,
		);
		process.exit(1);
	}
	console.log("\nEvery check passed.");
}

// Only run when invoked directly, so tests can import the planner
// without migrating the live store.
if (import.meta.main) {
	main();
}
