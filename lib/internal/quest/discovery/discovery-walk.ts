/**
 * The walk of a quest tree: every quest under the root, or only the
 * root entries a caller names, read into an index, and a part read so
 * taken into the last whole walk in place of what it held of them.
 * What a walk asks of the disk, and the memo that spares it a read, are
 * in `discovery-reads.ts`; when to walk, and what, is `discovery.ts`'s.
 */

import { type Dirent, lstatSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	sep,
} from "node:path";
import type { QuestDoc, QuestDocumentDoc } from "../../../quest/types.ts";
import { isId, prefixOf } from "../creation/id.ts";
import {
	explainDocumentFrontMatter,
	parseDocumentFrontMatter,
} from "../documents/frontmatter.ts";
import { extractTitle, parseQuestDoc } from "../documents/quest-doc.ts";
import type {
	DiscoveryError,
	DiscoveryResult,
	QuestDocumentEntry,
	QuestEntry,
} from "./discovery.ts";
import {
	CANONICAL_DOCUMENT_DIRS,
	forgetUnparsed,
	kept,
	kindEntries,
	kindOf,
	MAX_WALK_DEPTH,
	memo,
	type Pass,
	parsedOnce,
	readEntries,
	vouchQuestFiles,
} from "./discovery-reads.ts";
import { pendingStampOf } from "./off-thread.ts";

/** What a walk says of a quest folder with no README, as one being made. */
export const README_MISSING = "README.md missing";

function safeRealpath(path: string, pass: Pass): string | undefined {
	if (pass.reals.has(path)) return pass.reals.get(path);
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

/** The names gained, lost or changed in kind from `was` to `now`. */
export function movedNames(
	was: ReadonlyMap<string, string>,
	now: ReadonlyMap<string, string>,
): Set<string> {
	const moved = new Set<string>();
	for (const [name, kind] of now) if (was.get(name) !== kind) moved.add(name);
	for (const name of was.keys()) if (!now.has(name)) moved.add(name);
	return moved;
}

/** Each name a root listing holds, with its kind. */
export function namesOf(entries: readonly Dirent[]): Map<string, string> {
	return new Map(entries.map((entry) => [entry.name, kindOf(entry)]));
}

/**
 * The stamps of the folders among `names` that `result` found with no
 * README, as a whole walk's slot takes them.
 */
export function pendingOf(
	result: DiscoveryResult,
	names: ReadonlySet<string>,
): Map<string, string | undefined> {
	const pending = new Map<string, string | undefined>();
	for (const error of result.errors) {
		if (error.message !== README_MISSING) continue;
		const dir = dirname(error.path);
		if (names.has(basename(dir))) pending.set(dir, pendingStampOf(dir));
	}
	return pending;
}

/**
 * `last` with what `found` read of the root's entries in `names` in
 * place of what it held of them: each quest kept where it stood, one
 * gone dropped, one new added at the end, and the errors of those
 * entries replaced.
 */
export function merged(
	questsRoot: string,
	last: DiscoveryResult,
	names: ReadonlySet<string>,
	found: DiscoveryResult,
): DiscoveryResult {
	const fresh = new Map<string, QuestEntry>();
	for (const entry of found.index.quests.values()) {
		fresh.set(basename(entry.dir), entry);
	}
	const quests = new Map<string, QuestEntry>();
	for (const [id, entry] of last.index.quests) {
		const name = basename(entry.dir);
		if (!names.has(name)) {
			quests.set(id, entry);
			continue;
		}
		const now = fresh.get(name);
		if (!now) continue;
		quests.set(now.doc.frontMatter.id, now);
		fresh.delete(name);
	}
	for (const entry of fresh.values()) {
		quests.set(entry.doc.frontMatter.id, entry);
	}
	const among = (path: string) => names.has(entryUnder(questsRoot, path));
	const errors = [
		...last.errors.filter((error) => !among(error.path)),
		...found.errors,
	];
	return { index: { quests, children: childrenOf(quests) }, errors };
}

/** The root entry `path` sits in, or "" for a path not under the root. */
export function entryUnder(questsRoot: string, path: string): string {
	const inside = relative(questsRoot, path);
	const outside =
		inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
	if (!inside || outside) return "";
	return inside.split(sep)[0] ?? "";
}

/** Parent-to-children adjacency over `quests`, in their order. */
function childrenOf(
	quests: ReadonlyMap<string, QuestEntry>,
): Map<string, string[]> {
	const children = new Map<string, string[]>();
	for (const entry of quests.values()) {
		const parentKey = entry.doc.frontMatter.parent ?? "";
		const list = children.get(parentKey) ?? [];
		list.push(entry.doc.frontMatter.id);
		children.set(parentKey, list);
	}
	return children;
}

/** The whole tree under `questsRoot` walked, forgetting what nothing parsed. */
export function discoverQuestsUncached(
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
	const rootEntries = readEntries(questsRoot, pass);
	if (!rootEntries) {
		const errors = [
			{
				path: questsRoot,
				message: "Quests root does not exist as a directory.",
			},
		];
		return { index: { quests: new Map(), children: new Map() }, errors };
	}
	const visited = new Set<string>();
	const rootReal = safeRealpath(questsRoot, pass);
	if (rootReal) visited.add(rootReal);
	return walkEntries(questsRoot, rootEntries, pass, visited);
}

/**
 * Walk only the root's entries in `names`: from the root's listing when
 * `pass` holds one, else a link-blind stat each, so an unchanged root
 * is never listed. One gone yields nothing. Each quest's files are
 * vouched for by stat first, so only those that changed are read and
 * parsed.
 */
export function walkNamed(
	questsRoot: string,
	names: ReadonlySet<string>,
	pass: Pass,
): DiscoveryResult {
	const listed = pass.listings.get(questsRoot);
	const entries = listed
		? listed.filter((entry) => names.has(entry.name))
		: [...names].flatMap((name) => entryAt(questsRoot, name));
	for (const entry of entries) {
		const quest = isId(entry.name) && prefixOf(entry.name) === "QEST";
		if (quest && entry.isDirectory() && !entry.isSymbolicLink()) {
			vouchQuestFiles(join(questsRoot, entry.name), pass);
		}
	}
	return walkEntries(questsRoot, entries, pass, new Set());
}

/** What a walk asks of a root entry. */
type RootEntry = Pick<Dirent, "name" | "isDirectory" | "isSymbolicLink">;

/** The root's entry `name`, as one stat that follows no link reads it. */
function entryAt(questsRoot: string, name: string): RootEntry[] {
	try {
		const st = lstatSync(join(questsRoot, name));
		const isDirectory = () => st.isDirectory();
		return [{ name, isDirectory, isSymbolicLink: () => st.isSymbolicLink() }];
	} catch {
		// Gone, or never there: the walk finds nothing of it.
		return [];
	}
}

/** `walkQuests` over `rootEntries`, skipping real paths in `visited`. */
function walkEntries(
	questsRoot: string,
	rootEntries: readonly RootEntry[],
	pass: Pass,
	visited: Set<string>,
): DiscoveryResult {
	const { readmes, documents: documentRecords } = memo();
	const quests = new Map<string, QuestEntry>();
	const children = new Map<string, string[]>();
	const errors: DiscoveryError[] = [];

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
			errors.push({ path: readmePath, message: README_MISSING });
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

	for (const entry of rootEntries) {
		const name = entry.name;
		if (entry.isSymbolicLink()) continue;
		if (!entry.isDirectory()) continue;
		if (name === "node_modules" || name === ".git" || name.startsWith(".")) {
			continue;
		}
		const full = join(questsRoot, name);
		const real = safeRealpath(full, pass);
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
