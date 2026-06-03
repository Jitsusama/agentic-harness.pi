/**
 * Quest discovery: walk a quest tree on disk and build an
 * in-memory index.
 *
 * Disk layout (within `questsRoot`):
 *
 *     QEST-20260603-AAA111/
 *       README.md
 *       PLAN-20260603-BBB222.md
 *       RSCH-20260605-CCC333.md
 *       QEST-20260610-DDD444/       (subquest)
 *         README.md
 *
 * We walk recursively. Every directory whose name parses as
 * a QEST id is a quest; its README.md is parsed; any file
 * whose name parses as a PLAN/RSCH/BRIF/RPRT id is recorded
 * as a document under that quest.
 *
 * Free-form subdirectories (`runs/`, `tools/`,
 * `workloads/`, etc.) are not walked — they don't contain
 * quests. We surface them only via the quest's own body
 * references.
 */

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
export function discoverQuests(questsRoot: string): DiscoveryResult {
	const quests = new Map<string, QuestEntry>();
	const children = new Map<string, string[]>();
	const errors: DiscoveryError[] = [];
	const visited = new Set<string>();

	function scanDocuments(full: string): QuestDocumentEntry[] {
		const documents: QuestDocumentEntry[] = [];
		const documentScanDirs = [
			full,
			join(full, "plans"),
			join(full, "research"),
			join(full, "briefs"),
			join(full, "reports"),
		];
		for (const scanDir of documentScanDirs) {
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

	function visit(dir: string, depth: number): void {
		if (depth > MAX_WALK_DEPTH) {
			errors.push({
				path: dir,
				message: `Walk depth exceeded ${MAX_WALK_DEPTH}; refusing to recurse further.`,
			});
			return;
		}
		const real = safeRealpath(dir);
		if (real) {
			if (visited.has(real)) return;
			visited.add(real);
		}
		const entries = readEntries(dir);
		if (!entries) {
			errors.push({ path: dir, message: "Directory unreadable." });
			return;
		}

		for (const entry of entries) {
			const name = entry.name;
			if (entry.isSymbolicLink()) {
				// Skip symlinks entirely so the walk cannot escape
				// the questsRoot via a stray link.
				continue;
			}
			if (!entry.isDirectory()) continue;
			const full = join(dir, name);
			if (isId(name) && prefixOf(name) === "QEST") {
				const readmePath = join(full, "README.md");
				const text = readMaybe(readmePath);
				if (!text) {
					errors.push({ path: readmePath, message: "README.md missing" });
					visit(full, depth + 1);
					continue;
				}
				const doc = parseQuestDoc(text);
				if (!doc) {
					errors.push({
						path: readmePath,
						message: "Front-matter invalid or absent.",
					});
					visit(full, depth + 1);
					continue;
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
				visit(full, depth + 1);
				continue;
			}
			if (name === "node_modules" || name === ".git" || name.startsWith(".")) {
				continue;
			}
			visit(full, depth + 1);
		}
	}

	const rootEntries = readEntries(questsRoot);
	if (rootEntries) {
		visit(questsRoot, 0);
	} else {
		errors.push({
			path: questsRoot,
			message: "Quests root does not exist as a directory.",
		});
	}

	return { index: { quests, children }, errors };
}
