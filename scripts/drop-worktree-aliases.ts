/**
 * One-shot migrator that drops every `git-worktree:<path>` alias a
 * quest's `trees:` already holds as a tree's path.
 *
 * The tree verbs mirrored each tree's path as an alias for a cwd walk
 * that now reads `trees` itself, as `locate` and `find` do, so the
 * aliases only repeat what the front matter says a few lines further
 * down, in the part of the README every reader loads first. An alias
 * naming a path no tree holds is kept: it is the only record of it.
 *
 * Each quest is rewritten through the shared front-matter mutation,
 * under that quest's lock, so a live session's writes interleave
 * safely, and without stamping `updated`, since nothing happened to
 * the quest.
 *
 * Dry run by default, printing the count per quest it would drop and
 * the total. `--apply` first writes a tarball of the whole quests
 * folder beside it, outside the quests root (`--backup <file>` to
 * choose), prints the one line that restores it, then drops. `--root`
 * points at a store other than the default. Idempotent: a second run
 * finds nothing to drop.
 *
 *   node scripts/drop-worktree-aliases.ts [--apply] [--backup <file>]
 *     [--root <path>]
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dataDir } from "../lib/internal/paths.ts";
import { parseQuestFrontMatter } from "../lib/internal/quest/frontmatter.ts";
import { mutateQuestFrontMatter } from "../lib/internal/quest/mutate.ts";
import type { QuestFrontMatter } from "../lib/quest/types.ts";
import { questDirs } from "./migrate-journey-file.ts";

/** The alias type that mirrored a tree's path. */
const TREE_ALIAS = "git-worktree";

/** What dropping one quest's mirrored aliases would do, or did. */
export interface QuestOutcome {
	quest: string;
	dir: string;
	/** Aliases repeating a tree's path: dropped, or to drop. */
	dropped: number;
	/** Worktree aliases naming a path no tree holds, kept. */
	kept: number;
	/** Why the quest could not be read or written, if it could not. */
	problem?: string;
}

/** The front matter with every alias repeating a tree's path removed. */
export function withoutMirroredAliases(fm: QuestFrontMatter): {
	next: QuestFrontMatter;
	dropped: number;
	kept: number;
} {
	const paths = new Set((fm.trees ?? []).map((tree) => tree.path));
	const mirrors = (alias: { type: string; value: string }) =>
		alias.type === TREE_ALIAS && paths.has(alias.value);
	const aliases = fm.aliases.filter((alias) => !mirrors(alias));
	return {
		next: { ...fm, aliases },
		dropped: fm.aliases.length - aliases.length,
		kept: aliases.filter((alias) => alias.type === TREE_ALIAS).length,
	};
}

/** What dropping one quest's mirrored aliases would do, without writing. */
export function planQuest(dir: string): QuestOutcome {
	const quest = basename(dir);
	const parsed = parseQuestFrontMatter(
		readFileSync(join(dir, "README.md"), "utf8"),
	);
	if (!parsed) {
		return { quest, dir, dropped: 0, kept: 0, problem: "unreadable" };
	}
	const { dropped, kept } = withoutMirroredAliases(parsed.frontMatter);
	return { quest, dir, dropped, kept };
}

/** Drop one quest's mirrored aliases, under its lock. */
export function dropQuest(dir: string): QuestOutcome {
	let dropped = 0;
	let kept = 0;
	const outcome = mutateQuestFrontMatter(
		dir,
		(fm) => {
			const result = withoutMirroredAliases(fm);
			dropped = result.dropped;
			kept = result.kept;
			return result.dropped === 0 ? undefined : result.next;
		},
		{ op: "drop-worktree-aliases", stampUpdated: false },
	);
	const quest = basename(dir);
	return outcome.ok
		? { quest, dir, dropped, kept }
		: { quest, dir, dropped: 0, kept, problem: outcome.guidance };
}

function report(outcomes: readonly QuestOutcome[], verb: string): string {
	const changed = outcomes.filter((o) => o.dropped > 0);
	const sum = (pick: (o: QuestOutcome) => number) =>
		outcomes.reduce((total, o) => total + pick(o), 0);
	return [
		...changed.map((o) => `  ${o.quest}: ${o.dropped}`),
		`${verb} ${sum((o) => o.dropped)} aliases from ${changed.length} of ${outcomes.length} quests; kept ${sum((o) => o.kept)} naming a path no tree holds.`,
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
		console.log(report(dirs.map(planQuest), "Would drop"));
		console.log("\n(dry run: nothing written)");
		return;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup =
		option("--backup") ??
		join(dirname(root), `quests-before-worktree-aliases-${stamp}.tar.gz`);
	execFileSync("tar", ["-czf", backup, "-C", dirname(root), basename(root)]);
	console.log(`Backed up ${root} to ${backup}.`);
	console.log(`Restore with: tar -xzf ${backup} -C ${dirname(root)}`);
	const outcomes = dirs.map(dropQuest);
	console.log(report(outcomes, "Dropped"));
	const failed = outcomes.filter((o) => o.problem);
	for (const o of failed) console.error(`${o.quest}: ${o.problem}`);
	if (failed.length > 0) process.exit(1);
}

// Only run when invoked directly, so tests can import the planner
// without touching the live store.
if (import.meta.main) {
	main();
}
