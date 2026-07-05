/**
 * One-shot migrator that reconciles the status-integrity drift the
 * Phase 0 baseline measured (see scripts/quest-store-baseline.ts):
 *
 * 1. Sealed quests that still carry a live priority (driving or
 *    active) are reset to someday, so a concluded quest stops
 *    sorting and reading as live.
 * 2. Colliding and zero ranks are renumbered: each (parent,
 *    priority) sibling group is renumbered to a contiguous 1..N in
 *    its current order, so no two siblings share a rank.
 * 3. Documents left at an active stage under a sealed quest are
 *    sealed to the quest's terminal stage, so a concluded quest
 *    leaves no document stranded mid-stage.
 *
 * The going-forward writers already prevent all three (the seal
 * cascade, nextRank on create and move). This migrator brings the
 * existing store into line.
 *
 * Idempotent. Dry-run by default: it prints the plan and touches
 * nothing. Pass --apply to write. Pass --root <path> to target a
 * store other than the default.
 *
 *   pnpm tsx scripts/migrate-quests-status-integrity.ts [--apply] [--root <path>]
 *
 * The plan* functions are pure over an in-memory shape so they are
 * unit-testable; scan and apply* touch the disk.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../lib/internal/paths.js";
import {
	parseDocumentFrontMatter,
	parseQuestFrontMatter,
	serializeDocumentFrontMatter,
	serializeQuestFrontMatter,
} from "../lib/internal/quest/frontmatter.js";
import { atomicWriteFile } from "../lib/internal/quest/io.js";

const LIVE_PRIORITIES = new Set(["driving", "active"]);
const SEALED_STATUSES = new Set(["concluded", "retired"]);
const ACTIVE_DOC_STAGES = new Set(["think", "draft", "build"]);
const DOC_KIND_DIRS = ["plans", "research", "briefs", "reports"];

interface DocEntry {
	path: string;
	stage?: string;
}

export interface QuestEntry {
	id: string;
	dir: string;
	status?: string;
	priority?: string;
	rank: number;
	parent: string | null;
	documents: DocEntry[];
}

export interface PriorityReset {
	id: string;
	from: string;
	to: string;
}

export interface RankChange {
	id: string;
	from: number;
	to: number;
}

export interface DocSeal {
	path: string;
	from: string;
	to: string;
}

function isSealed(status: string | undefined): boolean {
	return status !== undefined && SEALED_STATUSES.has(status);
}

function terminalStage(status: string | undefined): "concluded" | "retired" {
	return status === "retired" ? "retired" : "concluded";
}

/** Sealed quests carrying a live priority, reset to someday. */
export function planPriorityResets(quests: QuestEntry[]): PriorityReset[] {
	const plan: PriorityReset[] = [];
	for (const q of quests) {
		if (!isSealed(q.status)) continue;
		if (q.priority && LIVE_PRIORITIES.has(q.priority)) {
			plan.push({ id: q.id, from: q.priority, to: "someday" });
		}
	}
	return plan;
}

/**
 * Renumber each (parent, priority) sibling group to a contiguous
 * 1..N in current rank order (id breaks ties), emitting only the
 * quests whose rank actually moves.
 */
export function planRankRenumber(quests: QuestEntry[]): RankChange[] {
	const groups = new Map<string, QuestEntry[]>();
	for (const q of quests) {
		const key = `${q.parent ?? "(root)"}\u0000${q.priority ?? "(none)"}`;
		const group = groups.get(key) ?? [];
		group.push(q);
		groups.set(key, group);
	}
	const changes: RankChange[] = [];
	for (const group of groups.values()) {
		const ordered = [...group].sort((a, b) => {
			if (a.rank !== b.rank) return a.rank - b.rank;
			return a.id.localeCompare(b.id);
		});
		ordered.forEach((q, i) => {
			const to = i + 1;
			if (q.rank !== to) changes.push({ id: q.id, from: q.rank, to });
		});
	}
	return changes;
}

