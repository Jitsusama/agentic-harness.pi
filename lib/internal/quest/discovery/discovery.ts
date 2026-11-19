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

import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { hosted } from "../../../core/session/host.ts";
import type { QuestDoc, QuestDocumentDoc } from "../../../quest/types.ts";
import { cacheDir, stateDir } from "../../paths.ts";
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
	type WalkWait,
} from "./discovery-reads.ts";
import {
	folderStampOf,
	pendingStampOf,
	readTreeOffThread,
	threadsLetGo,
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
 * On a host, sign the tree now on the thread, so the asks that follow
 * in the next few seconds answer as it stands: a session does it as it
 * starts. Held back (`holdsBack`), it signs nothing and the asks answer
 * from the last walk, not even this process's own writes, which is why
 * one whose reads decide what it writes waits with `signQuestsSettled`
 * instead. Plain pi signs every ask already, so this does nothing there.
 */
export function signQuestsNow(questsRoot: string): void {
	if (hosted() && !holdsBack(questsRoot)) discoverQuestsSigned(questsRoot, {});
}

/**
 * Whether a host answers `questsRoot` from its last walk, however old,
 * rather than signing it on the thread (`holdsBack`): a walk of it is
 * under way, a thread let go still hangs, or the person paused signing.
 * False in plain pi, which signs every ask.
 */
export function signingHeldBack(questsRoot: string): boolean {
	return hosted() !== undefined && holdsBack(questsRoot);
}

/**
 * `signQuestsNow` for a caller that can wait, as the quest tool before
 * each action, whose reads decide what it writes: where a walk is under
 * way, it walks again once that ends, and this resolves once that walk
 * is kept, `SIGNING_GIVES_UP_MS` on, or when `signal` aborts, so the
 * action reads the tree as it stood after it asked unless the disk
 * hangs. Paused, or on a disk a thread let go still hangs on, it
 * resolves at once and the action reads the last walk.
 */
export async function signQuestsSettled(
	questsRoot: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!hosted()) return;
	if (!holdsBack(questsRoot)) {
		discoverQuestsSigned(questsRoot, {});
		return;
	}
	if (signingPaused() || !memo().signing.has(questsRoot)) return;
	if (signal?.aborted) return;
	let stop: (() => void) | undefined;
	const aborted = new Promise<void>((resolve) => {
		stop = resolve;
		signal?.addEventListener("abort", stop, { once: true });
	});
	try {
		await Promise.race([walkSince(questsRoot), aborted]);
	} finally {
		if (stop) signal?.removeEventListener("abort", stop);
	}
}

/**
 * Walk `questsRoot` as it stands now, signed off the thread on a host
 * and waited for, for work that can wait: the desktop's lists, written
 * only from a walk begun after the change that asked for them, however
 * many writes this process made during it. One dropped or failed is
 * asked for again off the thread, and after `AFRESH_TRIES` on it. One
 * that gives up on the disk throws, since signing it on the thread
 * would hold every conversation on that same disk, as does one paused,
 * or held back (`holdsBack`) once the tries are spent. Plain pi signs
 * it on the thread, as every ask.
 */
export async function discoverQuestsAfresh(
	questsRoot: string,
): Promise<DiscoveryResult> {
	if (!hosted()) return discoverQuestsSigned(questsRoot, {});
	// Paused, or on a disk a thread still hangs on, no walk is to be had.
	if (signingPaused()) throw new Error(pausedBy());
	if (threadsLetGo().length > 0) throw new Error(SIGNING_GAVE_UP);
	for (let tries = 0; tries < AFRESH_TRIES; tries++) {
		const heard = await walkSince(questsRoot);
		if (typeof heard !== "string") return heard;
		if (heard === "gave up") throw new Error(SIGNING_GAVE_UP);
		if (heard === "paused") throw new Error(pausedBy());
	}
	// Held back, the thread is the one place left, and the reason not to.
	if (holdsBack(questsRoot)) throw new Error(SIGNING_GAVE_UP);
	return discoverQuestsSigned(questsRoot, {});
}

/** How often `discoverQuestsAfresh` signs off the thread before on it. */
const AFRESH_TRIES = 3;

const SIGNING_GAVE_UP = "the quest tree didn't answer a signing in time";

