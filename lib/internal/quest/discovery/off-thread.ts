/**
 * What signing the quest tree reads, read on a thread of its own: every
 * listing, stat, file and real path the signature and the walk would
 * ask for, into a pass they then read from memory. A host runs it so
 * its conversations don't wait on the disk while the tree is signed;
 * `discovery.ts` decides when.
 *
 * The reads were once the filesystem's promises, four at a time, on the
 * host's own thread. Each of their thousands of calls (2,596 listings
 * and 3,499 files over 1,440 quests on 18 November) needed a free
 * thread in the pool every conversation's reads share, and then a turn
 * of the host's event loop. Measured on that store, one signing took
 * 0.7 s quiet, 47 s beside 64 reads of large session logs, and 57 s
 * with the loop held 90 ms at a time, as a host with many conversations
 * holds it; past 30 s its asks gave up, and hosts logged walks hung
 * past five minutes. A worker thread making plain synchronous calls
 * waits on neither: its calls run on the worker itself, and the host
 * hears from it once, with everything it read.
 *
 * The thread is handed the stamps this process already trusts, so it
 * reads the bytes only of files that changed, and it answers in plain
 * data, since a `Dirent` or a stat can't cross a thread whole.
 */

import { type BigIntStats, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "../../record.ts";
import { DOCUMENT_ID_SOURCE, QUEST_ID_SOURCE } from "../creation/id.ts";
import {
	CANONICAL_DOCUMENT_DIRS,
	type Entry,
	keepRead,
	MAX_WALK_DEPTH,
	newPass,
	type Pass,
	SETTLED_NS,
	settled,
	stampsUnder,
} from "./discovery-reads.ts";

/**
 * A folder's stat, as a host compares it to see an entry made or
 * removed since it last signed: one stat of one folder, where a listing
 * would take the filesystem's directory lock. Undefined for a folder
 * changed too lately for its stat to vouch, since two changes inside one
 * tick of a coarse clock can leave the same stat, and for one that isn't
 * there; neither ever matches, so the ask signs at once.
 */
export function folderStampOf(path: string): string | undefined {
	try {
		return stampOf(statSync(path, { bigint: true }));
	} catch {
		// No folder: one made later is seen, since nothing matches this.
		return undefined;
	}
}

/** A stat's stamp, as the signing thread writes it too. */
function stampOf(st: BigIntStats): string | undefined {
	return settled(st) ? `${st.mtimeNs}:${st.ctimeNs}:${st.ino}` : undefined;
}

/**
 * The stamp a quest folder the walk found unready is held to: its own
 * stat, for a README made inside it, and its README's, for one there
 * but empty or unparsed and filled in place. Undefined as
 * `folderStampOf` when either changed too lately to vouch.
 */
export function pendingStampOf(dir: string): string | undefined {
	const folder = folderStampOf(dir);
	if (folder === undefined) return undefined;
	let readme: BigIntStats | undefined;
	try {
		readme = statSync(join(dir, "README.md"), { bigint: true });
	} catch {
		// No README: the folder's own stat moves when one is made.
		readme = undefined;
	}
	if (!readme) return `${folder}|none`;
	const stamp = stampOf(readme);
	return stamp === undefined ? undefined : `${folder}|${stamp}`;
}

/** What one signing off the thread read, and the root's stat before it. */
export interface ReadOffThread {
	readonly pass: Pass;
	readonly rootStamp: string | undefined;
}

/**
 * Threads ended past their wall that haven't stopped yet, each with
 * how it stopped. A thread in a read of a hung disk stops only when
 * the read returns, so while one stands no other starts: a disk that
 * hangs holds one thread, never one more every wall.
 */
const letGo = new Map<Worker, Promise<number>>();

/** How each signing thread ended past its wall but not yet stopped will stop. */
export function threadsLetGo(): readonly Promise<number>[] {
	return [...letGo.values()];
}

/** An entry's kinds, as the thread lists them in one number. */
const DIRECTORY = 1;
const FILE = 2;
const LINK = 4;

/**
 * The thread's whole program. It is source rather than a file beside
 * this one, because this module runs as TypeScript and node won't strip
 * types where consumers install this package; it needs nothing but
 * node's own modules. It follows the walk's own order: the root's stat
 * before its listing, so a quest made while it reads leaves a stamp that
 * no longer matches, and each quest folder's stamp before its listing,
 * so a README made meanwhile does too. A file whose stat still matches
 * its stamp, and whose record is kept when the walk parses it, keeps its
 * hash unread; its key is `statKey`'s in `discovery-reads.ts`.
 */
const PROGRAM = `
const { parentPort, workerData } = require("node:worker_threads");
const {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} = require("node:fs");
const { basename, join } = require("node:path");
const { root, questId, documentId, kinds, maxDepth, settledNs, known } = workerData;
const quest = new RegExp(questId);
const doc = new RegExp(documentId);
const listings = new Map();
const reals = new Map();
const pending = new Map();
const hashes = new Map();
const absent = [];
const reads = [];
const settled = (st) => BigInt(Date.now()) * 1000000n - st.mtimeNs > settledNs;
const stampOf = (st) => (settled(st) ? st.mtimeNs + ":" + st.ctimeNs + ":" + st.ino : undefined);
const statOf = (path) => {
	try {
		return statSync(path, { bigint: true });
	} catch {
		return undefined;
	}
};
const folderStamp = (path) => {
	const st = statOf(path);
	return st ? stampOf(st) : undefined;
};
const pendingStamp = (dir) => {
	const folder = folderStamp(dir);
	if (folder === undefined) return undefined;
	const readme = statOf(join(dir, "README.md"));
	if (!readme) return folder + "|none";
	const stamp = stampOf(readme);
	return stamp === undefined ? undefined : folder + "|" + stamp;
};
const kindOf = (e) =>
	(e.isDirectory() ? ${DIRECTORY} : 0) | (e.isFile() ? ${FILE} : 0) | (e.isSymbolicLink() ? ${LINK} : 0);
const listed = (path) => {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true }).map((e) => [e.name, kindOf(e)]);
	} catch {
		entries = undefined;
	}
	listings.set(path, entries);
	return entries;
};
const resolved = (path) => {
	try {
		reals.set(path, realpathSync(path));
	} catch {
		reals.set(path, undefined);
	}
};
const parsedByTheWalk = (path) => {
	const name = basename(path);
	if (name === "README.md") return true;
	return name.endsWith(".md") && doc.test(name.slice(0, -3));
};
const keyOf = (st) => st.size + ":" + st.mtimeNs + ":" + st.ctimeNs + ":" + st.ino;
const hashed = (path) => {
	let fd;
	try {
		const st = statSync(path, { bigint: true });
		if (!st.isFile()) {
			absent.push(path);
			return;
		}
		const stamp = known.get(path);
		if (stamp && stamp.key === keyOf(st) && (stamp.record || !parsedByTheWalk(path))) {
			hashes.set(path, stamp.hash);
			return;
		}
		// Opened without waiting and judged by what was opened, so a path
		// swapped for a FIFO since its stat can't hold this thread, nor one
		// swapped for a terminal become the host's.
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY,
		);
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile()) {
			absent.push(path);
			return;
		}
		reads.push({
			path,
			key: keyOf(opened),
			settled: settled(opened),
			bytes: readFileSync(fd),
		});
	} catch {
		absent.push(path);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};
const isFolder = (kind) => (kind & ${DIRECTORY}) !== 0 && (kind & ${LINK}) === 0;
const walk = () => {
	const rootStamp = folderStamp(root);
	const rootEntries = listed(root);
	if (!rootEntries) return rootStamp;
	const folders = rootEntries.filter(([name, kind]) => isFolder(kind) && !name.startsWith("."));
	const questDirs = folders.filter(([name]) => quest.test(name)).map(([name]) => join(root, name));
	resolved(root);
	for (const [name] of folders) resolved(join(root, name));
	for (const dir of questDirs) {
		pending.set(dir, pendingStamp(dir));
		listed(dir);
	}
	let level = questDirs;
	for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
		const nested = level.flatMap((dir) =>
			(listings.get(dir) ?? [])
				.filter(([name, kind]) => isFolder(kind) && quest.test(name))
				.map(([name]) => join(dir, name)),
		);
		for (const dir of nested) listed(dir);
		level = nested;
	}
	const files = [];
	for (const questDir of questDirs) {
		files.push(join(questDir, "README.md"));
		const entries = listings.get(questDir) ?? [];
		for (const kind of kinds) {
			const present = entries.some(
				([name, flags]) => name === kind && (flags & (${DIRECTORY} | ${LINK})) !== 0,
			);
			if (!present) continue;
			const dir = join(questDir, kind);
			for (const [name, flags] of listed(dir) ?? []) {
				if ((flags & ${FILE}) !== 0) files.push(join(dir, name));
			}
		}
	}
	for (const path of files) hashed(path);
	return rootStamp;
};
try {
	const rootStamp = walk();
	// Each file's bytes are handed over rather than copied, where they
	// fill a buffer of their own.
	const handed = reads
		.map((read) => read.bytes)
		.filter((bytes) => bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength)
		.map((bytes) => bytes.buffer);
	parentPort.postMessage({ rootStamp, listings, reals, pending, hashes, absent, reads }, handed);
} catch (error) {
	parentPort.postMessage({ failed: (error && error.stack) || String(error) });
}
`;

/** What the thread answers, once. */
interface Answer {
	rootStamp: string | undefined;
	listings: Map<string, [string, number][] | undefined>;
	reals: Map<string, string | undefined>;
	pending: Map<string, string | undefined>;
	hashes: Map<string, string>;
	absent: string[];
	reads: { path: string; key: string; settled: boolean; bytes: Uint8Array }[];
}

function isAnswer(value: unknown): value is Answer {
	return (
		isRecord(value) &&
		value.listings instanceof Map &&
		value.reals instanceof Map &&
		value.pending instanceof Map &&
		value.hashes instanceof Map &&
		Array.isArray(value.absent) &&
		Array.isArray(value.reads)
	);
}

/**
 * Read everything signing `questsRoot` and walking it would, on a
 * thread of its own. Rejects when the thread fails, ends unanswered or
 * hasn't answered in `wallMs`, when it is ended; the signing then fails,
 * and the last walk stands. A thread held in a read of a hung disk ends
 * once the read returns, since nothing can interrupt a call in the
 * kernel; it holds no thread of the pool the host's reads share, and
 * until it ends, every signing fails at once rather than start another.
 */
export function readTreeOffThread(
	questsRoot: string,
	wallMs: number,
): Promise<ReadOffThread> {
	return new Promise((resolve, reject) => {
		if (letGo.size > 0) {
			reject(
				new Error(
					"a signing thread ended past its wall hasn't stopped, so its disk still hangs",
				),
			);
			return;
		}
		const worker = new Worker(PROGRAM, {
			eval: true,
			workerData: {
				root: questsRoot,
				questId: QUEST_ID_SOURCE,
				documentId: DOCUMENT_ID_SOURCE,
				kinds: CANONICAL_DOCUMENT_DIRS,
				maxDepth: MAX_WALK_DEPTH,
				settledNs: SETTLED_NS,
				known: stampsUnder(questsRoot),
			},
		});
		// A signing is no reason for a process to stay up.
		worker.unref();
		// Ending a thread that has answered only frees it, and one that
		// won't end is no longer this signing's concern.
		const end = () => {
			clearTimeout(clock);
			worker.terminate().catch(() => undefined);
		};
		const clock = setTimeout(() => {
			// An answer that lands as it ends writes no stamps for a signing
			// already failed.
			worker.removeAllListeners("message");
			const stopped = worker.terminate().catch(() => -1);
			letGo.set(worker, stopped);
			void stopped.then(() => letGo.delete(worker));
			reject(
				new Error(
					`the signing thread hadn't answered after ${wallMs} ms, so its disk is taken to hang`,
				),
			);
		}, wallMs);
		clock.unref();
		worker.once("message", (answer: unknown) => {
			end();
			try {
				if (isAnswer(answer)) resolve(passOf(answer));
				else
					reject(
						new Error(
							isRecord(answer) && typeof answer.failed === "string"
								? answer.failed
								: "the signing thread answered in no shape it keeps",
						),
					);
			} catch (error) {
				// An answer that can't be made a pass fails this signing, never
				// the host.
				reject(error);
			}
		});
		worker.once("error", (error) => {
			end();
			reject(error);
		});
		// Settles nothing once the answer came, since a promise settles once.
		worker.once("exit", (code) => {
			clearTimeout(clock);
			reject(new Error(`the signing thread ended (${code}) without answering`));
		});
	});
}

/** The pass the thread's answer stands for. */
function passOf(answer: Answer): ReadOffThread {
	const pass = newPass();
	for (const [path, entries] of answer.listings) {
		pass.listings.set(
			path,
			entries?.map(([name, kind]) => entryOf(name, kind)),
		);
	}
	for (const [path, real] of answer.reals) pass.reals.set(path, real);
	for (const [dir, stamp] of answer.pending) pass.pending.set(dir, stamp);
	for (const [path, hash] of answer.hashes) pass.hashes.set(path, hash);
	for (const path of answer.absent) pass.absent.add(path);
	for (const read of answer.reads) {
		const bytes = Buffer.from(
			read.bytes.buffer,
			read.bytes.byteOffset,
			read.bytes.byteLength,
		);
		keepRead(read.path, read.key, read.settled, bytes, pass);
	}
	return { pass, rootStamp: answer.rootStamp };
}

/** An entry as the walk reads it, from the name and kinds the thread listed. */
function entryOf(name: string, kind: number): Entry {
	return {
		name,
		isDirectory: () => (kind & DIRECTORY) !== 0,
		isFile: () => (kind & FILE) !== 0,
		isSymbolicLink: () => (kind & LINK) !== 0,
	};
}
