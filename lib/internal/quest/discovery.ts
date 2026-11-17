/**
 * Quest discovery: walk a quest tree on disk and build an
 * in-memory index.
 *
 * Canonical disk layout (within `questsRoot`):
 *
 *     QEST-20260603-AAA111/
 *       README.md
 *       plans/PLAN-20260603-BBB222.md
 *       research/RSCH-20260605-CCC333.md
 *       briefs/BRIF-20260606-EEE555.md
 *       reports/RPRT-20260607-FFF666.md
 *     QEST-20260610-DDD444/           (subquest of AAA111,
 *       README.md                       parent: QEST-...-AAA111
 *                                       lives flat at the
 *                                       quests root, not
 *                                       nested in its
 *                                       parent's directory)
 *
 * All quests live as immediate children of `questsRoot`.
 * Hierarchy is expressed by the `parent:` front-matter
 * field on each quest's README, not by directory nesting.
 * Documents (plans, research, briefs, reports) live inside
 * their owning quest's kind subdirectory (`plans/`,
 * `research/`, `briefs/`, `reports/`).
 *
 * Discovery enforces these invariants. Two drift patterns
 * are surfaced as `DiscoveryError` and the offending entry
 * is skipped:
 *
 * - a `QEST-*` directory found inside another quest
 * - a `PLAN-/RSCH-/BRIF-/RPRT-*.md` file at a quest's root
 *   instead of in its kind subdirectory
 *
 * Free-form subdirectories under a quest (`runs/`,
 * `tools/`, `workloads/`, etc.) are not walked. They're
 * surfaced only via the quest's own body references.
 *
 * What the walk reads, and the memo that spares it reading
 * an unchanged file twice, are in `discovery-reads.ts`; the
 * seed that carries the memo to the next process is in
 * `discovery-seed.ts`.
 */

import { realpathSync } from "node:fs";
import { extname, join } from "node:path";
import type { QuestDoc, QuestDocumentDoc } from "../../quest/types.ts";
import { cacheDir } from "../paths.ts";
import {
	CANONICAL_DOCUMENT_DIRS,
	discoverySignature,
	forgetMemo,
	forgetUnparsed,
	kept,
	kindEntries,
	memo,
	newPass,
	type Pass,
	parsedOnce,
	readEntries,
} from "./discovery-reads.ts";
import {
	codeKey,
	leaveSeed,
	SEED_AFTER_PARSES,
	SEED_FOLDER,
	type SeedOptions,
	takeSeed,
} from "./discovery-seed.ts";
import {
	explainDocumentFrontMatter,
	parseDocumentFrontMatter,
} from "./frontmatter.ts";
import { isId, prefixOf } from "./id.ts";
import { questWritesMade } from "./io.ts";
import { extractTitle, parseQuestDoc } from "./quest-doc.ts";

/**
 * Maximum directory depth the walk follows. A quest tree
 * with depth past this is almost certainly a symlink loop
 * or accidental nesting; we stop and log an error rather
 * than wedge every quest action.
 */
const MAX_WALK_DEPTH = 16;

/** A single quest entry in the index. */
export interface QuestEntry {
	dir: string;
	doc: QuestDoc;
	/** Documents inside this quest's directory (not its subquests). */
	documents: QuestDocumentEntry[];
}

/** A document (plan/research/brief/report) under a quest. */
export interface QuestDocumentEntry {
	path: string;
	doc: QuestDocumentDoc;
}

/** The whole tree. */
export interface QuestIndex {
	/** Every discovered quest by id. */
	quests: Map<string, QuestEntry>;
	/**
	 * Parent-to-children adjacency. The empty key `""`
	 * holds top-level quests (those whose `parent` is
	 * null).
	 */
	children: Map<string, string[]>;
}

/**
 * The ranks of every quest sharing a parent and priority bucket (a
 * sibling set), optionally excluding one id. Callers pair this with
 * `nextRank` to place a new or moved quest at the next free rank in
 * its group rather than colliding at rank 1.
 */
export function siblingRanks(
	index: QuestIndex,
	parent: string | null,
	priority: string,
	excludeId?: string,
): number[] {
	const ranks: number[] = [];
	for (const entry of index.quests.values()) {
		const fm = entry.doc.frontMatter;
		if (fm.id === excludeId) continue;
		if ((fm.parent ?? null) !== parent) continue;
		if (fm.priority !== priority) continue;
		ranks.push(fm.rank);
	}
	return ranks;
}

interface DiscoveryError {
	path: string;
	message: string;
}

/** Result of a discovery walk. */
export interface DiscoveryResult {
	index: QuestIndex;
	errors: DiscoveryError[];
}

function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		// Path doesn't exist or is unreadable; the caller
		// will surface the read error separately.
		return undefined;
	}
}