/** What an ask that wants a walk is told while the person pauses them. */
function pausedBy(): string {
	return `signing is paused by ${signingPausedPath()}`;
}

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
 * How long past `SIGNING_HUNG_AFTER_MS` a signing holds its root: its
 * thread's wall is that long from the same start, so the thread is let
 * go, and counted in `threadsLetGo`, before another walk may begin.
 */
const HUNG_MARGIN_MS = 10_000;

/** How often a host says a thread let go still holds its signing back. */
const HELD_BACK_SAID_EVERY_MS = 60_000;

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
	const back = holdsBack(questsRoot);
	if (!slot || !stands(questsRoot, slot, back)) {
		return discoverQuestsSigned(questsRoot, seed);
	}
	if (Date.now() - slot.signedAt <= SIGN_AGAIN_AFTER_MS) return slot.result;
	if (threadsLetGo().length > 0) sayHeldBack(questsRoot);
	else if (!signingPaused()) void startSigning(questsRoot);
	return slot.result;
}

/**
 * Say, at most every `HELD_BACK_SAID_EVERY_MS`, that a thread let go
 * at its wall holds `questsRoot`'s signing back: every root's, since
 * which disk it hangs on isn't known, until the thread stops.
 */
function sayHeldBack(questsRoot: string): void {
	const m = memo();
	const now = Date.now();
	const said = m.heldBackSaidAt;
	if (
		said !== undefined &&
		now - said >= 0 &&
		now - said < HELD_BACK_SAID_EVERY_MS
	)
		return;
	m.heldBackSaidAt = now;
	sayOnHost(
		`signing ${questsRoot} is held back by a thread let go on a disk that hung, so each ask answers from the last walk until that thread stops, which the host says`,
	);
}

/**
 * Whether a host holds back from walking `questsRoot` on its thread:
 * while a walk of it is under way, which walks again at once for this
 * process's writes; while a thread let go at its wall hasn't stopped,
 * since its disk still hangs; and while the person has paused signing.
 * Each would hold every conversation for a walk already coming, or one
 * on a disk that hangs, or one the person stopped, so the last walk
 * answers however old, past this process's own writes too.
 */
function holdsBack(questsRoot: string): boolean {
	return (
		memo().signing.has(questsRoot) ||
		threadsLetGo().length > 0 ||
		signingPaused()
	);
}

/**
 * Whether the person paused signing off the thread on hosts, by a file
 * at `SIGNING_PAUSED`: read again at most every `SIGN_AGAIN_AFTER_MS`.
 */
function signingPaused(): boolean {
	const m = memo();
	const now = Date.now();
	const read = m.paused;
	if (
		read &&
		now - read.readAt >= 0 &&
		now - read.readAt <= SIGN_AGAIN_AFTER_MS
	) {
		return read.is;
	}
	const is = existsSync(signingPausedPath());
	if (is !== (read?.is ?? false)) {
		sayOnHost(
			is
				? `signing is paused by ${signingPausedPath()}, so each ask answers from the last walk`
				: "signing resumed",
		);
	}
	m.paused = { is, readAt: now };
	return is;
}

/** Where the file that pauses signing off the thread is put. */
export function signingPausedPath(): string {
	return join(stateDir("quest-workflow"), SIGNING_PAUSED);
}

/**
 * The file that pauses signing on every host while it is there: a host
 * then answers from its last walk however old, its own writes too, ends
 * a signing walking again at its next pass, and walks on its thread
 * only for a quest made, removed or given its README, or a tree it has
 * never walked; an action's ask answers at once rather than waiting.
 */
const SIGNING_PAUSED = "signing-paused";

/**
 * Whether a host may answer from its last walk: no quest written by
 * this process since and signed within the minute, unless it `holds
 * back` (`holdsBack`), and the stats of the root and of each folder it
 * found with no README both settled when taken and unchanged since, so
 * no quest was made, removed or given its README meanwhile.
 */
