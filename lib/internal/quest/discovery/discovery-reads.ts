/**
 * What quest discovery reads of the tree, and what it remembers between
 * calls so it reads as little as it can: the tree's signature, each
 * file's content hash under the stat it was taken at, and each README's
 * and document's parsed record under the hash it was parsed from.
 *
 * One memo serves the whole process, however many copies of this module
 * pi has loaded; `discovery.ts` walks the tree through it, and
 * `discovery-seed.ts` fills it from, and leaves it for, the next process.
 */

import { createHash } from "node:crypto";
import {
	type BigIntStats,
	type Dirent,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join, sep } from "node:path";
import type { QuestDoc, QuestDocumentDoc } from "../../../quest/types.ts";
import { isId, prefixOf } from "../creation/id.ts";
import { splitFrontMatter } from "../documents/frontmatter.ts";
import type { DiscoveryResult } from "./discovery.ts";

/**
 * What one discovery call has read from disk. The signature pass fills
 * it on the way to a cache miss and the walk reuses it, so a cold call
 * reads each file and lists each directory once rather than twice.
 */
export interface Pass {
	bytes: Map<string, Buffer>;
	listings: Map<string, Entry[] | undefined>;
	/** Each file's content hash, as the signature pass found it. */
	hashes: Map<string, string>;
	/** Files a signing off the thread found missing or unreadable. */
	absent: Set<string>;
	/** Each folder's real path, as a signing off the thread resolved it. */
	reals: Map<string, string | undefined>;
	/**
	 * Each quest folder's stamp with its README's, taken off the thread
	 * before the folder was listed, for a folder the walk finds unready.
	 */
	pending: Map<string, string | undefined>;
	/** Every file the walk parsed or reused, so the memo keeps no others. */
	parsed: Set<string>;
	/** How many files the walk had to parse, reusing no record. */
	parses: number;
}

/**
 * What the walk reads of a folder's entry: a `Dirent` read here, or one
 * rebuilt from what a signing thread listed.
 */
export type Entry = Pick<
	Dirent,
	"name" | "isDirectory" | "isFile" | "isSymbolicLink"
>;

/** A pass that has read nothing yet. */
export function newPass(): Pass {
	return {
		bytes: new Map(),
		listings: new Map(),
		hashes: new Map(),
		absent: new Set(),
		reals: new Map(),
		pending: new Map(),
		parsed: new Set(),
		parses: 0,
	};
}

/**
 * Maximum directory depth the walk follows. A quest tree
 * with depth past this is almost certainly a symlink loop
 * or accidental nesting; we stop and log an error rather
 * than wedge every quest action.
 */
export const MAX_WALK_DEPTH = 16;

/** The kind subdirectories a quest's documents live in. */
export const CANONICAL_DOCUMENT_DIRS = [
	"plans",
	"research",
	"briefs",
	"reports",
] as const;