function parseDocumentFile(text: string): QuestDocumentDoc | undefined {
	const parsed = parseDocumentFrontMatter(text);
	if (!parsed) return undefined;
	return {
		frontMatter: parsed.frontMatter,
		body: parsed.body,
		title: extractTitle(parsed.body),
	};
}

/**
 * Drop the discovery memo. Tests call this between runs; write
 * paths do not need it because the signature catches their
 * changes on the next read. A reload must call it, since the
 * memo outlives the code that built it: the next code may shape
 * an index differently, and must not be handed the old one.
 */
export function clearDiscoveryCache(): void {
	forgetMemo();
	held?.clear();
}

/** What a held discovery found for a root, and the writes made by then. */
interface HeldSlot {
	readonly writes: number;
	readonly result: DiscoveryResult;
}

/** The roots a hold has walked, while one is open; none outside it. */
let held: Map<string, HeldSlot> | undefined;

/**
 * Run `fn` with the quest tree read as it stood at its first walk, plus
 * this process's own writes, so every discovery inside it after the
 * first costs nothing.
 *
 * A session's start asks discovery six times or more, and each ask
 * signs the whole tree again, a stat a file and a listing a folder:
 * about 40 ms each over some 800 quests, 0.24 s of a parked wake on 14
 * November, every wake. Inside a hold an ask after the first is
 * answered from that walk, unless the process wrote a quest since,
 * which signs the tree again. `fn` runs to its end before anything
 * else on the loop, so the hold covers its synchronous part only; what
 * it starts that awaits asks afresh, as do another process's writes
 * at the next ask outside a hold. A hold inside a hold is the outer one.
 */
export function withDiscoveryHeld<T>(fn: () => T): T {
	if (held) return fn();
	held = new Map();
	try {
		return fn();
	} finally {
		held = undefined;
	}
}

/**
 * Walk `questsRoot` and build the index, memoized per root. The
 * walk re-parses every README and document, which is the costly
 * part; this caches the result behind a cheap mtime-and-size
 * signature so repeated read verbs in a session do not re-parse
 * an unchanged tree. The signature recomputes on every call (a
 * directory traversal plus stats, no file reads), so any change
 * to a README, a document, or the set of quests invalidates the
 * cache on the next read.
 */
export function discoverQuests(
	questsRoot: string,
	seed: SeedOptions = {},
): DiscoveryResult {
	const kept = held?.get(questsRoot);
	if (kept && kept.writes === questWritesMade()) return kept.result;
	const result = discoverQuestsSigned(questsRoot, seed);
	// Counted after the walk, whose seed for the next process isn't a quest.
	held?.set(questsRoot, { writes: questWritesMade(), result });
	return result;
}

/** discoverQuests's walk, behind the tree's signature. */
function discoverQuestsSigned(
	questsRoot: string,
	seed: SeedOptions,
): DiscoveryResult {
	const pass = newPass();
	const seeds = seed.dir === undefined ? cacheDir(SEED_FOLDER) : seed.dir;
	const code = seeds ? (seed.code ?? codeKey()) : "";
	if (seeds) takeSeed(questsRoot, seeds, code);
	const signature = discoverySignature(questsRoot, pass);
	const { cache } = memo();
	const cached = cache.get(questsRoot);
	if (cached && cached.signature === signature) return cached.result;
	const result = discoverQuestsUncached(questsRoot, pass);
	cache.set(questsRoot, { signature, result });
	if (seeds && pass.parses >= (seed.after ?? SEED_AFTER_PARSES)) {
		leaveSeed(questsRoot, seeds, code);
	}
	return result;
}

function discoverQuestsUncached(
	questsRoot: string,
	pass: Pass,
): DiscoveryResult {
	const result = walkQuests(questsRoot, pass);
	forgetUnparsed(pass);
	return result;
}

/**
 * Walk `questsRoot` and build the index. Read errors are
 * collected into `errors`; they do not stop discovery.
 *
 * Safety against pathological trees:
 *
 * - We use `withFileTypes` so the directory check comes
 *   from the entry, never from a `stat` call that would
 *   follow symlinks.
 * - We refuse symlinks outright: a real quest tree is
 *   plain directories. This keeps the walk from leaving
 *   `questsRoot` via someone's stray symlink.
 * - We track real paths we have entered and skip any we
 *   already visited so a hard-link cycle terminates.
 * - We cap recursion depth at `MAX_WALK_DEPTH` and surface
 *   the truncation as an error rather than spinning.
 */
