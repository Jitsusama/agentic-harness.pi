/**
 * The quest tree's reads, made on a thread of their own: every listing,
 * stat, real path and file a signing needs, answered to the host's
 * thread in one message. Read through the filesystem's promises on the
 * host's own thread, each of a signing's thousands of reads waited for
 * a turn there, behind every conversation's work: on 20 Nov, with 1,523
 * quests and a loop held for seconds at a time, a signing took 30 to 76
 * s, past the 30 s its asks wait, so every write resting on one was
 * refused. On this thread the reads run at the disk's pace, whatever
 * the host's thread is doing, and cost it one turn.
 */

import { Worker } from "node:worker_threads";
import { ID_PATTERN } from "../creation/id.ts";
import { CANONICAL_DOCUMENT_DIRS, MAX_WALK_DEPTH } from "./discovery-reads.ts";

/** A stat as the thread took it, with when it took it. */
export interface StatRead {
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly ino: bigint;
	/** When it was taken, in nanoseconds since the epoch. */
	readonly at: bigint;
}

/** A listed entry's kind: folder, file, link, or anything else. */
export type EntryKind = "d" | "f" | "l" | "o";

/** What the thread read of a tree, in the order a signing reads it. */
export interface TreeRead {
	/** The root's stat, taken before anything else, if it is there. */
	readonly root: StatRead | null;
	/** Each folder listed, with its entries, or null for none. */
	readonly listings: readonly [
		string,
		(readonly [string, EntryKind])[] | null,
	][];
	/** Each folder's real path, or null when it couldn't be had. */
	readonly reals: readonly [string, string | null][];
	/**
	 * Each quest folder's stat and its README's, taken before the folder
	 * was listed: null for a folder not there, and for a README not there.
	 */
	readonly pending: readonly [string, StatRead | null, StatRead | null][];
	/**
	 * Each file's stat and bytes: no stat for one missing, unreadable or
	 * not a plain file; no bytes for one whose stat matched the one it
	 * was sent to skip under.
	 */
	readonly files: readonly [string, StatRead | null, Uint8Array | null][];
}

/**
 * How many calls the thread keeps with the disk at once. The process's
 * filesystem threads are shared with every conversation's own reads,
 * so a signing takes only a few of them.
 */
const AT_ONCE = 4;

/**
 * The thread's program, plain JavaScript since it runs from source. It
 * reads what `readTreeOffThread` used to, in the same order: the
 * root's stat, its listing, real paths, each quest's stamps then
 * listing, nested quests to the walk's depth, kind folders, then each
 * file, read only where its stat doesn't match the one it may skip at.
 */
