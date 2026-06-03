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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { QuestDoc, QuestDocumentDoc } from "../../quest/types.js";
import { parseDocumentFrontMatter } from "./frontmatter.js";
import { isId, prefixOf } from "./id.js";
import { extractTitle, parseQuestDoc } from "./quest-doc.js";

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

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
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
 */
export function discoverQuests(questsRoot: string): DiscoveryResult {
	const quests = new Map<string, QuestEntry>();
	const children = new Map<string, string[]>();
	const errors: DiscoveryError[] = [];

	function visit(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err) {
			errors.push({ path: dir, message: (err as Error).message });
			return;
		}

		for (const name of entries) {
			const full = join(dir, name);
			if (isDirectory(full)) {
				if (isId(name) && prefixOf(name) === "QEST") {
					const readmePath = join(full, "README.md");
					const text = readMaybe(readmePath);
					if (!text) {
						errors.push({ path: readmePath, message: "README.md missing" });
						visit(full);
						continue;
					}
					const doc = parseQuestDoc(text);
					if (!doc) {
						errors.push({
							path: readmePath,
							message: "Front-matter invalid or absent.",
						});
						visit(full);
						continue;
					}
					if (doc.frontMatter.id !== name) {
						errors.push({
							path: readmePath,
							message: `Directory name "${name}" does not match front-matter id "${doc.frontMatter.id}".`,
						});
					}
					const documents: QuestDocumentEntry[] = [];
					const documentScanDirs = [
						full,
						join(full, "plans"),
						join(full, "research"),
						join(full, "briefs"),
						join(full, "reports"),
					];
					for (const scanDir of documentScanDirs) {
						if (!isDirectory(scanDir)) continue;
						try {
							for (const child of readdirSync(scanDir)) {
								const childPath = join(scanDir, child);
								if (
									extname(child) === ".md" &&
									isId(child.slice(0, -3)) &&
									prefixOf(child.slice(0, -3)) !== "QEST"
								) {
									const docText = readMaybe(childPath);
									if (!docText) continue;
									const docDoc = parseDocumentFile(docText);
									if (docDoc) documents.push({ path: childPath, doc: docDoc });
								}
							}
						} catch (err) {
							errors.push({ path: scanDir, message: (err as Error).message });
						}
					}
					quests.set(doc.frontMatter.id, { dir: full, doc, documents });
					const parentKey = doc.frontMatter.parent ?? "";
					const list = children.get(parentKey) ?? [];
					list.push(doc.frontMatter.id);
					children.set(parentKey, list);
					visit(full);
					continue;
				}
				// Recurse into non-quest directories at the
				// top level too (a project might keep quests
				// in a category subfolder). We only avoid
				// known sibling siblings like node_modules.
				if (
					name === "node_modules" ||
					name === ".git" ||
					name.startsWith(".")
				) {
					continue;
				}
				visit(full);
			}
		}
	}

	if (isDirectory(questsRoot)) visit(questsRoot);
	else {
		errors.push({
			path: questsRoot,
			message: "Quests root does not exist as a directory.",
		});
	}

	return { index: { quests, children }, errors };
}