function walkQuests(questsRoot: string, pass: Pass): DiscoveryResult {
	const { readmes, documents: documentRecords } = memo();
	const quests = new Map<string, QuestEntry>();
	const children = new Map<string, string[]>();
	const errors: DiscoveryError[] = [];
	const visited = new Set<string>();

	function scanDocuments(questDir: string): QuestDocumentEntry[] {
		const documents: QuestDocumentEntry[] = [];

		// Surface any doc-id-named file at the quest-dir root
		// as a layout error: the canonical home for those is a
		// kind subdirectory. We still skip the entry rather
		// than parse it, so a stray misplaced file does not
		// double-register.
		const questEntries = readEntries(questDir, pass);
		if (questEntries) {
			for (const entry of questEntries) {
				if (!entry.isFile()) continue;
				if (extname(entry.name) !== ".md") continue;
				const base = entry.name.slice(0, -3);
				if (!isId(base) || prefixOf(base) === "QEST") continue;
				errors.push({
					path: join(questDir, entry.name),
					message: `Document "${entry.name}" sits at the quest-dir root instead of in its kind subdirectory.`,
				});
			}
		}

		for (const subdir of CANONICAL_DOCUMENT_DIRS) {
			const scanDir = join(questDir, subdir);
			const entries = kindEntries(questDir, subdir, pass);
			if (!entries) continue;
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const child = entry.name;
				const childPath = join(scanDir, child);
				if (extname(child) !== ".md") continue;
				const base = child.slice(0, -3);
				if (!isId(base) || prefixOf(base) === "QEST") continue;
				const reading = parsedOnce(childPath, pass, documentRecords, (t) => {
					const docDoc = parseDocumentFile(t);
					return docDoc ? kept<QuestDocumentDoc>(docDoc, childPath) : undefined;
				});
				if (!reading) continue;
				if ("doc" in reading) {
					documents.push({ path: childPath, doc: reading.doc });
					continue;
				}
				// Surfaced rather than skipped. A file named like a document,
				// sitting where documents live, that nothing can read is the
				// one case where silence is indistinguishable from the file
				// not existing, and the record does exist.
				errors.push({
					path: childPath,
					message: `Document "${child}" could not be read: ${explainDocumentFrontMatter(reading.text).join("; ")}.`,
				});
			}
		}
		return documents;
	}

	function reportNestedQuests(questDir: string, depth: number): void {
		if (depth > MAX_WALK_DEPTH) {
			errors.push({
				path: questDir,
				message: `Walk depth exceeded ${MAX_WALK_DEPTH}; refusing to recurse further.`,
			});
			return;
		}
		const entries = readEntries(questDir, pass);
		if (!entries) return;
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			if (!entry.isDirectory()) continue;
			const name = entry.name;
			if (isId(name) && prefixOf(name) === "QEST") {
				errors.push({
					path: join(questDir, name),
					message: `Nested quest "${name}" found inside another quest. Quests live as immediate children of the quests root; hierarchy is expressed by the parent: front-matter field.`,
				});
				reportNestedQuests(join(questDir, name), depth + 1);
			}
		}
	}

	function acceptQuest(name: string, full: string): void {
		const readmePath = join(full, "README.md");
		const reading = parsedOnce(readmePath, pass, readmes, (t) => {
			const parsed = parseQuestDoc(t);
			return parsed ? kept<QuestDoc>(parsed, readmePath) : undefined;
		});
		if (!reading) {
			errors.push({ path: readmePath, message: "README.md missing" });
			return;
		}
		if (!("doc" in reading)) {
			errors.push({
				path: readmePath,
				message: "Front-matter invalid or absent.",
			});
			return;
		}
		const { doc } = reading;
		if (doc.frontMatter.id !== name) {
			errors.push({
				path: readmePath,
				message: `Directory name "${name}" does not match front-matter id "${doc.frontMatter.id}".`,
			});
		}
		const documents = scanDocuments(full);
		quests.set(doc.frontMatter.id, { dir: full, doc, documents });
		const parentKey = doc.frontMatter.parent ?? "";
		const list = children.get(parentKey) ?? [];
		list.push(doc.frontMatter.id);
		children.set(parentKey, list);
		// Look for nested quests inside this one and surface
		// them as errors; never index them.
		reportNestedQuests(full, 1);
	}

	const rootEntries = readEntries(questsRoot, pass);
	if (!rootEntries) {
		errors.push({
			path: questsRoot,
			message: "Quests root does not exist as a directory.",
		});
		return { index: { quests, children }, errors };
	}

	const rootReal = safeRealpath(questsRoot);
	if (rootReal) visited.add(rootReal);

	for (const entry of rootEntries) {
		const name = entry.name;
		if (entry.isSymbolicLink()) continue;
		if (!entry.isDirectory()) continue;
		if (name === "node_modules" || name === ".git" || name.startsWith(".")) {
			continue;
		}
		const full = join(questsRoot, name);
		const real = safeRealpath(full);
		if (real) {
			if (visited.has(real)) continue;
			visited.add(real);
		}
		if (isId(name) && prefixOf(name) === "QEST") {
			acceptQuest(name, full);
			continue;
		}
		errors.push({
			path: full,
			message: `Unexpected directory "${name}" at quests root. Only QEST-* directories belong here.`,
		});
	}

	return { index: { quests, children }, errors };
}
