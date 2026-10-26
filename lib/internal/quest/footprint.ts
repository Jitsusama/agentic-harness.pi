/**
 * What each quest holds on disk, and how much of it could go now.
 *
 * A quest leaves two kinds of thing on disk that nothing else accounts
 * for: its workspace, where clones, builds and raw data go, and the
 * trees it scaffolded for its code. Together they reached 80 GB of
 * workspaces and over 250 GB of trees on one machine, and nobody could
 * say which quest held what, or what was safe to let go.
 *
 * A quest that is finished (concluded or retired) holds nothing it
 * still needs, but not all of it is equally safe to let go. Its
 * workspace is raw material kept only in case it reopens, so it counts
 * as reclaimable. A tree it made that is still on disk is one whose
 * prune was refused when it ended, for work not yet merged or not yet
 * committed, so it is counted as left behind: only a prune, which
 * checks that its work is safe, may take it. A quest still under way
 * holds all of it. Trees a quest
 * adopted are the person's own checkouts, often shared by several
 * quests, so they are measured once and never counted as any quest's
 * to reclaim: `work tidy` says when one of those is spent. The record
 * itself (README and documents) is never counted; it is not raw
 * material.
 *
 * Measuring walks directories, which on a machine like this takes tens
 * of seconds, so it is never on a hot path: it runs only when asked, at
 * the lowest CPU priority, sharing one deadline across every path.
 * `du -d 1` prints each subfolder as it finishes, so a measurement the
 * deadline cuts short still says at least how much it found, and the
 * report says which figures are only lower bounds.
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { type Exec, spawnExec } from "../../core/exec/index.ts";
import type { QuestTree } from "../../quest/types.ts";

/** How much a path holds. */
export interface Size {
	readonly bytes: number;
	/** False when the deadline cut the walk short: `bytes` is a lower bound. */
	readonly complete: boolean;
}

/** Measure one path, or say it is not there. */
export type Measure = (path: string) => Promise<Size | undefined>;

/** What a quest is, as far as its footprint goes. */
export interface QuestOnDisk {
	readonly id: string;
	readonly title?: string;
	readonly status: string;
	readonly trees: readonly Pick<QuestTree, "path" | "origin">[];
}

/** What one quest holds. */
export interface QuestHolding {
	readonly id: string;
	readonly title?: string;
	readonly status: string;
	/** Concluded or retired: everything it made could go. */
	readonly finished: boolean;
	readonly workspace?: Size;
	/** Trees it scaffolded that are still on disk. */
	readonly made: readonly { path: string; size: Size }[];
	/** Trees it adopted that are still on disk, measured in `adopted`. */
	readonly adopted: readonly string[];
}

/** What every quest holds. */
export interface Holdings {
	readonly quests: readonly QuestHolding[];
	/** Every adopted tree, once however many quests adopted it. */
	readonly adopted: readonly { path: string; size: Size; quests: string[] }[];
}

