/**
 * A hosted conversation holds in memory only what a rollover would keep
 * of its log: the entries from its last compaction's first kept entry on,
 * and the state from before it (rollover.ts's `keptView`). Its file and
 * session id stay as they are; everything else stays on disk.
 *
 * pi holds every entry of a log for as long as its session runs, so a
 * child with a 98.6 MB log held 142 MB of heap where the view holds 30
 * (126 MB against 14 over a bare session's): the model never sees the
 * rest again. Rollover gives that back by moving to a fresh log, but a
 * fresh log is a new session id, and a child's id names its roster
 * entry, socket, store, parking marks and mesh address. So the child
 * keeps its log and holds the rollover's view of it instead, never
 * writing that view.
 *
 * Just before the first kept entry the view holds a rollover record that
 * is never written. It names this same file as the parent, so
 * session_recall reads exactly what the view left out (recall-on-disk),
 * and it carries the spend of the turns left out, so spend-workflow's
 * total reads as before. Usage entries, also never written, carry the
 * tokens and cost of every entry left out, so pi's footer and /session
 * totals read as before. Every id in the file stays taken, so pi never
 * gives a new entry an id an older one has.
 *
 * Whatever needs the whole tree has the whole log read back first:
 * /tree, a lookup or branch to an entry from before the last compaction,
 * forking, and any rewrite of the file, which would otherwise write the
 * view over it. Each such read is reported, since the memory comes back
 * with it until the next open. A conversation that switches to another
 * log, or starts a new one, lets go of the view. Any failure leaves pi's
 * own full open as it was.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	compactionHistory,
	FIRST_PROMPT_CARRY,
} from "../../lib/compaction/history.ts";
import {
	type Entry,
	keptView,
	ROLLOVER_RECORD,
	type RolloverRecord,
	recordIndex,
	rolledFrom,
} from "../../lib/internal/session/rollover.ts";
import {
	SPEND_CARRY,
	spentOnBranch,
} from "../../lib/internal/spend/session-spend.ts";

/** pi's session manager as the view reads and replaces it, privates included. */
export interface HeldManager {
	fileEntries: unknown[];
	byId: Map<string, unknown>;
	leafId: string | null;
	sessionId: string;
	sessionFile: string | undefined;
	flushed: boolean;
	_buildIndex(): void;
	_rewriteFile(): void;
	getBranch(): unknown[];
	getEntry(id: string): unknown;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	setSessionFile(path: string): void;
	getTree(): unknown;
	branch(id: string): void;
	branchWithSummary(id: string | null, ...rest: unknown[]): unknown;
	createBranchedSession(leafId: string): unknown;
	newSession(...rest: unknown[]): unknown;
}

/** The methods a held view answers itself, to read the whole log back first. */
const GUARDED = [
	"getEntry",
	"getTree",
	"branch",
	"branchWithSummary",
	"createBranchedSession",
	"_rewriteFile",
	"setSessionFile",
	"newSession",
] as const;

/** Whether `manager` still has every private the view reaches into. */
export function holdsLikePi(manager: unknown): manager is HeldManager {
	if (typeof manager !== "object" || manager === null) return false;
	const m = manager as Record<string, unknown>;
	return (
		Array.isArray(m.fileEntries) &&
		m.byId instanceof Map &&
		"leafId" in m &&
		typeof m.sessionId === "string" &&
		"sessionFile" in m &&
		typeof m.flushed === "boolean" &&
		typeof m._buildIndex === "function" &&
		typeof m._rewriteFile === "function" &&
		typeof m.getBranch === "function" &&
		typeof m.getSessionId === "function" &&
		typeof m.getSessionFile === "function" &&
		GUARDED.every((name) => typeof m[name] === "function")
	);
}

/** Whether this process has said that pi's session manager changed shape. */
let toldUnlikePi = false;

/** Says what to say, or the error that stopped something. */
type Report = (said: unknown) => void;

/**
 * Have `manager`, just opened by pi, hold only its log's kept view, and
 * answer it. It holds everything, as pi opened it, when its log has no
 * compaction to start from, when pi's privates are not what this reads
 * (said once a process), or when building the view fails (said each time).
 */
