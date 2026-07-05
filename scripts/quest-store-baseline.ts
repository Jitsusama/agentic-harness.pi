/**
 * Read-only baseline analyzer for the quests store.
 *
 * The rework (PLAN-20260704-Y1KP37) migrates the store forward
 * in later phases: it resets live priorities on sealed quests,
 * renumbers colliding ranks, seals documents orphaned under
 * sealed quests, and canonicalizes aliases. Those migrations
 * need a before-picture to verify against. This script is that
 * picture: it reads every quest's raw front-matter (not the
 * strict parser, which hides drift by yielding `undefined`),
 * classifies each field against the canonical vocabulary, and
 * reports the drift counts.
 *
 * It never writes. Run it before a migration to capture the
 * baseline and after to confirm the drift went to zero.
 *
 *   pnpm tsx scripts/quest-store-baseline.ts [--root <path>] [--json]
 *
 * The pure `computeBaseline` operates on parsed records so it
 * is unit-testable; `loadRecords` does the disk read.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { dataDir } from "../lib/internal/paths.js";
import { splitFrontMatter } from "../lib/internal/quest/frontmatter.js";

// Canonical vocabularies. These mirror the strict sets in
// lib/internal/quest/frontmatter.ts; the parser keeps them
// module-private, so the analyzer restates them to measure
// how far the store has drifted from them.
const QUEST_STATUSES = ["active", "paused", "blocked", "concluded", "retired"];
const LIVE_PRIORITIES = ["driving", "active"];
const SEALED_STATUSES = ["concluded", "retired"];
const DOCUMENT_STAGES = ["think", "draft", "build", "concluded", "retired"];
const ACTIVE_DOC_STAGES = ["think", "draft", "build"];
const DOC_KIND_DIRS = ["plans", "research", "briefs", "reports"];

interface DocRecord {
	id: string;
	stage?: string;
}

export interface QuestRecord {
	id: string;
	status?: string;
	priority?: string;
	rank?: number;
	parent?: string;
	kind?: string;
	aliases: { type: string; value: string }[];
	documents: DocRecord[];
}

export interface Baseline {
	quests: number;
	statusCounts: Record<string, number>;
	outOfVocabStatus: number;
	livePriorityOnSealed: number;
	rankMissing: number;
	rankZero: number;
	rankCollisions: number;
	childrenUnderSealedParent: number;
	liveChildrenUnderSealedParent: number;
	documents: number;
	docStageCounts: Record<string, number>;
	outOfVocabDocStage: number;
	unsealedDocsUnderSealedQuest: number;
	aliasTotal: number;
	aliasByType: Record<string, number>;
	slackMessageAliases: number;
	collidingAliasKeys: number;
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function isSealed(status: string | undefined): boolean {
	return status !== undefined && SEALED_STATUSES.includes(status);
}

/** Reduce a set of parsed quest records to the drift baseline. */
export function computeBaseline(records: QuestRecord[]): Baseline {
	const statusById = new Map<string, string | undefined>();
	for (const q of records) statusById.set(q.id, q.status);

	const base: Baseline = {
		quests: records.length,
		statusCounts: {},
		outOfVocabStatus: 0,
		livePriorityOnSealed: 0,
		rankMissing: 0,
		rankZero: 0,
		rankCollisions: 0,
		childrenUnderSealedParent: 0,
		liveChildrenUnderSealedParent: 0,
		documents: 0,
		docStageCounts: {},
		outOfVocabDocStage: 0,
		unsealedDocsUnderSealedQuest: 0,
		aliasTotal: 0,
		aliasByType: {},
		slackMessageAliases: 0,
		collidingAliasKeys: 0,
	};

	const rankGroups = new Map<string, number>();
	const aliasKeyOwners = new Map<string, Set<string>>();

	for (const q of records) {
		bump(base.statusCounts, q.status ?? "(missing)");
		if (q.status === undefined || !QUEST_STATUSES.includes(q.status)) {
			base.outOfVocabStatus++;
		}
		if (
			isSealed(q.status) &&
			q.priority &&
			LIVE_PRIORITIES.includes(q.priority)
		) {
			base.livePriorityOnSealed++;
		}

		if (q.rank === undefined) base.rankMissing++;
		else if (q.rank === 0) base.rankZero++;
		const parentKey = q.parent ?? "(root)";
		const rankKey = `${parentKey}#${q.rank ?? "none"}`;
		rankGroups.set(rankKey, (rankGroups.get(rankKey) ?? 0) + 1);

		if (q.parent) {
			const parentStatus = statusById.get(q.parent);
			if (isSealed(parentStatus)) {
				base.childrenUnderSealedParent++;
				if (!isSealed(q.status)) base.liveChildrenUnderSealedParent++;
			}
		}

		for (const doc of q.documents) {
			base.documents++;
			bump(base.docStageCounts, doc.stage ?? "(missing)");
			if (doc.stage === undefined || !DOCUMENT_STAGES.includes(doc.stage)) {
				base.outOfVocabDocStage++;
			}
			if (
				isSealed(q.status) &&
				doc.stage &&
				ACTIVE_DOC_STAGES.includes(doc.stage)
			) {
				base.unsealedDocsUnderSealedQuest++;
			}
		}

		for (const alias of q.aliases) {
			base.aliasTotal++;
			bump(base.aliasByType, alias.type);
			if (alias.type === "slack-message") base.slackMessageAliases++;
			const key = `${alias.type}:${alias.value}`;
			const owners = aliasKeyOwners.get(key) ?? new Set<string>();
			owners.add(q.id);
			aliasKeyOwners.set(key, owners);
		}
	}

	for (const count of rankGroups.values()) {
		if (count > 1) base.rankCollisions += count;
	}
	for (const owners of aliasKeyOwners.values()) {
		if (owners.size > 1) base.collidingAliasKeys++;
	}

	return base;
}