/** Active-stage documents under a sealed quest, sealed to the quest's terminal stage. */
export function planDocumentSeals(quests: QuestEntry[]): DocSeal[] {
	const plan: DocSeal[] = [];
	for (const q of quests) {
		if (!isSealed(q.status)) continue;
		const target = terminalStage(q.status);
		for (const doc of q.documents) {
			if (doc.stage && ACTIVE_DOC_STAGES.has(doc.stage)) {
				plan.push({ path: doc.path, from: doc.stage, to: target });
			}
		}
	}
	return plan;
}

function readDocuments(questDir: string): DocEntry[] {
	const docs: DocEntry[] = [];
	for (const kindDir of DOC_KIND_DIRS) {
		const dir = join(questDir, kindDir);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const path = join(dir, entry.name);
			const parsed = parseDocumentFrontMatter(readFileSync(path, "utf8"));
			docs.push({ path, stage: parsed?.frontMatter.stage });
		}
	}
	return docs;
}

/** Read every quest under the root into the migrator's shape. */
export function scan(root: string): QuestEntry[] {
	const quests: QuestEntry[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("QEST-")) continue;
		const dir = join(root, entry.name);
		const readme = join(dir, "README.md");
		if (!existsSync(readme)) continue;
		const parsed = parseQuestFrontMatter(readFileSync(readme, "utf8"));
		if (!parsed) continue;
		const fm = parsed.frontMatter;
		quests.push({
			id: fm.id,
			dir,
			status: fm.status,
			priority: fm.priority,
			rank: fm.rank,
			parent: fm.parent ?? null,
			documents: readDocuments(dir),
		});
	}
	return quests;
}

function rewriteQuest(
	dir: string,
	mutate: (
		fm: NonNullable<ReturnType<typeof parseQuestFrontMatter>>["frontMatter"],
	) => void,
): void {
	const path = join(dir, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) return;
	mutate(parsed.frontMatter);
	atomicWriteFile(
		path,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}

/** Apply the priority resets to disk. */
export function applyPriorityResets(root: string, plan: PriorityReset[]): void {
	for (const reset of plan) {
		rewriteQuest(join(root, reset.id), (fm) => {
			fm.priority = "someday";
		});
	}
}

/** Apply the rank renumbering to disk. */
export function applyRankRenumber(root: string, plan: RankChange[]): void {
	for (const change of plan) {
		rewriteQuest(join(root, change.id), (fm) => {
			fm.rank = change.to;
		});
	}
}

/** Apply the document seals to disk. */
export function applyDocumentSeals(plan: DocSeal[]): void {
	for (const seal of plan) {
		const parsed = parseDocumentFrontMatter(readFileSync(seal.path, "utf8"));
		if (!parsed) continue;
		parsed.frontMatter.stage = seal.to as typeof parsed.frontMatter.stage;
		atomicWriteFile(
			seal.path,
			`${serializeDocumentFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
		);
	}
}

function report(
	priorities: PriorityReset[],
	ranks: RankChange[],
	docs: DocSeal[],
): string {
	return [
		`Priority resets (sealed with a live priority): ${priorities.length}`,
		`Rank renumberings (colliding or zero ranks):   ${ranks.length}`,
		`Document seals (active under a sealed quest):   ${docs.length}`,
	].join("\n");
}

function main(): void {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const rootIndex = args.indexOf("--root");
	const root =
		rootIndex >= 0
			? (args[rootIndex + 1] ?? "")
			: join(dataDir("quest-workflow"), "quests");
	if (!root || !existsSync(root)) {
		console.error(`questsRoot does not exist: ${root}`);
		process.exit(1);
	}

	const quests = scan(root);
	const priorities = planPriorityResets(quests);
	const ranks = planRankRenumber(quests);
	const docs = planDocumentSeals(quests);
	console.log(report(priorities, ranks, docs));

	if (!apply) {
		console.log("\n(dry run: no changes applied; pass --apply to write)");
		return;
	}
	applyPriorityResets(root, priorities);
	applyRankRenumber(root, ranks);
	applyDocumentSeals(docs);
	console.log("\nApplied.");
}

// Only run when invoked directly, so tests can import the pure
// planners without scanning or mutating the live store.
if (require.main === module) {
	main();
}