export function holdKeptHistory<M>(manager: M, report: Report = () => {}): M {
	if (!holdsLikePi(manager)) {
		if (!toldUnlikePi && typeof manager === "object" && manager !== null) {
			toldUnlikePi = true;
			report(
				"Kept history is off: pi's session manager no longer has the parts it reads, so every conversation holds its whole log",
			);
		}
		return manager;
	}
	const file = manager.getSessionFile();
	// Only a log already on disk: until then pi's first write is the whole log.
	if (!file || !manager.flushed) return manager;
	let held: Held | undefined;
	try {
		held = heldEntries(manager, file);
	} catch (error) {
		// Nothing was changed yet: pi's full open stands.
		report(heldWhole(manager, error));
		return manager;
	}
	if (!held) return manager;
	const original = manager.fileEntries;
	const leaf = manager.leafId;
	try {
		install(manager, file, held, report);
	} catch (error) {
		report(heldWhole(manager, error));
		restore(manager, original, leaf, file, report);
	}
	return manager;
}

/** What the journal says when `error` left `manager` holding its whole log. */
function heldWhole(manager: HeldManager, error: unknown): Error {
	const why = error instanceof Error ? error.message : String(error);
	return new Error(
		`Kept history couldn't hold conversation ${manager.sessionId}'s log, so it holds the whole log: ${why}`,
		{ cause: error },
	);
}

/** What a manager holds once it holds the kept view. */
interface Held {
	/** Its entries, header first. */
	readonly entries: unknown[];
	/** The ids held that need the whole log to branch to or from. */
	readonly dated: ReadonlySet<string>;
}

/**
 * The entries `manager` holds once it holds the kept view, or undefined
 * when its log has nothing to leave out, or a rollover record the view
 * would hide.
 */
function heldEntries(manager: HeldManager, file: string): Held | undefined {
	const branch = manager.getBranch() as Entry[];
	const view = keptView(branch);
	if (!view || view.from === 0) return undefined;
	// A rolled log's own record after the first kept entry would be read
	// in place of this one, its carried spend short of what lies between.
	if (recordIndex(branch) >= view.from) return undefined;
	const header = manager.fileEntries[0];
	if (!isHeader(header)) return undefined;
	const taken = new Set(manager.byId.keys());
	const firstKept = branch[view.from];
	const before = branch[view.from - 1];
	if (!firstKept || !before) return undefined;
	// A leaf the view leaves out, such as a label on an entry left on disk,
	// would have the next turn hang off the entry before it, forking the log.
	const leaf = branch[branch.length - 1];
	if (!view.entries.some((entry) => entry.id === leaf?.id)) return undefined;

	const left = branch.slice(0, view.from);
	// The turn that paid the session's first prompt is left on disk, so
	// the trigger reads that prompt from here.
	const { firstPromptTokens } = compactionHistory(left);
	const record: RolloverRecord = {
		parentSession: file,
		parentLeaf: before.id,
		dropped: view.dropped,
		carried: {
			...rolledFrom(left)?.carried,
			[SPEND_CARRY]: { spend: spentOnBranch(left) },
			...(firstPromptTokens === null
				? {}
				: { [FIRST_PROMPT_CARRY]: { firstPromptTokens } }),
		},
	};
	const at = view.entries.findIndex((entry) => entry.id === firstKept.id);
	if (at === -1) return undefined;
	const keptIds = new Set(view.entries.map((entry) => entry.id));
	const usage = usageLeftOut(manager.fileEntries, keptIds).map(
		(left): Entry => ({
			type: "usage",
			id: freshId(taken),
			parentId: null,
			timestamp: before.timestamp,
			kind: "kept-history",
			...left,
			note: "turns this conversation keeps on disk",
		}),
	);
	const recordEntry: Entry = {
		type: "custom",
		id: freshId(taken),
		parentId: null,
		timestamp: before.timestamp,
		customType: ROLLOVER_RECORD,
		data: record,
	};
	const ordered = [
		...view.entries.slice(0, at),
		...usage,
		recordEntry,
		...view.entries.slice(at),
	];
	const chained: Entry[] = [];
	let parentId: string | null = null;
	for (const entry of ordered) {
		chained.push(entry.parentId === parentId ? entry : { ...entry, parentId });
		parentId = entry.id;
	}

	// The context of an entry from before the last compaction starts at the
	// root, and the state before the first kept entry hangs off a false
	// parent: only from the compaction on does the view build what the
	// whole log builds.
	let compaction = branch.length - 1;
	while (compaction >= 0 && branch[compaction]?.type !== "compaction")
		compaction--;
	const live = new Set(branch.slice(compaction).map((entry) => entry.id));
	const dated = new Set(
		chained.map((entry) => entry.id).filter((id) => !live.has(id)),
	);
	return { entries: [header, ...chained], dated };
}

