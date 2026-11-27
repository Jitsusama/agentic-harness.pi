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
 * The walk itself is `discovery-walk.ts`'s. What it reads,
 * and the memo that spares it reading an unchanged file
 * twice, are in `discovery-reads.ts`; the
 * seed that carries the memo to the next process is in
 * `../discovery-seed.ts`, one folder up. On a host, a known
 * tree is signed again off the thread, by `off-thread.ts`,
 * and brought up to date between signings quest by quest.
 */

import { basename, dirname } from "node:path";
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
import { questJournal, questsWrittenSince, questWritesMade } from "../io.ts";
import {
	type JournalMark,
	journalNow,
	journalSince,
} from "../write-journal.ts";
import {
	type CacheSlot,
	discoverySignature,
	forgetMemo,
	memo,
	newPass,
	type Pass,
	readEntries,
	type SigningEnd,
} from "./discovery-reads.ts";
import {
	discoverQuestsUncached,
	entryUnder,
	merged,
	movedNames,
	namesOf,
	pendingOf,
	README_MISSING,
	walkNamed,
} from "./discovery-walk.ts";
import {
	folderStampOf,
	pendingStampOf,
	readTreeOffThread,
} from "./off-thread.ts";
import { threadsHeld } from "./tree-thread.ts";

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

/** Something a walk found out of shape, and where. */
export interface DiscoveryError {
	path: string;
	message: string;
}

/** Result of a discovery walk. */
export interface DiscoveryResult {
	index: QuestIndex;
	errors: DiscoveryError[];
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
 * On a host, read the quests named in `ids` as they stand now, on the
 * thread, so the asks that follow answer them so: a session does it
 * for its own quest as it starts, whose record it writes. A document's
 * id names the quest it sits in, as the last walk found it; any other
 * text names nothing. The rest of the tree stays as the last signing
 * found it, bar what `caughtUp` reads anyway. A tree never signed is
 * signed whole; one it can't bring up to date is left to a signing off
 * the thread. Plain pi signs every ask already, so this does nothing
 * there. An action, which can wait, asks `readyQuests` instead.
 */
export function refreshQuests(
	questsRoot: string,
	ids: Iterable<string | null | undefined>,
): void {
	if (!hosted()) return;
	// A hold's copy predates what is read here.
	held?.delete(questsRoot);
	const slot = memo().cache.get(questsRoot);
	if (!slot) {
		discoverQuestsSigned(questsRoot, {});
		return;
	}
	const named = questsNamed(questsRoot, slot.result, ids) ?? new Set();
	// One it can't bring up to date is read by a signing off the thread.
	if (!caughtUp(questsRoot, slot, named)) void startSigning(questsRoot);
}

/**
 * On a host, bring what an action reads up to now before it acts, since
 * what it reads decides what it writes. The quests `ids` name are read
 * again on the thread, as `refreshQuests` reads them. The whole tree is
 * signed afresh off the thread and waited for when that can't be
 * enough: for an action `across` other quests than it names (a rank
 * among siblings, a parent's cycle check), a document id the last walk
 * holds in no quest, a tree never signed, a journal of writes that
 * started afresh since the last signing, so other processes' writes
 * between can't be known, and a last signing older than `staleAfter`:
 * `STALE_AFTER_MS`, or `SIGN_AGAIN_JOURNALED_AFTER_MS` where the
 * journal reads on since it, so an action after an idle spell never
 * acts on one.
 * Throws as `discoverQuestsAfresh` does when the disk gives no answer,
 * and once `signal` fires, leaving the signing to finish unheard.
 * Plain pi signs every ask already, so this does nothing there.
 */
export async function readyQuests(
	questsRoot: string,
	ids: Iterable<string | null | undefined>,
	across: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (!hosted()) return;
	held?.delete(questsRoot);
	const slot = memo().cache.get(questsRoot);
	const age = slot ? Date.now() - slot.signedAt : -1;
	const recent = age >= 0 && age <= staleAfter(slot);
	const named =
		slot && recent && !across
			? questsNamed(questsRoot, slot.result, ids)
			: undefined;
	// Read before the catching up, which reads on past what it missed. A
	// journal that started afresh within `STALE_AFTER_MS` of the last
	// signing is caught up on the thread instead, as with no journal, so
	// one that keeps starting afresh can't have every action sign whole.
	const missed =
		slot?.journal !== undefined &&
		journaledSince(questsRoot, slot) === "started afresh" &&
		signedLongAgo(slot, STALE_AFTER_MS);
	if (slot && named && !missed && caughtUp(questsRoot, slot, named)) return;
	await untilStopped(discoverQuestsAfresh(questsRoot), signal);
}

/** `work`, or its rejection, unless `signal` fires first, then its reason. */
function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) {
		// Nobody hears it now, so it is caught here rather than end pi.
		work.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const stop = (): void => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", stop);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", stop);
				reject(error);
			},
		);
	});
}

