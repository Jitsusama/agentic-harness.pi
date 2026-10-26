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
import {
	type Dirent,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { QuestDoc, QuestDocumentDoc } from "../../quest/types.ts";
import {
	explainDocumentFrontMatter,
	parseDocumentFrontMatter,
	splitFrontMatter,
} from "./frontmatter.ts";
import { isId, prefixOf } from "./id.ts";
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

/**
 * What one discovery call has read from disk. The signature pass fills
 * it on the way to a cache miss and the walk reuses it, so a cold call
 * reads each file and lists each directory once rather than twice.
 */
interface Pass {
	bytes: Map<string, Buffer>;
	listings: Map<string, Dirent[] | undefined>;
	/** Each file's content hash, as the signature pass found it. */
	hashes: Map<string, string>;
	/** Every file the walk parsed or reused, so the memo keeps no others. */
	parsed: Set<string>;
}

function newPass(): Pass {
	return {
		bytes: new Map(),
		listings: new Map(),
		hashes: new Map(),
		parsed: new Set(),
	};
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

function readEntries(path: string, pass: Pass): Dirent[] | undefined {
	if (pass.listings.has(path)) return pass.listings.get(path);
	let entries: Dirent[] | undefined;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		entries = undefined;
	}
	pass.listings.set(path, entries);
	return entries;
}

/**
 * A quest's kind subdirectory listing, or undefined when the quest has
 * none. Most quests have one or two of the four, so asking the quest's
 * own listing first spares a failed readdir for each one missing.
 */
function kindEntries(
	questDir: string,
	subdir: string,
	pass: Pass,
): Dirent[] | undefined {
	const present = readEntries(questDir, pass)?.some(
		(e) => e.name === subdir && (e.isDirectory() || e.isSymbolicLink()),
	);
	return present ? readEntries(join(questDir, subdir), pass) : undefined;
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
 * A parsed record as the index keeps it: its front matter and title
 * copied out of the file's text, and its body read from the file each
 * time it is asked for.
 *
 * Holding every body kept 45 million characters of quest prose in
 * every pi process, 73 MB of a 73 MB index, and a title or field that
 * V8 had cut out of a file's text kept the whole text alive besides.
 * Only lookups, `find`, `links` and `show` read bodies, never a
 * per-turn path, and reading all 733 READMEs' bodies takes 11 ms, so
 * the index keeps what every call asks for (20 MB, from 73) and leaves
 * prose on disk.
 * A body read later can be newer than the front matter beside it,
 * which the next walk's signature catches.
 */
function kept<D extends QuestDoc | QuestDocumentDoc>(doc: D, path: string): D {
	const copied = structuredClone({
		frontMatter: doc.frontMatter,
		title: doc.title,
	});
	const lean = { frontMatter: copied.frontMatter, title: copied.title };
	Object.defineProperty(lean, "body", {
		enumerable: true,
		get: () => {
			try {
				// Both parsers take the body as the split leaves it, so the
				// front matter need not be parsed again to find it.
				return splitFrontMatter(readFileSync(path, "utf8"))?.body ?? "";
			} catch {
				// Gone since the walk: the next walk drops the record too.
				return "";
			}
		},
	});
	return lean as D;
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

/** A file's content hash, and the stat it was taken under. */
interface Stamp {
	stat: string;
	hash: string;
}

/** What discovery remembers between calls, for the whole process. */
interface Memo {
	cache: Map<string, CacheSlot>;
	stamps: Map<string, Stamp>;
	readmes: Map<string, Parsed<QuestDoc>>;
	documents: Map<string, Parsed<QuestDocumentDoc>>;
}

/**
 * Where the memo lives: on `globalThis`, never in this module's scope.
 *
 * pi loads each extension through its own module graph and never
 * unloads one, so every extension that imports this file has a copy of
 * it, and every reload adds another set. Kept in module scope, each
 * copy built its own index of every quest and document (72 MB here),
 * and a copy from before a reload kept its index for the life of the
 * process: seven of them, 505 MB, in one session after a night of
 * merges. One slot means one index however many copies there are, and
 * a copy that no longer runs holds nothing.
 */
const MEMO = Symbol.for("agentic-harness.quest-discovery");

type GlobalMemo = Record<symbol, Memo | undefined>;

/** The process's memo, made on first use. Read afresh on every call. */
function memo(): Memo {
	const global = globalThis as GlobalMemo;
	let found = global[MEMO];
	if (!found) {
		found = {
			cache: new Map(),
			stamps: new Map(),
			readmes: new Map(),
			documents: new Map(),
		};
		global[MEMO] = found;
	}
	return found;
}

/**
 * How long a file must have sat unwritten before its stat is trusted to
 * stand for its content. A filesystem with coarse timestamps can give
 * two writes inside one tick the same mtime, and a same-size rewrite
 * would then keep its stat; this is git's racy-index rule. Two seconds
 * covers the coarsest clock in use.
 */
const SETTLED_NS = 2_000_000_000n;

/**
 * Drop the discovery memo. Tests call this between runs; write
 * paths do not need it because the signature catches their
 * changes on the next read. A reload must call it, since the
 * memo outlives the code that built it: the next code may shape
 * an index differently, and must not be handed the old one.
 */
export function clearDiscoveryCache(): void {
	delete (globalThis as GlobalMemo)[MEMO];
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
	const pass = newPass();
	const signature = discoverySignature(questsRoot, pass);
	const { cache } = memo();
	const cached = cache.get(questsRoot);
	if (cached && cached.signature === signature) return cached.result;
	const result = discoverQuestsUncached(questsRoot, pass);
	cache.set(questsRoot, { signature, result });
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
 * a nested quest) move it too. A file whose stat still matches the
 * one its hash was taken under keeps that hash without being read,
 * provided it had settled before the hash was taken, so a warm read
 * of an unchanged tree costs a stat per file rather than its bytes.
 * Whatever it reads lands in `pass` for the walk to reuse.
 */
function discoverySignature(questsRoot: string, pass: Pass): string {
	const parts: string[] = [];
	const stampContent = (path: string): void => {
		try {
			parts.push(`${path}:${contentHash(path, pass)}`);
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
	const rootEntries = readEntries(questsRoot, pass);
	if (!rootEntries) return "absent";
	parts.push(`root:${layout(rootEntries)}`);
	for (const entry of rootEntries) {
		if (!entry.isDirectory()) continue;
		if (!isId(entry.name) || prefixOf(entry.name) !== "QEST") continue;
		const questDir = join(questsRoot, entry.name);
		const questEntries = readEntries(questDir, pass);
		if (questEntries) parts.push(`${entry.name}:${layout(questEntries)}`);
		stampContent(join(questDir, "README.md"));
		for (const subdir of CANONICAL_DOCUMENT_DIRS) {
			const scanDir = join(questDir, subdir);
			const docEntries = kindEntries(questDir, subdir, pass);
			if (!docEntries) continue;
			for (const doc of docEntries) {
				if (doc.isFile()) stampContent(join(scanDir, doc.name));
			}
		}
	}
	return parts.sort().join("|");
}

/** A file's content hash, from its stamp when the stat still vouches. */
function contentHash(path: string, pass: Pass): string {
	const st = statSync(path, { bigint: true });
	const stat = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
	const { stamps } = memo();
	const known = stamps.get(path);
	if (known && known.stat === stat) {
		pass.hashes.set(path, known.hash);
		return known.hash;
	}
	const bytes = readFileSync(path);
	pass.bytes.set(path, bytes);
	const hash = hashOf(bytes);
	pass.hashes.set(path, hash);
	const age = BigInt(Date.now()) * 1_000_000n - st.mtimeNs;
	if (age > SETTLED_NS) stamps.set(path, { stat, hash });
	else stamps.delete(path);
	return hash;
}

function hashOf(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("hex");
}

/** A file's kept record, and the hash of the text it was parsed from. */
interface Parsed<D> {
	readonly hash: string;
	readonly doc: D;
}

/** A file's record, or its text when that would not parse. */
type Reading<D> = { doc: D } | { text: string };

/**
 * A file's kept record, parsed only when its content is new.
 *
 * Any change anywhere in the tree misses the index, and the walk that
 * follows used to reparse every README and document: about 900 ms over
 * 753 quests, paid by each session on its next call after any other
 * session wrote a journal line. A record whose file's hash is the one
 * it was parsed from is reused, so a rebuild reparses only what
 * changed. A miss hashes the bytes it parses rather than trusting the
 * signature's hash, which a stat may have vouched for. A file that will
 * not parse is not kept, so its error is raised on every walk.
 */
function parsedOnce<D>(
	path: string,
	pass: Pass,
	table: Map<string, Parsed<D>>,
	parse: (text: string) => D | undefined,
): Reading<D> | undefined {
	const known = table.get(path);
	if (known && known.hash === pass.hashes.get(path)) {
		pass.parsed.add(path);
		return { doc: known.doc };
	}
	let bytes = pass.bytes.get(path);
	if (!bytes) {
		try {
			bytes = readFileSync(path);
		} catch {
			// Gone or unreadable since the signature pass: the caller
			// treats it as missing, and the next signature differs.
			return undefined;
		}
	}
	const text = bytes.toString("utf8");
	if (!text) return undefined;
	const doc = parse(text);
	if (!doc) return { text };
	table.set(path, { hash: hashOf(bytes), doc });
	pass.parsed.add(path);
	return { doc };
}

/** Drop every kept record the last walk neither parsed nor reused. */
function forgetUnparsed(pass: Pass): void {
	const { readmes, documents } = memo();
	for (const table of [readmes, documents]) {
		for (const path of table.keys()) {
			if (!pass.parsed.has(path)) table.delete(path);
		}
	}
}

function discoverQuestsUncached(
	questsRoot: string,
	pass: Pass,
): DiscoveryResult {
	const result = walkQuests(questsRoot, pass);
	forgetUnparsed(pass);
	return result;
}

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
					return docDoc ? kept(docDoc, childPath) : undefined;
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
			return parsed ? kept(parsed, readmePath) : undefined;
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