/** Have `manager` hold `held`, every id its file holds still taken. */
function install(
	manager: HeldManager,
	file: string,
	held: Held,
	report: Report,
): void {
	const taken = new Set(manager.byId.keys());
	for (const entry of held.entries) {
		const id = (entry as { id?: unknown }).id;
		if (typeof id === "string") taken.add(id);
	}
	manager.fileEntries = held.entries;
	manager._buildIndex();
	manager.byId = new TakenIds(manager.byId, taken);
	guard(manager, file, held.dated, taken, report);
}

/** Put back pi's own full open after the view failed to install. */
function restore(
	manager: HeldManager,
	entries: unknown[],
	leaf: string | null,
	file: string,
	report: Report,
): void {
	release(manager);
	try {
		manager.fileEntries = entries;
		manager._buildIndex();
		manager.leafId = leaf;
	} catch (error) {
		report(error);
		try {
			manager.setSessionFile(file);
		} catch (reread) {
			// pi's own open would have read this same file and failed the same
			// way; the resume goes on with whatever pi could keep.
			report(reread);
		}
	}
}

/**
 * The held entries by id, answering every id the file holds as taken, so
 * pi's id choice never repeats one; reads and walks see only what is held.
 */
class TakenIds<V> extends Map<string, V> {
	private readonly taken: Set<string>;
	constructor(held: Map<string, V>, taken: Set<string>) {
		super(held);
		this.taken = taken;
	}
	override has(id: string): boolean {
		return super.has(id) || this.taken.has(id);
	}
}

/** Answer the methods that need the whole log with the whole log. */
function guard(
	manager: HeldManager,
	file: string,
	dated: ReadonlySet<string>,
	taken: Set<string>,
	report: Report,
): void {
	const own = manager as unknown as Record<string, unknown>;
	// pi's own, taken before the view answers in their place, so no guard
	// ever reaches itself, whatever has become of the view by then.
	const pi = {
		getEntry: manager.getEntry,
		getTree: manager.getTree,
		branch: manager.branch,
		branchWithSummary: manager.branchWithSummary,
		createBranchedSession: manager.createBranchedSession,
		_rewriteFile: manager._rewriteFile,
		setSessionFile: manager.setSessionFile,
		newSession: manager.newSession,
	};
	/** Whether the view itself holds `id`, apart from the ids only taken. */
	const holds = (id: string): boolean =>
		Map.prototype.has.call(manager.byId, id);
	/** Whether the view answers for `id` as the whole log would. */
	const answers = (id: string | null): boolean =>
		id === null || (holds(id) && !dated.has(id));
	let holding = true;
	const whole = (why: string): void => {
		if (!holding) return;
		const leaf = manager.leafId;
		const held = manager.fileEntries;
		const { sessionId, sessionFile, flushed } = manager;
		holding = false;
		release(manager);
		try {
			if (!existsSync(file))
				throw new Error(`${file} is gone, so its whole log can't be read back`);
			pi.setSessionFile.call(manager, file);
			if (manager.getSessionId() !== sessionId)
				throw new Error(
					`${file} now holds conversation ${manager.getSessionId()}, not ${sessionId}`,
				);
		} catch (error) {
			Object.assign(manager, { sessionId, sessionFile, flushed });
			manager.fileEntries = held;
			manager._buildIndex();
			manager.byId = new TakenIds(manager.byId, taken);
			manager.leafId = leaf;
			guard(manager, file, dated, taken, report);
			throw error;
		}
		// pi's open leaves its leaf on the file's last entry; a reset leaf
		// stays reset and a moved one stays where it was moved.
		if (leaf === null || manager.byId.has(leaf)) manager.leafId = leaf;
		report(
			`Read conversation ${sessionId}'s whole log back into memory to ${why}; it holds it all until it next opens`,
		);
	};
	const letGo = (): void => {
		holding = false;
		release(manager);
	};
	own.getEntry = (id: string) => {
		const entry = manager.byId.get(id);
		if (entry !== undefined || !taken.has(id)) return entry;
		whole(`look up entry ${id}`);
		return pi.getEntry.call(manager, id);
	};
	own.getTree = () => {
		whole("show its tree");
		return pi.getTree.call(manager);
	};
	own.branch = (id: string) => {
		if (!answers(id)) whole(`branch to entry ${id}`);
		return pi.branch.call(manager, id);
	};
	own.branchWithSummary = (id: string | null, ...rest: unknown[]) => {
		if (!answers(id)) whole(`branch to entry ${id}`);
		return pi.branchWithSummary.call(manager, id, ...rest);
	};
	own.createBranchedSession = (leafId: string) => {
		whole("fork it");
		return pi.createBranchedSession.call(manager, leafId);
	};
	own._rewriteFile = () => {
		whole("rewrite its file");
		return pi._rewriteFile.call(manager);
	};
	own.setSessionFile = (path: string) => {
		letGo();
		return pi.setSessionFile.call(manager, path);
	};
	own.newSession = (...rest: unknown[]) => {
		letGo();
		return pi.newSession.call(manager, ...rest);
	};
}