/**
 * Whether this process holds a walk of `questsRoot` to answer from,
 * however old: on a host, one with none signs it whole at its first
 * synchronous ask. Plain pi signs every ask, so it always has one.
 */
export function questsWalked(questsRoot: string): boolean {
	return !hosted() || memo().cache.has(questsRoot);
}

/** Whether `error` is a signing the disk gave no answer to in time. */
export function signingGaveUp(error: unknown): error is Error {
	return error instanceof Error && error.message === SIGNING_GAVE_UP;
}

/**
 * The root entries `ids` name: a quest's folder as the last walk found
 * it, else its id, for one made since; a document's quest's folder.
 * Undefined when a document id is in no quest the last walk found,
 * since only a whole signing can say where it sits now.
 */
function questsNamed(
	questsRoot: string,
	result: DiscoveryResult,
	ids: Iterable<string | null | undefined>,
): Set<string> | undefined {
	const named = new Set<string>();
	const asked = new Set<string>();
	const folderOf = (dir: string) => entryUnder(questsRoot, dir);
	for (const id of ids) {
		if (typeof id !== "string" || !isId(id)) continue;
		if (prefixOf(id) !== "QEST") asked.add(`${id}.md`);
		else {
			const dir = result.index.quests.get(id)?.dir;
			named.add((dir && folderOf(dir)) || id);
		}
	}
	for (const entry of result.index.quests.values()) {
		if (asked.size === 0) break;
		for (const document of entry.documents) {
			const file = basename(document.path);
			if (!asked.delete(file)) continue;
			const folder = folderOf(entry.dir);
			if (folder) named.add(folder);
		}
	}
	return asked.size > 0 ? undefined : named;
}

/**
 * Walk `questsRoot` as it stands now, signed off the thread on a host
 * and waited for, for work that can wait: the desktop's lists, written
 * only from a walk signed after the change that asked for them, and
 * brought up to date for this process's own writes since. A signing
 * dropped for a newer one, or one a write since can't be placed in, is
 * made again off the thread, up to `AFRESH_TRIES` times; after that the
 * newest walk answers, a write behind at most, and the journal says so.
 * Only a tree no signing could walk is signed on the thread, as a
 * missing folder is, cheaply. One that gives up on the disk throws,
 * since signing it on the thread would hold every conversation on that
 * same disk. Plain pi signs it on the thread, as every ask.
 */
export async function discoverQuestsAfresh(
	questsRoot: string,
): Promise<DiscoveryResult> {
	if (!hosted()) return discoverQuestsSigned(questsRoot, {});
	for (let tries = 0; tries < AFRESH_TRIES; tries++) {
		const asked = Date.now();
		const before = await discoverySettled(questsRoot);
		if (before === "gave up") throw new Error(SIGNING_GAVE_UP);
		const ended = await signOffThread(questsRoot);
		if (ended === "gave up") throw new Error(SIGNING_GAVE_UP);
		const slot = memo().cache.get(questsRoot);
		const found = slot && slot.signedAt >= asked;
		// A write since that can't be placed is read only by another signing.
		const placed = found && questsWrittenSince(slot.writes) !== undefined;
		const current = placed ? caughtUp(questsRoot, slot, new Set()) : undefined;
		if (current) return current;
	}
	const slot = memo().cache.get(questsRoot);
	const newest = slot && caughtUp(questsRoot, slot, new Set());
	if (!newest) return discoverQuestsSigned(questsRoot, {});
	sayOnHost(
		`${AFRESH_TRIES} signings of ${questsRoot} each missed a write or a newer signing, so the newest walk answers`,
	);
	return newest;
}