function stands(
	questsRoot: string,
	slot: CacheSlot,
	holdsBack: boolean,
): boolean {
	if (!holdsBack && slot.writes !== questWritesMade()) return false;
	// A clock stepped back gives a negative age, which no limit bounds.
	const age = Date.now() - slot.signedAt;
	if (age < 0 || (!holdsBack && age > STALE_AFTER_MS)) return false;
	// A stat on a disk a thread let go still hangs on would hold the
	// thread as long, so the last walk stands unchecked until it stops.
	if (threadsLetGo().length > 0) return true;
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
	const walk = memo().signing.get(questsRoot);
	return walk ? waitOnSigning(questsRoot, walk) : Promise.resolve(undefined);
}

/**
 * Wait, for at most `SIGNING_GIVES_UP_MS`, on a walk of `questsRoot`
 * off the thread begun after this ask: the one after the walk under
 * way, woken from its rest if it rests, or a new signing when none
 * runs. Answers what that walk found, or how the signing ended without
 * one.
 */
function walkSince(questsRoot: string): Promise<DiscoveryResult | SigningEnd> {
	const m = memo();
	let wait: WalkWait | undefined;
	const heard = new Promise<DiscoveryResult | SigningEnd>((resolve) => {
		wait = { after: m.begun ?? 0, heard: resolve };
	});
	const waits = waitsOn(m, questsRoot);
	if (wait) waits.add(wait);
	if (m.signing.has(questsRoot)) {
		m.again ??= new Set();
		m.again.add(questsRoot);
		m.wake?.get(questsRoot)?.();
	} else {
		void startSigning(questsRoot);
	}
	return waitOnSigning(questsRoot, heard).finally(() => {
		if (wait) waits.delete(wait);
	});
}

/** The asks waiting on a walk of `questsRoot`, made on first use. */
function waitsOn(m: ReturnType<typeof memo>, questsRoot: string) {
	m.waiting ??= new Map();
	let waits = m.waiting.get(questsRoot);
	if (!waits) {
		waits = new Set();
		m.waiting.set(questsRoot, waits);
	}
	return waits;
}

/**
 * Tell the asks waiting on `questsRoot` that walk number `begun`
 * answered `heard`: those made before it began, or every one when
 * `heard` says how the signing ended.
 */
function tellWaits(
	m: ReturnType<typeof memo>,
	questsRoot: string,
	begun: number,
	heard: DiscoveryResult | SigningEnd,
): void {
	const waits = m.waiting?.get(questsRoot);
	if (!waits) return;
	for (const wait of [...waits]) {
		if (typeof heard === "string" || wait.after < begun) {
			waits.delete(wait);
			wait.heard(heard);
		}
	}
}

/**
 * Rest until `SIGN_AGAIN_AFTER_MS` past `began`, when a walk last
 * began, unless an ask wakes it sooner: a host whose conversations
 * write all the time walks once every few seconds, not back to back.
 */
function rest(
	m: ReturnType<typeof memo>,
	questsRoot: string,
	began: number,
): Promise<void> {
	// Capped, since a clock stepped back would make the rest unbounded.
	const left = Math.min(
		began + SIGN_AGAIN_AFTER_MS - Date.now(),
		SIGN_AGAIN_AFTER_MS,
	);
	if (left <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const woken = () => {
			clearTimeout(timer);
			m.wake?.delete(questsRoot);
			resolve();
		};
		// Not a wait for something to happen: the pace of walks.
		const timer = setTimeout(woken, left);
		timer.unref();
		m.wake ??= new Map();
		m.wake.set(questsRoot, woken);
	});
}

/**
 * Wait on `walk` for at most `SIGNING_GIVES_UP_MS`. Each wait has its
 * own clock, so an ask after another gave up waits on the walk too,
 * and hears what it found if it ends in time, rather than being told
 * at once that the earlier ask gave up.
 */