/** A directory's listing, read once a pass, or undefined when it has none. */
export function readEntries(path: string, pass: Pass): Entry[] | undefined {
	if (pass.listings.has(path)) return pass.listings.get(path);
	let entries: Entry[] | undefined;
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
export function kindEntries(
	questDir: string,
	subdir: string,
	pass: Pass,
): Entry[] | undefined {
	const present = readEntries(questDir, pass)?.some(
		(e) => e.name === subdir && (e.isDirectory() || e.isSymbolicLink()),
	);
	return present ? readEntries(join(questDir, subdir), pass) : undefined;
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
 *
 * Callers name D: TypeScript 5, which consumers still check this
 * with, can't infer it through Pick and widens it to the union.
 */
export function kept<D extends QuestDoc | QuestDocumentDoc>(
	doc: Pick<D, "frontMatter" | "title">,
	path: string,
): D {
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
 * A root's last walk, and the signature of the tree it walked, with
 * what a host needs to answer from it without signing again: when the
 * signing began, the writes this process had made by then, and the
 * settled stats of the root and of each quest folder it found with no
 * README, undefined for one changed too lately to vouch.
 */
export interface CacheSlot {
	signature: string;
	result: DiscoveryResult;
	signedAt: number;
	writes: number;
	rootStamp: string | undefined;
	pending: ReadonlyMap<string, string | undefined>;
}

/** A file's content hash, and the stat it was taken under. */
interface Stamp {
	stat: string;
	hash: string;
}

/** A file's kept record, and the hash of the text it was parsed from. */
export interface Parsed<D> {
	readonly hash: string;
	readonly doc: D;
}

/** What discovery remembers between calls, for the whole process. */
interface Memo {
	cache: Map<string, CacheSlot>;
	stamps: Map<string, Stamp>;
	readmes: Map<string, Parsed<QuestDoc>>;
	documents: Map<string, Parsed<QuestDocumentDoc>>;
	/** The roots this memo has taken a seed for, so each is read once. */
	seeded: Set<string>;
	/** Each root's signing under way off the thread, at most one. */
	signing: Map<string, Promise<SigningEnd | undefined>>;
	/** Whether the person paused signing off the thread, and when read. */
	paused?: { readonly is: boolean; readonly readAt: number };
}

/**
 * How a signing off the thread ended: its walk kept, dropped for a
 * newer one or failed; or, to one ask, given up on while the walk ran
 * on. Undefined from code that says none.
 */
export type SigningEnd = "kept" | "dropped" | "failed" | "gave up";

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
export function memo(): Memo {
	const global = globalThis as GlobalMemo;
	let found = global[MEMO];
	// A conversation still on code from before signings off the thread
	// may have made the memo; it is shared, so the newer code fills in.
	if (found && !found.signing) found.signing = new Map();
	if (!found) {
		found = {
			cache: new Map(),
			stamps: new Map(),
			readmes: new Map(),
			documents: new Map(),
			seeded: new Set(),
			signing: new Map(),
		};
		global[MEMO] = found;
	}
	return found;
}

/** Let go of the process's memo, so no copy of this module keeps it. */
export function forgetMemo(): void {
	delete (globalThis as GlobalMemo)[MEMO];
}

/**
 * How long a file must have sat unwritten before its stat is trusted to
 * stand for its content. A filesystem with coarse timestamps can give
 * two writes inside one tick the same mtime, and a same-size rewrite
 * would then keep its stat; this is git's racy-index rule. Two seconds
 * covers the coarsest clock in use.
 */
export const SETTLED_NS = 2_000_000_000n;

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
export function discoverySignature(questsRoot: string, pass: Pass): string {
	const parts: string[] = [];
	const stampContent = (path: string): void => {
		try {
			parts.push(`${path}:${contentHash(path, pass)}`);
		} catch {
			// Missing or unreadable file contributes nothing; its
			// absence is itself a change from a signature that had it.
		}
	};
	const layout = (entries: Entry[]): string =>
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

/**
 * A file's content hash: as a signing off the thread found it, else
 * from its stamp when the stat still vouches, else from its bytes.
 */
function contentHash(path: string, pass: Pass): string {
	const found = pass.hashes.get(path);
	if (found !== undefined) return found;
	if (pass.absent.has(path)) throw new Error(`${path} is absent`);
	const st = statSync(path, { bigint: true });
	const vouched = vouchedHash(path, st);
	if (vouched !== undefined) {
		pass.hashes.set(path, vouched);
		return vouched;
	}
	return hashRead(path, st, readFileSync(path), pass);
}

/**
 * A file's stat as a stamp keeps it. The signing thread
 * (`off-thread.ts`) writes the same key from its own stats.
 */
function statKey(st: BigIntStats): string {
	return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
}

/** The hash a file's stamp vouches for under this stat, if it does. */
export function vouchedHash(path: string, st: BigIntStats): string | undefined {
	const known = memo().stamps.get(path);
	return known && known.stat === statKey(st) ? known.hash : undefined;
}

/**
 * Hash a file's bytes, read under `st`, into the pass, and stamp it
 * once it has settled so the next signing need not read it.
 */
export function hashRead(
	path: string,
	st: BigIntStats,
	bytes: Buffer,
	pass: Pass,
): string {
	return keepRead(path, statKey(st), settled(st), bytes, pass);
}

/**
 * `hashRead` for bytes read under a stat already keyed, as a signing
 * thread reads them: stamped only when that stat had `settledThen`.
 */
export function keepRead(
	path: string,
	key: string,
	settledThen: boolean,
	bytes: Buffer,
	pass: Pass,
): string {
	const { stamps } = memo();
	pass.bytes.set(path, bytes);
	const hash = hashOf(bytes);
	pass.hashes.set(path, hash);
	if (settledThen) stamps.set(path, { stat: key, hash });
	else stamps.delete(path);
	return hash;
}

/**
 * Each file under `questsRoot` whose hash a stamp vouches for, with
 * the stat it vouches under and whether a parsed record is kept for
 * that hash, as a signing thread is handed them.
 */
export function stampsUnder(
	questsRoot: string,
): Map<string, { key: string; hash: string; record: boolean }> {
	const under = questsRoot.endsWith(sep) ? questsRoot : `${questsRoot}${sep}`;
	const found = new Map<
		string,
		{ key: string; hash: string; record: boolean }
	>();
	for (const [path, stamp] of memo().stamps) {
		if (!path.startsWith(under)) continue;
		found.set(path, {
			key: stamp.stat,
			hash: stamp.hash,
			record: recordFor(path, stamp.hash),
		});
	}
	return found;
}

/** Whether a stat is old enough to stand for what it describes. */
export function settled(st: BigIntStats): boolean {
	return BigInt(Date.now()) * 1_000_000n - st.mtimeNs > SETTLED_NS;
}

/** Whether a parsed record is kept for this file under this hash. */
export function recordFor(path: string, hash: string): boolean {
	const { readmes, documents } = memo();
	return (readmes.get(path) ?? documents.get(path))?.hash === hash;
}

function hashOf(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("hex");
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
export function parsedOnce<D>(
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
	// Found missing off the thread: read it again here and it holds the
	// thread for a file that isn't there.
	if (pass.absent.has(path)) return undefined;
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
	pass.parses += 1;
	const doc = parse(text);
	if (!doc) return { text };
	table.set(path, { hash: hashOf(bytes), doc });
	pass.parsed.add(path);
	return { doc };
}

/** Drop every kept record the last walk neither parsed nor reused. */
export function forgetUnparsed(pass: Pass): void {
	const { readmes, documents } = memo();
	for (const table of [readmes, documents]) {
		for (const path of table.keys()) {
			if (!pass.parsed.has(path)) table.delete(path);
		}
	}
}