/** How often `discoverQuestsAfresh` signs off the thread before on it. */
const AFRESH_TRIES = 3;

const SIGNING_GAVE_UP = "the quest tree didn't answer a signing in time";

/**
 * How long a host answers a known tree from its last signing before an
 * ask starts signing it again off the thread. Another process's change
 * to a quest shows by the end of the signing the next ask past this
 * starts, however long the tree sat unasked; a change this process
 * made through the workflow, and a quest made, removed or given its
 * README, show at once, read quest by quest (`caughtUp`).
 */
const SIGN_AGAIN_AFTER_MS = 5_000;

/**
 * How old a host's last signing may be for an action to act on it, the
 * quests it names read again: past this, `readyQuests` waits on a whole
 * signing off the thread, so a change made while a host sat idle is
 * never acted on late. An ask that can't wait answers the older walk
 * while that signing runs.
 */
const STALE_AFTER_MS = 60_000;

/**
 * How long a host answers a known tree from its last signing, read on
 * since through the account's journal of quest writes, before an ask
 * signs it whole again, for an action and a plain ask alike. The
 * journal names every quest the workflow's writes and a session's
 * write and edit tools touch, in any process, so the signing is left
 * only for what it misses: a file changed by hand or through bash, or
 * by code from before the journal, which a restart ends.
 *
 * On 21 November about eighty processes each signed the same 1,543
 * quests every `SIGN_AGAIN_AFTER_MS` to see each other's writes, and
 * thirteen signings in half an hour outlasted their 30 s give-up.
 */
const SIGN_AGAIN_JOURNALED_AFTER_MS = 5 * 60_000;

/** How old `slot` may be before an ask signs its tree again. */
function signAgainAfter(slot: CacheSlot): number {
	return slot.journal ? SIGN_AGAIN_JOURNALED_AFTER_MS : SIGN_AGAIN_AFTER_MS;
}

/**
 * Whether `slot` was signed more than `limitMs` ago, or at a time a
 * clock stepped back since, which no limit bounds.
 */
function signedLongAgo(
	slot: CacheSlot,
	limitMs = SIGN_AGAIN_AFTER_MS,
): boolean {
	const age = Date.now() - slot.signedAt;
	return age < 0 || age > limitMs;
}

/** How old `slot` may be for an action to act on it, read on since. */
function staleAfter(slot: CacheSlot | undefined): number {
	return slot?.journal ? SIGN_AGAIN_JOURNALED_AFTER_MS : STALE_AFTER_MS;
}

/**
 * Where the account's journal of quest writes stands as a signing
 * begins, for a host; undefined for plain pi, which signs every ask,
 * and where there is no journal.
 */
function journalMark(): JournalMark | undefined {
	if (!hosted()) return undefined;
	const file = questJournal();
	return file === undefined ? undefined : journalNow(file);
}

/**
 * The most quests a read of the journal brings up to date on the thread.
 * More than this since the last read, as after a host sat busy while
 * a sweep wrote hundreds, is read by a whole signing off the thread.
 * Each quest it names is read whole on the thread every conversation
 * shares, so this bounds that stretch; past it, the cost moves to one
 * signing off the thread, which a busy stretch can afford.
 */
const JOURNALED_MOST_QUESTS = 64;

/**
 * The root entries of `questsRoot` the journal names since `slot`'s
 * mark, with the mark to read on from; "started afresh" when what came
 * between can't be known or names more than `JOURNALED_MOST_QUESTS`,
 * and undefined where `slot` reads no journal.
 */