const PROGRAM = `
const { parentPort, workerData } = require("node:worker_threads");
const { readdir, readFile, realpath, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { root, skip, atOnce, depth, kinds, id } = workerData;
const skips = new Map(skip);
const isId = new RegExp(id);
const quest = (name) => isId.test(name) && name.startsWith("QEST-");
const listings = [];
const listingOf = new Map();
const reals = [];
const pending = [];
const files = [];
const kindOf = (e) => e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : e.isFile() ? "f" : "o";
async function statOf(path) {
	try {
		const st = await stat(path, { bigint: true });
		const at = BigInt(Date.now()) * 1000000n;
		return { st: { size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: st.ino, at }, file: st.isFile() };
	} catch {
		return undefined;
	}
}
async function listed(path) {
	let entries;
	try {
		entries = (await readdir(path, { withFileTypes: true })).map((e) => [e.name, kindOf(e)]);
	} catch {
		entries = undefined;
	}
	listingOf.set(path, entries);
	listings.push([path, entries ?? null]);
	return entries;
}
async function resolved(path) {
	try {
		reals.push([path, await realpath(path)]);
	} catch {
		reals.push([path, null]);
	}
}
async function stamped(dir) {
	const folder = await statOf(dir);
	const readme = folder ? await statOf(join(dir, "README.md")) : undefined;
	pending.push([dir, folder ? folder.st : null, readme ? readme.st : null]);
}
async function hashed(path) {
	const found = await statOf(path);
	if (!found || !found.file) return files.push([path, null, null]);
	const { st } = found;
	const key = st.size + ":" + st.mtimeNs + ":" + st.ctimeNs + ":" + st.ino;
	if (skips.get(path) === key) return files.push([path, st, null]);
	try {
		files.push([path, st, await readFile(path)]);
	} catch {
		files.push([path, null, null]);
	}
}
async function inTurn(items, each) {
	let next = 0;
	const one = async () => {
		while (next < items.length) {
			const item = items[next];
			next += 1;
			await each(item);
		}
	};
	await Promise.all(Array.from({ length: atOnce }, one));
}
(async () => {
	const top = await statOf(root);
	const rootEntries = await listed(root);
	if (rootEntries) {
		const folders = rootEntries.filter(([name, kind]) => kind === "d" && !name.startsWith("."));
		const questDirs = folders.filter(([name]) => quest(name)).map(([name]) => join(root, name));
		await resolved(root);
		await inTurn(folders, ([name]) => resolved(join(root, name)));
		// Stamped before it is listed, so a README made while this reads
		// leaves a stamp that no longer matches.
		await inTurn(questDirs, async (dir) => {
			await stamped(dir);
			await listed(dir);
		});
		let level = questDirs;
		for (let d = 1; d <= depth && level.length > 0; d++) {
			const nested = level.flatMap((dir) =>
				(listingOf.get(dir) ?? [])
					.filter(([name, kind]) => kind === "d" && quest(name))
					.map(([name]) => join(dir, name)),
			);
			await inTurn(nested, listed);
			level = nested;
		}
		const paths = [];
		const kindDirs = [];
		for (const dir of questDirs) {
			paths.push(join(dir, "README.md"));
			const entries = listingOf.get(dir) ?? [];
			for (const k of kinds) {
				if (entries.some(([name, kind]) => name === k && (kind === "d" || kind === "l"))) kindDirs.push(join(dir, k));
			}
		}
		await inTurn(kindDirs, listed);
		for (const dir of kindDirs) {
			for (const [name, kind] of listingOf.get(dir) ?? []) if (kind === "f") paths.push(join(dir, name));
		}
		await inTurn(paths, hashed);
	}
	parentPort.postMessage({ root: top ? top.st : null, listings, reals, pending, files });
})().catch((error) => {
	parentPort.postMessage({ failed: String(error) });
});
`;

/**
 * Read `questsRoot` on a thread of its own, reading no file whose stat
 * matches the key `skip` holds for it. Rejects when the thread fails,
 * and after `wallMs` without an answer, ending the thread: a disk that
 * hangs holds that thread, never the host's.
 */
export function readTreeInThread(
	questsRoot: string,
	skip: ReadonlyMap<string, string>,
	wallMs: number,
): Promise<TreeRead> {
	return new Promise((resolve, reject) => {
		let done = false;
		const thread = new Worker(PROGRAM, {
			eval: true,
			workerData: {
				root: questsRoot,
				skip: [...skip],
				atOnce: AT_ONCE,
				depth: MAX_WALK_DEPTH,
				kinds: CANONICAL_DOCUMENT_DIRS,
				id: ID_PATTERN,
			},
		});
		const finish = (end: () => void): void => {
			// The exit that follows an answer, or its ending, is not news.
			if (done) return;
			done = true;
			clearTimeout(wall);
			end();
			// Ending a thread that has answered only frees it.
			thread.terminate().catch(() => undefined);
		};
		// Not a wait for something to happen: a ceiling on a disk that hangs.
		const wall = setTimeout(
			() =>
				finish(() =>
					reject(new Error(`reading ${questsRoot} took past ${wallMs} ms`)),
				),
			wallMs,
		);
		wall.unref();
		thread.unref();
		thread.once("message", (answer: unknown) =>
			finish(() =>
				isTreeRead(answer)
					? resolve(answer)
					: reject(
							new Error(`reading ${questsRoot} failed: ${failure(answer)}`),
						),
			),
		);
		thread.once("error", (error) => finish(() => reject(error)));
		thread.once("exit", (code) =>
			finish(() =>
				reject(new Error(`reading ${questsRoot} ended (${code}) unanswered`)),
			),
		);
	});
}

function isTreeRead(answer: unknown): answer is TreeRead {
	return (
		typeof answer === "object" &&
		answer !== null &&
		"listings" in answer &&
		"files" in answer
	);
}

function failure(answer: unknown): string {
	return typeof answer === "object" && answer !== null && "failed" in answer
		? String(answer.failed)
		: "no answer";
}
