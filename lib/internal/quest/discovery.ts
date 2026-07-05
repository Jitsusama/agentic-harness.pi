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
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import type { QuestDoc, QuestDocumentDoc } from "../../quest/types.js";
import { parseDocumentFrontMatter } from "./frontmatter.js";
import { isId, prefixOf } from "./id.js";
import { extractTitle, parseQuestDoc } from "./quest-doc.js";

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

function readMaybe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
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

const CANONICAL_DOCUMENT_DIRS = [
	"plans",
	"research",
	"briefs",
	"reports",
] as const;

function readEntries(path: string): Dirent[] | undefined {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
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
interface CacheSlot {
	signature: string;
	result: DiscoveryResult;
}

const discoveryCache = new Map<string, CacheSlot>();

/**
 * Drop the discovery memo. Tests call this between runs; write
 * paths do not need it because the signature catches their
 * changes on the next read.
 */
export function clearDiscoveryCache(): void {
	discoveryCache.clear();
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
export function discoverQuests(questsRoot: string): DiscoveryResult {
	const signature = discoverySignature(questsRoot);
	const cached = discoveryCache.get(questsRoot);
	if (cached && cached.signature === signature) return cached.result;
	const result = discoverQuestsUncached(questsRoot);
	discoveryCache.set(questsRoot, { signature, result });
	return result;
}

/**
 * A content-sensitive fingerprint of the quest tree. For each
 * quest it hashes the README and every document file, so an edit
 * that keeps the byte size identical (a status flip, a same-length
 * reparent, a date-only stamp) still moves the signature. It also
 * folds in the directory listings of the root and each quest dir,
 * so the layout-drift conditions that drive the discovery `errors`
 * (a stray non-quest entry, a misplaced document at a quest root,
 * a nested quest) move it too. Hashing reads the file bytes but
 * skips the parse and object construction the cache exists to
 * avoid, so a warm read still wins on a large tree.
 */
function discoverySignature(questsRoot: string): string {
	const parts: string[] = [];
	const stampContent = (path: string): void => {
		try {
			const hash = createHash("sha1").update(readFileSync(path)).digest("hex");
			parts.push(`${path}:${hash}`);
		} catch {
			// Missing or unreadable file contributes nothing; its
			// absence is itself a change from a signature that had it.
		}
	};
	const layout = (entries: Dirent[]): string =>
		entries
			.map((e) => `${e.name}/${e.isDirectory() ? "d" : "f"}`)
			.sort()
			.join(",");
	const rootEntries = readEntries(questsRoot);
	if (!rootEntries) return "absent";
	parts.push(`root:${layout(rootEntries)}`);
	for (const entry of rootEntries) {
		if (!entry.isDirectory()) continue;
		if (!isId(entry.name) || prefixOf(entry.name) !== "QEST") continue;
		const questDir = join(questsRoot, entry.name);
		const questEntries = readEntries(questDir);
		if (questEntries) parts.push(`${entry.name}:${layout(questEntries)}`);
		stampContent(join(questDir, "README.md"));
		for (const subdir of CANONICAL_DOCUMENT_DIRS) {
			const scanDir = join(questDir, subdir);
			const docEntries = readEntries(scanDir);
			if (!docEntries) continue;
			for (const doc of docEntries) {
				if (doc.isFile()) stampContent(join(scanDir, doc.name));
			}
		}
	}
	return parts.sort().join("|");
}

function discoverQuestsUncached(questsRoot: string): DiscoveryResult {
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
		const questEntries = readEntries(questDir);
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
			const entries = readEntries(scanDir);
			if (!entries) continue;
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const child = entry.name;
				const childPath = join(scanDir, child);
				if (extname(child) !== ".md") continue;
				const base = child.slice(0, -3);
				if (!isId(base) || prefixOf(base) === "QEST") continue;
				const docText = readMaybe(childPath);
				if (!docText) continue;
				const docDoc = parseDocumentFile(docText);
				if (docDoc) documents.push({ path: childPath, doc: docDoc });
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
		const entries = readEntries(questDir);
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
		const text = readMaybe(readmePath);
		if (!text) {
			errors.push({ path: readmePath, message: "README.md missing" });
			return;
		}
		const doc = parseQuestDoc(text);
		if (!doc) {
			errors.push({
				path: readmePath,
				message: "Front-matter invalid or absent.",
			});
			return;
		}
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

	const rootEntries = readEntries(questsRoot);
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