/** Let go of the view's methods and taken ids, back to pi's own. */
function release(manager: HeldManager): void {
	const own = manager as unknown as Record<string, unknown>;
	for (const name of GUARDED) delete own[name];
	if (manager.byId instanceof TakenIds) manager.byId = new Map(manager.byId);
}

/** A token and cost count as pi records one; only the fields its totals read. */
interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cacheWrite1h?: number;
	reasoning?: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** The usage of entries left out of the view, under the name pi totals it by. */
interface LeftUsage {
	readonly provider: string;
	readonly model: string;
	readonly usage: Usage;
}

/**
 * The usage of every entry of `entries` not in `kept`, on any branch,
 * summed by the provider and model pi's footer and /session group it
 * under (`usage-totals.js`), tool and summary usage under its own.
 */
function usageLeftOut(
	entries: readonly unknown[],
	kept: ReadonlySet<string>,
): LeftUsage[] {
	const sums = new Map<string, LeftUsage>();
	for (const entry of entries) {
		const e = entry as Partial<Entry> & Record<string, unknown>;
		if (e.type === "session" || typeof e.id !== "string" || kept.has(e.id))
			continue;
		const counted = usageOf(e);
		if (!counted) continue;
		const key = `${counted.provider}/${counted.model}`;
		const sum = sums.get(key);
		if (sum) addUsage(sum.usage, counted.usage);
		else
			sums.set(key, { ...counted, usage: addUsage(noUsage(), counted.usage) });
	}
	return [...sums.values()];
}

/** The usage pi's totals read from `entry`, and whose it is. */
function usageOf(entry: Record<string, unknown>): LeftUsage | undefined {
	const message = entry.message as Record<string, unknown> | undefined;
	if (entry.type === "message" && message?.role === "assistant") {
		const model = message.responseModel ?? message.model;
		return counted(String(message.provider), String(model), message.usage);
	}
	if (entry.type === "usage")
		return counted(String(entry.provider), String(entry.model), entry.usage);
	if (entry.type === "message" && message?.role === "toolResult")
		return counted("Tools", "summaries", message.usage);
	if (entry.type === "branch_summary" || entry.type === "compaction")
		return counted("Tools", "summaries", entry.usage);
	return undefined;
}

/** `usage` under `provider` and `model`, when it is a usage at all. */
function counted(
	provider: string,
	model: string,
	usage: unknown,
): LeftUsage | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	return { provider, model, usage: usage as Usage };
}

/** A usage of nothing. */
function noUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Add `more` into `sum`, answering `sum`. */
function addUsage(sum: Usage, more: Partial<Usage>): Usage {
	const n = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	sum.input += n(more.input);
	sum.output += n(more.output);
	sum.cacheRead += n(more.cacheRead);
	sum.cacheWrite += n(more.cacheWrite);
	sum.totalTokens += n(more.totalTokens);
	if (more.cacheWrite1h !== undefined)
		sum.cacheWrite1h = n(sum.cacheWrite1h) + n(more.cacheWrite1h);
	if (more.reasoning !== undefined)
		sum.reasoning = n(sum.reasoning) + n(more.reasoning);
	const cost = more.cost;
	sum.cost.input += n(cost?.input);
	sum.cost.output += n(cost?.output);
	sum.cost.cacheRead += n(cost?.cacheRead);
	sum.cost.cacheWrite += n(cost?.cacheWrite);
	sum.cost.total += n(cost?.total);
	return sum;
}

/** Whether `entry` is a log's header line. */
function isHeader(entry: unknown): boolean {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as { type?: unknown }).type === "session"
	);
}

/** An id no entry in `taken` has, in pi's eight-hex form. */
function freshId(taken: Set<string>): string {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
}