function journaledSince(
	questsRoot: string,
	slot: CacheSlot,
):
	| { readonly names: ReadonlySet<string>; readonly mark: JournalMark }
	| "started afresh"
	| undefined {
	if (!slot.journal) return undefined;
	const file = questJournal();
	// A journal gone since the mark can't say what it missed.
	if (file === undefined) return "started afresh";
	const read = journalSince(file, slot.journal);
	if (read === "started afresh") return read;
	const names = new Set<string>();
	for (const dir of read.dirs) {
		const name = entryUnder(questsRoot, dir);
		if (name) names.add(name);
	}
	if (names.size > JOURNALED_MOST_QUESTS) return "started afresh";
	return { names, mark: read.mark };
}

/**
 * How long an ask waits on a signing off the thread before it stops
 * waiting. The walk runs on, holding its root, and what it finds is
 * kept; a later ask waits on that same walk afresh.
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
 * a known tree is answered from its last signed walk, brought up to
 * date quest by quest (`caughtUp`), and signed again off the thread
 * once that walk is a few seconds old. It signs the whole tree on the
 * thread, as plain pi does, only for a tree it has never signed. A walk
 * it can't bring up to date quest by quest, as one kept by code from
 * before the root's names were, answers as it stands while a signing
 * off the thread reads the tree.
 *
 * On 20 November a signing on the thread for this process's own write
 * held the background host for 6.1 s over 1,495 quests, under
 * `writeQuestWeights`; with sixty conversations writing, one wrote
 * between nearly every two asks.
 */
function discoverQuestsHosted(
	questsRoot: string,
	seed: SeedOptions,
): DiscoveryResult {
	const slot = memo().cache.get(questsRoot);
	if (!slot) return discoverQuestsSigned(questsRoot, seed);
	const result = caughtUp(questsRoot, slot, new Set());
	// A clock stepped back gives a negative age, which no limit bounds.
	const age = Date.now() - slot.signedAt;
	const old = age < 0 || age > signAgainAfter(slot);
	if (!result || old) void startSigning(questsRoot);
	return result ?? slot.result;
}

/**
 * `slot`'s walk brought up to now, kept as the root's slot, reading on
 * the thread only the quests that changed under it: each this process
 * wrote since (`questsWrittenSince`), each named in `named`, each the
 * root gained, lost or changed in kind since its stat last vouched, and
 * each found with no README whose stamp moved. A write since that can't
 * be placed starts a signing off the thread, which reads it. Undefined
 * when the root can't be listed or the slot kept no names for it, so
 * the caller leaves the tree to a signing off the thread.
 * The quests named are noted as read now, so a signing begun before
 * reads them again (`startSigning`).
 */