function parseAliases(raw: unknown): { type: string; value: string }[] {
	if (!Array.isArray(raw)) return [];
	const out: { type: string; value: string }[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			const colon = entry.indexOf(":");
			if (colon > 0) {
				out.push({
					type: entry.slice(0, colon).trim(),
					value: entry.slice(colon + 1).trim(),
				});
			}
			continue;
		}
		if (entry && typeof entry === "object") {
			const obj = entry as Record<string, unknown>;
			if (typeof obj.type === "string" && typeof obj.value === "string") {
				out.push({ type: obj.type, value: obj.value });
			}
		}
	}
	return out;
}

function rawFrontMatter(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	const split = splitFrontMatter(readFileSync(path, "utf8"));
	if (!split) return undefined;
	try {
		const raw = parseYaml(split.fmText) ?? {};
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return raw as Record<string, unknown>;
		}
	} catch {
		// A malformed YAML block is itself drift; report the quest
		// with no fields rather than aborting the whole scan.
	}
	return undefined;
}

function loadDocuments(questDir: string): DocRecord[] {
	const docs: DocRecord[] = [];
	for (const kindDir of DOC_KIND_DIRS) {
		const dir = join(questDir, kindDir);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const fm = rawFrontMatter(join(dir, entry.name));
			const stage = fm?.stage;
			docs.push({
				id: entry.name.replace(/\.md$/, ""),
				stage: typeof stage === "string" ? stage : undefined,
			});
		}
	}
	return docs;
}

/** Read every quest README under the root into parsed records. */
export function loadRecords(root: string): QuestRecord[] {
	const records: QuestRecord[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("QEST-")) continue;
		const questDir = join(root, entry.name);
		const fm = rawFrontMatter(join(questDir, "README.md")) ?? {};
		records.push({
			id: typeof fm.id === "string" ? fm.id : entry.name,
			status: typeof fm.status === "string" ? fm.status : undefined,
			priority: typeof fm.priority === "string" ? fm.priority : undefined,
			rank: typeof fm.rank === "number" ? fm.rank : undefined,
			parent: typeof fm.parent === "string" ? fm.parent : undefined,
			kind: typeof fm.kind === "string" ? fm.kind : undefined,
			aliases: parseAliases(fm.aliases),
			documents: loadDocuments(questDir),
		});
	}
	return records;
}

function report(base: Baseline): string {
	const pct = (n: number) => `${((n / base.quests) * 100).toFixed(1)}%`;
	return [
		`Quests scanned:                 ${base.quests}`,
		"",
		"Status integrity",
		`  out-of-vocabulary status:     ${base.outOfVocabStatus}`,
		`  live priority on sealed:      ${base.livePriorityOnSealed} (${pct(base.livePriorityOnSealed)})`,
		`  children under sealed parent: ${base.childrenUnderSealedParent}`,
		`    of which still live:        ${base.liveChildrenUnderSealedParent}`,
		"",
		"Rank integrity",
		`  rank missing:                 ${base.rankMissing}`,
		`  rank == 0:                    ${base.rankZero}`,
		`  in a colliding rank group:    ${base.rankCollisions} (${pct(base.rankCollisions)})`,
		"",
		"Documents",
		`  total documents:              ${base.documents}`,
		`  out-of-vocabulary stage:      ${base.outOfVocabDocStage}`,
		`  unsealed under sealed quest:  ${base.unsealedDocsUnderSealedQuest}`,
		"",
		"Aliases",
		`  total alias entries:          ${base.aliasTotal}`,
		`  slack-message aliases:        ${base.slackMessageAliases}`,
		`  colliding alias keys:         ${base.collidingAliasKeys}`,
		"",
		`Status distribution:            ${JSON.stringify(base.statusCounts)}`,
		`Document stage distribution:    ${JSON.stringify(base.docStageCounts)}`,
	].join("\n");
}

function main(): void {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf("--root");
	const root =
		rootIndex >= 0
			? (args[rootIndex + 1] ?? "")
			: join(dataDir("quest-workflow"), "quests");
	if (!root || !existsSync(root)) {
		console.error(`questsRoot does not exist: ${root}`);
		process.exit(1);
	}
	const base = computeBaseline(loadRecords(root));
	if (args.includes("--json")) {
		console.log(JSON.stringify(base, null, 2));
		return;
	}
	console.log(report(base));
}

// Only run when invoked directly, so tests can import the pure
// helpers without scanning the live store.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
