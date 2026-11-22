/**
 * A hosted conversation holds in memory only what a rollover would keep
 * of its log: the entries from its last compaction's first kept entry on,
 * and the state from before it (rollover.ts's `keptView`). Its file and
 * session id stay as they are; everything else stays on disk.
 *
 * pi holds every entry of a log for as long as its session runs, so a
 * child with a 98.6 MB log held about 132 MB of heap for entries the
 * model never sees again, against about 7 MB for what it does. Rollover
 * gives that back by moving to a fresh log, but a fresh log is a new
 * session id, and a child's id names its roster entry, socket, store,
 * parking marks and mesh address. So the child keeps its log and holds
 * the rollover's view of it instead, never writing that view.
 *
 * Just before the first kept entry the view holds a rollover record that
 * is never written. It names this same file as the parent, so
 * `ancestry` reads exactly what the view left out for session_recall,
 * and it carries the spend of the turns left out, so spend-workflow's
 * total reads as before. Every id in the file stays taken, so pi never
 * gives a new entry an id an older one has.
 *
 * Whatever needs the whole tree has the whole log read back first:
 * /tree, branching to an entry the view left out, forking, and any
 * rewrite of the file, which would otherwise write the view over it. A
 * conversation that switches to another log, or starts a new one, lets
 * go of the view. Any failure leaves pi's own full open as it was.
 */

import { randomBytes } from "node:crypto";
import {
	type Entry,
	keptView,
	ROLLOVER_RECORD,
	type RolloverRecord,
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
	_buildIndex(): void;
	_rewriteFile(): void;
	getBranch(): unknown[];
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
		typeof m._buildIndex === "function" &&
		typeof m._rewriteFile === "function" &&
		typeof m.getBranch === "function" &&
		typeof m.getSessionFile === "function" &&
		GUARDED.every((name) => typeof m[name] === "function")
	);
}

/**
 * Have `manager`, just opened by pi, hold only its log's kept view, and
 * answer it. It holds everything, as pi opened it, when its log has no
 * compaction to start from, when pi's privates are not what this reads,
 * or when building the view fails.
 */
export function holdKeptHistory<M>(
	manager: M,
	report: (error: unknown) => void = () => {},
): M {
	if (!holdsLikePi(manager)) return manager;
	const file = manager.getSessionFile();
	if (!file) return manager;
	let held: unknown[] | undefined;
	try {
		held = heldEntries(manager, file);
	} catch (error) {
		// Nothing was changed yet: pi's full open stands.
		report(error);
		return manager;
	}
	if (!held) return manager;
	try {
		install(manager, file, held);
	} catch (error) {
		release(manager);
		try {
			manager.setSessionFile(file);
		} catch (reading) {
			report(reading);
		}
		report(error);
	}
	return manager;
}

/**
 * The entries `manager` holds once it holds the kept view, header first,
 * or undefined when its log has nothing to leave out.
 */
function heldEntries(
	manager: HeldManager,
	file: string,
): unknown[] | undefined {
	const branch = manager.getBranch() as Entry[];
	const view = keptView(branch);
	if (!view || view.from === 0) return undefined;
	const header = manager.fileEntries[0];
	if (!isHeader(header)) return undefined;
	const taken = new Set(manager.byId.keys());
	const firstKept = branch[view.from];
	const before = branch[view.from - 1];
	if (!firstKept || !before) return undefined;

	const record: RolloverRecord = {
		parentSession: file,
		parentLeaf: before.id,
		dropped: view.dropped,
		carried: {
			[SPEND_CARRY]: { spend: spentOnBranch(branch.slice(0, view.from)) },
		},
	};
	const at = view.entries.findIndex((entry) => entry.id === firstKept.id);
	if (at === -1) return undefined;
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
		recordEntry,
		...view.entries.slice(at),
	];
	const chained: Entry[] = [];
	let parentId: string | null = null;
	for (const entry of ordered) {
		chained.push(entry.parentId === parentId ? entry : { ...entry, parentId });
		parentId = entry.id;
	}

	return [header, ...chained];
}

/** Have `manager` hold `entries`, every id its file holds still taken. */
function install(manager: HeldManager, file: string, entries: unknown[]): void {
	const taken = new Set(manager.byId.keys());
	for (const entry of entries) {
		const id = (entry as { id?: unknown }).id;
		if (typeof id === "string") taken.add(id);
	}
	manager.fileEntries = entries;
	manager._buildIndex();
	manager.byId = new TakenIds(manager.byId, taken);
	guard(manager, file);
}

/**
 * The held entries by id, answering every id the file holds as taken, so
 * pi's id choice never repeats one; reads and walks see only what is held.
 */
class TakenIds<V> extends Map<string, V> {
	readonly #taken: Set<string>;
	constructor(held: Map<string, V>, taken: Set<string>) {
		super(held);
		this.#taken = taken;
	}
	override has(id: string): boolean {
		return super.has(id) || this.#taken.has(id);
	}
	/** Whether the view itself holds `id`. */
	holds(id: string): boolean {
		return super.has(id);
	}
}

/** Answer the methods that need the whole log with the whole log. */
function guard(manager: HeldManager, file: string): void {
	const own = manager as unknown as Record<string, unknown>;
	const holds = (id: string | null): boolean =>
		id === null ||
		(manager.byId instanceof TakenIds ? manager.byId.holds(id) : true);
	const whole = (): void => {
		const leaf = manager.leafId;
		release(manager);
		manager.setSessionFile(file);
		if (leaf !== null && manager.byId.has(leaf)) manager.leafId = leaf;
	};
	own.getTree = () => {
		whole();
		return manager.getTree();
	};
	own.branch = (id: string) => {
		if (!holds(id)) whole();
		return manager.branch(id);
	};
	own.branchWithSummary = (id: string | null, ...rest: unknown[]) => {
		if (!holds(id)) whole();
		return manager.branchWithSummary(id, ...rest);
	};
	own.createBranchedSession = (leafId: string) => {
		whole();
		return manager.createBranchedSession(leafId);
	};
	own._rewriteFile = () => {
		whole();
		return manager._rewriteFile();
	};
	own.setSessionFile = (path: string) => {
		release(manager);
		return manager.setSessionFile(path);
	};
	own.newSession = (...rest: unknown[]) => {
		release(manager);
		return manager.newSession(...rest);
	};
}

/** Let go of the view's methods and taken ids, back to pi's own. */
function release(manager: HeldManager): void {
	const own = manager as unknown as Record<string, unknown>;
	for (const name of GUARDED) delete own[name];
	if (manager.byId instanceof TakenIds) manager.byId = new Map(manager.byId);
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