function caughtUp(
	questsRoot: string,
	slot: CacheSlot,
	named: ReadonlySet<string>,
): DiscoveryResult | undefined {
	const writes = questWritesMade();
	const written = questsWrittenSince(slot.writes);
	// A write that can't be placed is read by a signing off the thread,
	// begun after it; the quests named are read again here meanwhile.
	if (!written) {
		sayUnplaced();
		void startSigning(questsRoot);
	}
	const names = new Set([...named, ...(written ?? [])]);
	// Other processes' writes, by the journal; one that started afresh
	// is read by a signing whose mark starts it again, begun no sooner
	// than `SIGN_AGAIN_AFTER_MS` after the last, so a journal that keeps
	// starting afresh costs what no journal costs and no more.
	const journaled = journaledSince(questsRoot, slot);
	if (journaled === "started afresh" && signedLongAgo(slot)) {
		void startSigning(questsRoot);
	}
	const readOn = journaled !== undefined && journaled !== "started afresh";
	if (readOn) for (const name of journaled.names) names.add(name);
	const journal = readOn ? journaled.mark : slot.journal;
	const pass = newPass();
	const rootStamp = folderStampOf(questsRoot);
	let { rootNames } = slot;
	let rootListed = false;
	if (rootStamp === undefined || rootStamp !== slot.rootStamp) {
		const listed = readEntries(questsRoot, pass);
		if (!rootNames || !listed) return undefined;
		rootListed = true;
		const now = namesOf(listed);
		const moved = movedNames(rootNames, now);
		for (const name of moved) names.add(name);
		// The same names under a stamp that vouched and moved: a folder
		// removed and put back, which only a signing reads, off the thread.
		// A root that never settled is read so at each signing already.
		const putBack = moved.size === 0 && slot.rootStamp !== undefined;
		if (putBack) void startSigning(questsRoot);
		rootNames = now;
	}
	for (const [dir, stamp] of slot.pending) {
		if (stamp === undefined || stamp !== pendingStampOf(dir)) {
			names.add(basename(dir));
		}
	}
	const unmoved = rootStamp === slot.rootStamp && rootNames === slot.rootNames;
	if (names.size === 0 && writes === slot.writes && unmoved) {
		if (journal !== slot.journal) {
			memo().cache.set(questsRoot, { ...slot, journal });
		}
		return slot.result;
	}
	const found = names.size > 0 ? walkNamed(questsRoot, names, pass) : undefined;
	// A root that lists again with no quest to read still sheds its fault.
	const result =
		found || rootListed
			? merged(questsRoot, slot.result, names, found ?? NOTHING, rootListed)
			: slot.result;
	const pending = new Map(
		[...slot.pending].filter(([dir]) => !names.has(basename(dir))),
	);
	for (const [dir, stamp] of pendingOf(result, names)) pending.set(dir, stamp);
	const read = new Map(slot.read);
	const at = Date.now();
	for (const name of named) read.set(name, at);
	memo().cache.set(questsRoot, {
		...slot,
		// Never a tree's signature once the walk changed, by a quest read
		// again or a root's fault shed, so the next signing builds its walk
		// anew rather than taking this one for the tree it signed; kept
		// while the walk is the same.
		signature: result === slot.result ? slot.signature : CAUGHT_UP,
		result,
		writes,
		rootStamp,
		rootNames,
		pending,
		read,
		journal,
	});
	return result;
}

/** The signature of a walk brought up to date quest by quest. */
const CAUGHT_UP = "caught up";

/** A walk that found nothing, for a merge that replaces no entry. */
const NOTHING: DiscoveryResult = {
	index: { quests: new Map(), children: new Map() },
	errors: [],
};

/** Whether this process has said it can't place a write. */
let saidUnplaced = false;

/**
 * Say once on stderr, a host's journal, that a write this process made
 * can't be placed in a quest, so the tree is signed whole off the
 * thread for it: a conversation running code from before the write log,
 * which a restart ends and a reload doesn't, or more writes since a
 * tree's last ask than the log keeps, as a store asked rarely sees.
 */
function sayUnplaced(): void {
	if (saidUnplaced || !hosted()) return;
	saidUnplaced = true;
	process.stderr.write(
		"[quest-workflow] a quest write can't be placed, so the tree is " +
			"signed whole off the thread: code from before the write log, " +
			"which a restart ends, or more writes since its last ask than " +
			"the log keeps\n",
	);
}

/**
 * Resolves once the signing of `questsRoot` under way off the thread,
 * if any, has ended; at once when none is.
 */
export function discoverySettled(
	questsRoot: string,
): Promise<SigningEnd | undefined> {
	const walk = memo().signing.get(questsRoot);
	return walk ? waitOnSigning(questsRoot, walk) : Promise.resolve(undefined);
}

/**
 * Sign `questsRoot` off the thread and wait on it, giving up after
 * `SIGNING_GIVES_UP_MS`: the walk under way, when there is one, else a
 * new one.
 */
function signOffThread(questsRoot: string): Promise<SigningEnd | undefined> {
	return waitOnSigning(questsRoot, startSigning(questsRoot));
}