function waitOnSigning<T>(
	questsRoot: string,
	walk: Promise<T>,
): Promise<T | "gave up"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const givenUp = new Promise<"gave up">((resolve) => {
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
 * keep what each walk found unless the memo was let go or a signing
 * begun later already answered, and tell the asks waiting on a walk
 * begun after them (`walkSince`). One this process wrote a quest during
 * is kept as of the writes it began after and walked again once
 * `SIGN_AGAIN_AFTER_MS` past its start, and one an ask wants during at
 * once, until one ends with neither or the person pauses signing: a
 * host whose conversations write all the time otherwise dropped every
 * walk and signed on its thread at every ask (13:40 to 13:48, 18 Nov),
 * and walked back to back once it kept them. An unchanged tree keeps
 * its walk; a changed one is walked again on the thread, from memory.
 * The signing holds its root until it ends, however long its asks
 * waited, or until `SIGNING_HUNG_AFTER_MS` and `HUNG_MARGIN_MS` past
 * its latest walk's start say its disk hangs, so no second walk starts
 * beside a slow one. Answers the signing, which nothing bounds: wait on
 * it through `waitOnSigning`.
 */
function startSigning(questsRoot: string): Promise<SigningEnd | undefined> {
	const m = memo();
	const under = m.signing.get(questsRoot);
	if (under) return under;
	const started = Date.now();
	let hung: ReturnType<typeof setTimeout> | undefined;
	// Only this signing's own hold: one freed as hung that ends later
	// must not free the signing that took its root since.
	const holds = () => m.signing.get(questsRoot) === work;
	// Not a wait for something to happen: the longest a hung walk keeps
	// others off its root, from each walk's start, as its thread's wall.
	const holdFor = () => {
		clearTimeout(hung);
		hung = setTimeout(() => {
			if (!holds()) return;
			sayOnHost(
				`signing ${questsRoot} hadn't ended after ${SIGNING_HUNG_AFTER_MS + HUNG_MARGIN_MS} ms, so its disk is taken to hang and another may start`,
			);
			m.signing.delete(questsRoot);
		}, SIGNING_HUNG_AFTER_MS + HUNG_MARGIN_MS);
		hung.unref();
	};
	let walks = 0;
	let longest = 0;
	const work = (async (): Promise<SigningEnd> => {
		let asked = true;
		let lastBegan = 0;
		for (;;) {
			if (walks > 0) {
				if (!asked) await rest(m, questsRoot, lastBegan);
				if (signingPaused()) return "paused";
				if (memo() !== m) return "dropped";
			}
			const signedAt = Date.now();
			lastBegan = signedAt;
			const writes = questWritesMade();
			const begun = (m.begun ?? 0) + 1;
			m.begun = begun;
			// This walk answers every ask made before it began, one that
			// woke its rest too, so only an ask during it walks again.
			m.again?.delete(questsRoot);
			walks += 1;
			holdFor();
			const { pass, rootStamp } = await readTreeOffThread(
				questsRoot,
				SIGNING_HUNG_AFTER_MS,
			);
			longest = Math.max(longest, Date.now() - signedAt);
			if (memo() !== m) return "dropped";
			const cached = m.cache.get(questsRoot);
			if (cached && cached.signedAt > signedAt) {
				// Signed on the thread since this walk began, so it answers too.
				tellWaits(m, questsRoot, begun, cached.result);
				return "dropped";
			}
			const signature = discoverySignature(questsRoot, pass);
			const result =
				cached && cached.signature === signature
					? cached.result
					: discoverQuestsUncached(questsRoot, pass);
			// Kept as of the writes it began after, so a write made during it
			// still asks for the walk that follows.
			m.cache.set(
				questsRoot,
				slotOf(signature, result, { signedAt, writes, rootStamp }, pass),
			);
			tellWaits(m, questsRoot, begun, result);
			asked = m.again?.delete(questsRoot) ?? false;
			if (questWritesMade() === writes && !asked) return "kept";
		}
	})().catch((error: unknown): SigningEnd => {
		// The last walk stands, and the next ask past its age signs again.
		sayOnHost(`signing ${questsRoot} off the thread failed: ${error}`);
		return "failed";
	});
	void work.then((end) => {
		clearTimeout(hung);
		const took = Date.now() - started;
		if (took > SIGNING_GIVES_UP_MS) {
			sayOnHost(
				`signing ${questsRoot} ended (${end}) after ${took} ms, past its give-up: ${walks} walks, the longest ${longest} ms`,
			);
		}
		if (!holds()) return;
		m.signing.delete(questsRoot);
		m.wake?.delete(questsRoot);
		// Asked for between the walk's last look and here: walk for it.
		const asked = m.again?.delete(questsRoot) ?? false;
		if (asked && end === "kept") {
			void startSigning(questsRoot);
			return;
		}
		// An end, not a result: every wait hears it.
		tellWaits(m, questsRoot, 0, end);
	});
	m.signing.set(questsRoot, work);
	return work;
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