/** Whether `path` is `root` or lies under it. */
function under(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

/** Statuses after which a quest needs nothing it made. */
const FINISHED: ReadonlySet<string> = new Set(["concluded", "retired"]);

/**
 * Read `du -k -d 1 <path>` output. The line naming the path itself is
 * its total; without it, the walk was cut short and what its finished
 * subfolders hold is a lower bound.
 */
export function readDu(stdout: string, path: string): Size {
	let children = 0;
	for (const line of stdout.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const kib = Number(line.slice(0, tab));
		if (!Number.isFinite(kib)) continue;
		const named = line.slice(tab + 1);
		if (named === path) return { bytes: kib * 1024, complete: true };
		children += kib * 1024;
	}
	return { bytes: children, complete: false };
}

/**
 * How long one report may spend measuring.
 *
 * Every workspace and tree on a heavily used machine took about twenty
 * seconds; the deadline is well above that, and short enough that a
 * person waiting on an answer gets one.
 */
export const MEASURE_DEADLINE_MS = 60_000;

/**
 * A measurer that walks with `du` at the lowest CPU priority, every call
 * sharing one deadline: a call made after it passes measures nothing and
 * says so, and so does one made once `signal` stops the report. `exec`
 * stands in for running the command, for tests.
 */
export function duMeasure(
	options: {
		deadlineMs?: number;
		now?: () => number;
		signal?: AbortSignal;
		exec?: (timeoutMs: number) => Exec;
	} = {},
): Measure {
	const now = options.now ?? Date.now;
	const deadline = now() + (options.deadlineMs ?? MEASURE_DEADLINE_MS);
	const { signal } = options;
	const execFor =
		options.exec ??
		((timeoutMs: number) =>
			spawnExec({ timeoutMs, ...(signal ? { signal } : {}) }));
	return async (path) => {
		if (!existsSync(path)) return undefined;
		const left = deadline - now();
		if (left <= 0 || signal?.aborted) return { bytes: 0, complete: false };
		// -x keeps the walk on one filesystem, so a mount inside a tree
		// is not counted as the tree's.
		const result = await execFor(left)("nice", [
			"-n",
			"19",
			"du",
			"-k",
			"-x",
			"-d",
			"1",
			path,
		]);
		return readDu(result.stdout, path);
	};
}

/** A size as a person reads it: GB past a gigabyte, MB below. */
export function formatSize(size: Size): string {
	if (!size.complete && size.bytes === 0) return "not measured in time";
	const figure =
		size.bytes >= 1e9
			? `${(size.bytes / 1e9).toFixed(1)} GB`
			: size.bytes >= 1e6
				? `${Math.round(size.bytes / 1e6)} MB`
				: "under 1 MB";
	return size.complete ? figure : `at least ${figure}`;
}

/**
 * Each path's size, one after another so only one walk runs at a
 * time. A path that is not there is left out rather than sized at 0.
 */
export async function measureEach(
	paths: readonly string[],
	measure: Measure,
): Promise<Map<string, Size>> {
	const sizes = new Map<string, Size>();
	for (const path of paths) {
		const size = await measure(path);
		if (size) sizes.set(path, size);
	}
	return sizes;
}

/** Add sizes, staying a lower bound when any part is one. */
export function sum(sizes: readonly (Size | undefined)[]): Size {
	let bytes = 0;
	let complete = true;
	for (const size of sizes) {
		if (!size) continue;
		bytes += size.bytes;
		complete &&= size.complete;
	}
	return { bytes, complete };
}

/** What a quest made: its workspace and the trees it scaffolded. */
export function ownOf(holding: QuestHolding): Size {
	return sum([holding.workspace, ...holding.made.map((m) => m.size)]);
}

/** What of a quest's own could go now: a finished quest's workspace. */
export function reclaimableOf(holding: QuestHolding): Size {
	return holding.finished
		? sum([holding.workspace])
		: { bytes: 0, complete: true };
}

/** The trees a finished quest left behind, for a prune to judge. */
export function leftBehindOf(holding: QuestHolding): Size {
	return holding.finished
		? sum(holding.made.map((m) => m.size))
		: { bytes: 0, complete: true };
}

/**
 * Measure what every quest holds, one path at a time so the walk never
 * competes with itself for the disk. Quests holding nothing on disk are
 * left out.
 */
export async function measureHoldings(
	quests: readonly QuestOnDisk[],
	workspaceRoot: string,
	measure: Measure,
): Promise<Holdings> {
	const holdings: QuestHolding[] = [];
	const adopters = new Map<string, string[]>();
	for (const quest of quests) {
		const workspaceDir = join(workspaceRoot, quest.id);
		const workspace = await measure(workspaceDir);
		const made: { path: string; size: Size }[] = [];
		const adopted: string[] = [];
		for (const tree of quest.trees) {
			if (!existsSync(tree.path)) continue;
			// A tree cut inside a workspace is already in its figure.
			if (under(tree.path, workspaceRoot)) continue;
			if (tree.origin === "adopted") {
				adopted.push(tree.path);
				adopters.set(tree.path, [...(adopters.get(tree.path) ?? []), quest.id]);
				continue;
			}
			const size = await measure(tree.path);
			if (size) made.push({ path: tree.path, size });
		}
		if (!workspace && made.length === 0 && adopted.length === 0) continue;
		holdings.push({
			id: quest.id,
			...(quest.title !== undefined ? { title: quest.title } : {}),
			status: quest.status,
			finished: FINISHED.has(quest.status),
			...(workspace ? { workspace } : {}),
			made,
			adopted,
		});
	}
	const adopted: Holdings["adopted"][number][] = [];
	for (const [path, owners] of adopters) {
		const size = await measure(path);
		if (size) adopted.push({ path, size, quests: owners });
	}
	return { quests: holdings, adopted };
}