/**
 * Wait on `walk` for at most `SIGNING_GIVES_UP_MS`. Each wait has its
 * own clock, so an ask after another gave up waits on the walk too,
 * and hears what it found if it ends in time, rather than being told
 * at once that the earlier ask gave up.
 */
function waitOnSigning(
	questsRoot: string,
	walk: Promise<SigningEnd | undefined>,
): Promise<SigningEnd | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const givenUp = new Promise<SigningEnd>((resolve) => {
		// Not a wait for something to happen: a ceiling on a disk that hangs.
		timer = setTimeout(() => {
			sayOnHost(
				`a wait on signing ${questsRoot} gave up after ${SIGNING_GIVES_UP_MS} ms`,
			);
			resolve("gave up");
		}, SIGNING_GIVES_UP_MS);
		timer.unref();
	});
	return Promise.race([walk, givenUp]).finally(() => clearTimeout(timer));
}

/**
 * Sign `questsRoot` off the thread, one signing a root at a time, and
 * keep what it found unless the memo was let go or a signing begun
 * later already answered. What this process wrote meanwhile, and each
 * quest read on its own since the signing began, is read again quest by
 * quest (`caughtUp`): the writes at the next ask, the quests read at
 * once. An unchanged tree keeps its walk; a changed one is walked again
 * on the thread, from memory. The walk holds its root until it ends, however
 * long its asks waited, or until `SIGNING_HUNG_AFTER_MS` says its disk
 * hangs, so no second walk starts beside a slow one. Answers the walk,
 * which nothing bounds: wait on it through `waitOnSigning`.
 */
function startSigning(questsRoot: string): Promise<SigningEnd | undefined> {
	const m = memo();
	const under = m.signing.get(questsRoot);
	if (under) return under;
	const signedAt = Date.now();
	const writes = questWritesMade();
	const journal = journalMark();
	// A fresh memo's first walk parses from the last process's seed, as a
	// walk on the thread does, rather than every quest anew.
	const seeds = seedsOf({});
	if (seeds) takeSeed(questsRoot, seeds.dir, seeds.code);
	const work = (async (): Promise<SigningEnd> => {
		const read = await readTreeOffThread(questsRoot, SIGNING_HUNG_AFTER_MS);
		if (!read || memo() !== m) return "dropped";
		const { pass, rootStamp } = read;
		const cached = m.cache.get(questsRoot);
		if (cached && cached.signedAt > signedAt) return "dropped";
		read.keep();
		const signature = discoverySignature(questsRoot, pass);
		const result =
			cached && cached.signature === signature
				? cached.result
				: discoverQuestsUncached(questsRoot, pass);
		const slot = slotOf(
			signature,
			result,
			{ signedAt, writes, rootStamp, journal },
			pass,
			questsRoot,
		);
		m.cache.set(questsRoot, slot);
		if (seeds && pass.parses >= SEED_AFTER_PARSES) {
			leaveSeed(questsRoot, seeds.dir, seeds.code);
		}
		const since = readSince(cached, signedAt);
		if (since.size > 0) caughtUp(questsRoot, slot, since);
		return "kept";
	})().catch((error: unknown): SigningEnd => {
		// The last walk stands, and the next ask past its age signs again.
		// A thread still held in a read means the disk hangs, which a
		// signing on the host's own thread would hang on too.
		if (threadsHeld(error)) {
			sayOnHost(`signing ${questsRoot} off the thread gave up: ${error}`);
			return "gave up";
		}
		sayOnHost(`signing ${questsRoot} off the thread failed: ${error}`);
		return "failed";
	});
	// Only this walk's own hold: one freed as hung that ends later must
	// not free the walk that took its root since.
	const holds = () => m.signing.get(questsRoot) === work;
	// Not a wait for something to happen: the longest a hung walk keeps
	// others off its root.
	const hung = setTimeout(() => {
		if (!holds()) return;
		sayOnHost(
			`signing ${questsRoot} hadn't ended after ${SIGNING_HUNG_AFTER_MS} ms, so its disk is taken to hang and another may start`,
		);
		m.signing.delete(questsRoot);
	}, SIGNING_HUNG_AFTER_MS);
	hung.unref();
	void work.then((end) => {
		clearTimeout(hung);
		const took = Date.now() - signedAt;
		if (took > SIGNING_GIVES_UP_MS) {
			sayOnHost(
				`signing ${questsRoot} ended (${end}) after ${took} ms, past its give-up`,
			);
		}
		if (holds()) m.signing.delete(questsRoot);
	});
	m.signing.set(questsRoot, work);
	return work;
}

