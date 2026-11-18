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
 * `../discovery-seed.ts`, one folder up. On a host, a known
 * tree is signed again off the thread, by `off-thread.ts`.
 */

import { realpathSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { hosted } from "../../../core/session/host.ts";
import type { QuestDoc, QuestDocumentDoc } from "../../../quest/types.ts";
import { cacheDir } from "../../paths.ts";
import { isId, prefixOf } from "../creation/id.ts";
import {
	codeKey,
	leaveSeed,
	SEED_AFTER_PARSES,
	SEED_FOLDER,
	type SeedOptions,
	takeSeed,
} from "../discovery-seed.ts";
import {
	explainDocumentFrontMatter,
	parseDocumentFrontMatter,
} from "../documents/frontmatter.ts";
import { extractTitle, parseQuestDoc } from "../documents/quest-doc.ts";
import { questWritesMade } from "../io.ts";
import {
	CANONICAL_DOCUMENT_DIRS,
	type CacheSlot,
	discoverySignature,
	forgetMemo,
	forgetUnparsed,
	kept,
	kindEntries,
	MAX_WALK_DEPTH,
	memo,
	newPass,
	type Pass,
	parsedOnce,
	readEntries,
	type SigningEnd,
} from "./discovery-reads.ts";
import {
	folderStampOf,
	pendingStampOf,
	readTreeOffThread,
} from "./off-thread.ts";

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
 * walk parses READMEs and documents, which is the costly part;
 * this caches the result behind the tree's content signature
 * (`discoverySignature`) so repeated read verbs in a session do
 * not re-parse an unchanged tree. The signature recomputes on
 * every call, a listing per folder and a stat per settled file,
 * so any change to a README, a document, or the set of quests
 * invalidates the cache on the next read.
 */
export function discoverQuests(
	questsRoot: string,
	seed: SeedOptions = {},
): DiscoveryResult {
	const kept = held?.get(questsRoot);
	if (kept && kept.writes === questWritesMade()) return kept.result;
	const result = hosted()
		? discoverQuestsHosted(questsRoot, seed)
		: discoverQuestsSigned(questsRoot, seed);
	// Counted after the walk, whose seed for the next process isn't a quest.
	held?.set(questsRoot, { writes: questWritesMade(), result });
	return result;
}

/**
 * On a host, sign the tree now, so the asks that follow in the next few
 * seconds answer as it stands: the quest tool does it before each
 * action, whose reads decide what it writes, and a session as it
 * starts. Plain pi signs every ask already, so this does nothing there.
 */
export function signQuestsNow(questsRoot: string): void {
	if (hosted()) discoverQuestsSigned(questsRoot, {});
}

/**
 * Walk `questsRoot` as it stands now, signed off the thread on a host
 * and waited for, for work that can wait: the desktop's lists, written
 * only from a walk signed after the change that asked for them. A
 * signing this process's own write overtook is made again off the
 * thread, and after `AFRESH_TRIES` on it. One that gives up on the disk
 * throws, since signing it on the thread would hold every conversation
 * on that same disk. Plain pi signs it on the thread, as every ask.
 */
export async function discoverQuestsAfresh(
	questsRoot: string,
): Promise<DiscoveryResult> {
	if (!hosted()) return discoverQuestsSigned(questsRoot, {});
	for (let tries = 0; tries < AFRESH_TRIES; tries++) {
		const asked = Date.now();
		const writes = questWritesMade();
		await discoverySettled(questsRoot);
		const ended = await signOffThread(questsRoot);
		if (ended === "gave up") throw new Error(SIGNING_GAVE_UP);
		const slot = memo().cache.get(questsRoot);
		const current =
			slot &&
			slot.signedAt >= asked &&
			slot.writes === writes &&
			writes === questWritesMade();
		if (current) return slot.result;
	}
	return discoverQuestsSigned(questsRoot, {});
}

/** How often `discoverQuestsAfresh` signs off the thread before on it. */
const AFRESH_TRIES = 3;

const SIGNING_GAVE_UP = "the quest tree didn't answer a signing in time";

/**
 * How long a host answers a known tree from its last signing before an
 * ask starts signing it again off the thread. Another process's change
 * to a quest shows within about this long of the next ask; a change
 * this process made through the workflow, and a quest made or removed,
 * show at once.
 */
const SIGN_AGAIN_AFTER_MS = 5_000;

/**
 * How old a host's last signing may be and still answer at all: a tree
 * nobody asked about for this long is signed on the thread at the next
 * ask, so a change made while a host sat idle never answers late.
 */
const STALE_AFTER_MS = 60_000;

/**
 * How long a signing off the thread may run before a host stops
 * waiting on it: past this, the next ask may start another, and what
 * the late one finds is dropped for the newer.
 */
const SIGNING_GIVES_UP_MS = 30_000;

/**
 * How long a signing given up on still holds its root, so no other
 * starts beside it: past this its disk is taken to hang, and another
 * may try. A walk that is only slow, as on a host thread shared by
 * sixty conversations, ends well inside it; on 17 Nov one starting
 * each time the last gave up left walks piling up on that thread.
 */
const SIGNING_HUNG_AFTER_MS = 5 * 60_000;

/**
 * A host's discovery, which shares one thread with every conversation:
 * a known tree is answered from its last signed walk, and signed again
 * off the thread once that is a few seconds old. It signs on the thread
 * as plain pi does when the last walk can't stand (`stands`).
 */
function discoverQuestsHosted(
	questsRoot: string,
	seed: SeedOptions,
): DiscoveryResult {
	const slot = memo().cache.get(questsRoot);
	if (!slot || !stands(questsRoot, slot)) {
		return discoverQuestsSigned(questsRoot, seed);
	}
	if (Date.now() - slot.signedAt > SIGN_AGAIN_AFTER_MS) {
		void signOffThread(questsRoot);
	}
	return slot.result;
}

/**
 * Whether a host may answer from its last walk: no quest written by
 * this process since, signed within the minute, and the stats of the
 * root and of each folder it found with no README both settled when
 * taken and unchanged since, so no quest was made, removed or given its
 * README meanwhile.
 */
function stands(questsRoot: string, slot: CacheSlot): boolean {
	if (slot.writes !== questWritesMade()) return false;
	// A clock stepped back gives a negative age, which no limit bounds.
	const age = Date.now() - slot.signedAt;
	if (age < 0 || age > STALE_AFTER_MS) return false;
	const root = slot.rootStamp;
	if (root === undefined || root !== folderStampOf(questsRoot)) return false;
	for (const [dir, stamp] of slot.pending) {
		if (stamp === undefined || stamp !== pendingStampOf(dir)) return false;
	}
	return true;
}

/**
 * Resolves once the signing of `questsRoot` under way off the thread,
 * if any, has ended; at once when none is.
 */
export function discoverySettled(
	questsRoot: string,
): Promise<SigningEnd | undefined> {
	return memo().signing.get(questsRoot) ?? Promise.resolve(undefined);
}

/**
 * Sign `questsRoot` off the thread, one signing a root at a time, and
 * keep what it found unless this process wrote a quest meanwhile, the
 * memo was let go, or a signing begun later already answered. An
 * unchanged tree keeps its walk; a changed one is walked again on the
 * thread, from memory. One that runs past `SIGNING_GIVES_UP_MS` is no
 * longer waited on, but holds its root until it ends, or until
 * `SIGNING_HUNG_AFTER_MS` says its disk hangs, so no second walk
 * starts beside a slow one.
 */
function signOffThread(questsRoot: string): Promise<SigningEnd | undefined> {
	const m = memo();
	const under = m.signing.get(questsRoot);
	if (under) return under;
	const signedAt = Date.now();
	const writes = questWritesMade();
	const work = (async (): Promise<SigningEnd> => {
		const { pass, rootStamp } = await readTreeOffThread(questsRoot);
		if (memo() !== m || questWritesMade() !== writes) return "dropped";
		const cached = m.cache.get(questsRoot);
		if (cached && cached.signedAt > signedAt) return "dropped";
		const signature = discoverySignature(questsRoot, pass);
		const result =
			cached && cached.signature === signature
				? cached.result
				: discoverQuestsUncached(questsRoot, pass);
		m.cache.set(
			questsRoot,
			slotOf(signature, result, { signedAt, writes, rootStamp }, pass),
		);
		return "kept";
	})().catch((error: unknown): SigningEnd => {
		// The last walk stands, and the next ask past its age signs again.
		sayOnHost(`signing ${questsRoot} off the thread failed: ${error}`);
		return "failed";
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let gaveUp = false;
	const givenUp = new Promise<SigningEnd>((resolve) => {
		// Not a wait for something to happen: a ceiling on a disk that hangs.
		timer = setTimeout(() => {
			gaveUp = true;
			sayOnHost(
				`signing ${questsRoot} gave up after ${SIGNING_GIVES_UP_MS} ms`,
			);
			resolve("gave up");
		}, SIGNING_GIVES_UP_MS);
		timer.unref();
	});
	const signing = Promise.race([work, givenUp]);
	const free = () => {
		if (m.signing.get(questsRoot) === signing) m.signing.delete(questsRoot);
	};
	// Not a wait either: the longest a hung walk keeps others off its root.
	const hung = setTimeout(free, SIGNING_HUNG_AFTER_MS);
	hung.unref();
	void work.then((end) => {
		clearTimeout(timer);
		clearTimeout(hung);
		if (gaveUp) {
			sayOnHost(
				`signing ${questsRoot} ended (${end}) after ${Date.now() - signedAt} ms, past its give-up`,
			);
		}
		free();
	});
	m.signing.set(questsRoot, signing);
	return signing;
}

/**
 * Say a signing's trouble where a host keeps what it says: its stderr,
 * which is its journal. Only a host signs off the thread.
 */
function sayOnHost(line: string): void {
	process.stderr.write(`[quest-workflow] discovery: ${line}\n`);
}

/** discoverQuests's walk, behind the tree's signature. */
function discoverQuestsSigned(
	questsRoot: string,
	seed: SeedOptions,
): DiscoveryResult {
	const pass = newPass();
	const signedAt = Date.now();
	const writes = questWritesMade();
	const rootStamp = folderStampOf(questsRoot);
	const seeds = seed.dir === undefined ? cacheDir(SEED_FOLDER) : seed.dir;
	const code = seeds ? (seed.code ?? codeKey()) : "";
	if (seeds) takeSeed(questsRoot, seeds, code);
	const signature = discoverySignature(questsRoot, pass);
	const { cache } = memo();
	const cached = cache.get(questsRoot);
	const stamps = { signedAt, writes, rootStamp };
	if (cached && cached.signature === signature) {
		cache.set(questsRoot, slotOf(signature, cached.result, stamps));
		return cached.result;
	}
	const result = discoverQuestsUncached(questsRoot, pass);
	cache.set(questsRoot, slotOf(signature, result, stamps));
	if (seeds && pass.parses >= (seed.after ?? SEED_AFTER_PARSES)) {
		leaveSeed(questsRoot, seeds, code);
	}
	return result;
}

/** What a signing knew as it began: when, the writes by then, the root's stat. */
interface SignedUnder {
	readonly signedAt: number;
	readonly writes: number;
	readonly rootStamp: string | undefined;
}

/**
 * A cache slot for a walk signed under `under`, with the stamp of each
 * quest folder it found with no README (`pendingStampOf`): one being
 * made, whose README lands inside its folder without touching the
 * root's stat. Off the thread, `pass` holds each taken before the read.
 */
function slotOf(
	signature: string,
	result: DiscoveryResult,
	under: SignedUnder,
	pass?: Pass,
): CacheSlot {
	const pending = new Map<string, string | undefined>();
	for (const error of result.errors) {
		if (error.message !== README_MISSING) continue;
		const dir = dirname(error.path);
		// Off the thread, the stamp taken before the folder was read.
		const before = pass?.pending.has(dir);
		pending.set(dir, before ? pass?.pending.get(dir) : pendingStampOf(dir));
	}
	return { signature, result, ...under, pending };
}

const README_MISSING = "README.md missing";

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

	const rootEntries = readEntries(questsRoot, pass);
	if (!rootEntries) {
		errors.push({
			path: questsRoot,
			message: "Quests root does not exist as a directory.",
		});
		return { index: { quests, children }, errors };
	}

	const rootReal = safeRealpath(questsRoot, pass);
	if (rootReal) visited.add(rootReal);

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