/** The quests `slot` read on their own at or after `at`. */
function readSince(slot: CacheSlot | undefined, at: number): Set<string> {
	const since = new Set<string>();
	for (const [name, when] of slot?.read ?? []) if (when >= at) since.add(name);
	return since;
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
	const journal = journalMark();
	const rootStamp = folderStampOf(questsRoot);
	const seeds = seedsOf(seed);
	if (seeds) takeSeed(questsRoot, seeds.dir, seeds.code);
	const signature = discoverySignature(questsRoot, pass);
	const { cache } = memo();
	const cached = cache.get(questsRoot);
	const stamps = { signedAt, writes, rootStamp, journal };
	if (cached && cached.signature === signature) {
		const slot = slotOf(signature, cached.result, stamps, pass, questsRoot);
		cache.set(questsRoot, slot);
		return cached.result;
	}
	const result = discoverQuestsUncached(questsRoot, pass);
	cache.set(questsRoot, slotOf(signature, result, stamps, pass, questsRoot));
	if (seeds && pass.parses >= (seed.after ?? SEED_AFTER_PARSES)) {
		leaveSeed(questsRoot, seeds.dir, seeds.code);
	}
	return result;
}

/** Where a walk's seeds are kept and the code they're for; none when `seed` turns them off. */
function seedsOf(
	seed: SeedOptions,
): { readonly dir: string; readonly code: string } | undefined {
	const dir = seed.dir === undefined ? cacheDir(SEED_FOLDER) : seed.dir;
	return dir ? { dir, code: seed.code ?? codeKey() } : undefined;
}

/**
 * What a signing knew as it began: when, the writes by then, the root's
 * stat, and where the journal of quest writes stood.
 */
interface SignedUnder {
	readonly signedAt: number;
	readonly writes: number;
	readonly rootStamp: string | undefined;
	readonly journal: JournalMark | undefined;
}

/**
 * A cache slot for a walk of `questsRoot` signed under `under`, with
 * what `pass` listed of the root and the stamp of each quest folder it
 * found with no README (`pendingStampOf`): one being made, whose README
 * lands inside its folder without touching the root's stat. Off the
 * thread, `pass` holds each taken before the read.
 */
function slotOf(
	signature: string,
	result: DiscoveryResult,
	under: SignedUnder,
	pass: Pass,
	questsRoot: string,
): CacheSlot {
	const pending = new Map<string, string | undefined>();
	for (const error of result.errors) {
		if (error.message !== README_MISSING) continue;
		const dir = dirname(error.path);
		// Off the thread, the stamp taken before the folder was read.
		const before = pass.pending.has(dir);
		pending.set(dir, before ? pass.pending.get(dir) : pendingStampOf(dir));
	}
	return {
		signature,
		result,
		...under,
		pending,
		rootNames: rootNamesOf(pass, questsRoot, result),
		read: new Map(),
	};
}

/**
 * The names `pass` listed in `questsRoot`: none when its listing failed
 * and the walk found no quest, as for a root not made yet, so each quest
 * it gains is read by name rather than the whole tree signed on the
 * thread. Undefined only when `pass` never listed it.
 */
function rootNamesOf(
	pass: Pass,
	questsRoot: string,
	result: DiscoveryResult,
): ReadonlyMap<string, string> | undefined {
	const listed = pass.listings.get(questsRoot);
	if (listed) return namesOf(listed);
	const missing = pass.listings.has(questsRoot);
	return missing && result.index.quests.size === 0 ? new Map() : undefined;
}
