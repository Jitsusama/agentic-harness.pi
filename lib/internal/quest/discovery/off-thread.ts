/**
 * What signing the quest tree reads, read off the thread: every listing,
 * stat, file and real path the signature and the walk would ask for,
 * through the filesystem's promises a few at a time, into a pass they
 * then read from memory. A host runs it so its conversations don't wait
 * on the disk while the tree is signed; `discovery.ts` decides when.
 */

import { type BigIntStats, type Dirent, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isId, prefixOf } from "../creation/id.ts";
import {
	CANONICAL_DOCUMENT_DIRS,
	hashRead,
	newPass,
	type Pass,
	recordFor,
	vouchedHash,
} from "./discovery-reads.ts";

/**
 * How many calls a signing keeps with the disk at once. libuv serves
 * the filesystem's promises from four threads, so four keeps them busy
 * without queueing ahead of another conversation's own reads.
 */
const AT_ONCE = 4;

/**
 * The quests root's stat, as a host compares it to see a quest made or
 * removed since it last signed: one stat of one folder, where a listing
 * would take the filesystem's directory lock.
 */
export function rootStampOf(questsRoot: string): string {
	try {
		return stampOf(statSync(questsRoot, { bigint: true }));
	} catch {
		// No root: a root made later stamps differently.
		return "absent";
	}
}

/** The quests root's stat, read off the thread. */
async function rootStampOffThread(questsRoot: string): Promise<string> {
	try {
		return stampOf(await stat(questsRoot, { bigint: true }));
	} catch {
		// No root: a root made later stamps differently.
		return "absent";
	}
}

function stampOf(st: BigIntStats): string {
	return `${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
}

/** What one signing off the thread read, and the root's stat before it. */
export interface ReadOffThread {
	readonly pass: Pass;
	readonly rootStamp: string;
}

/**
 * Read everything signing `questsRoot` and walking it would, off the
 * thread. The root's stat is taken first, so a quest made while it reads
 * leaves a stamp that no longer matches and the next ask signs at once.
 */
export async function readTreeOffThread(
	questsRoot: string,
): Promise<ReadOffThread> {
	const pass = newPass();
	const rootStamp = await rootStampOffThread(questsRoot);
	const rootEntries = await listed(questsRoot, pass);
	if (!rootEntries) return { pass, rootStamp };
	const folders = rootEntries.filter(
		(e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."),
	);
	const quests = folders.filter(
		(e) => isId(e.name) && prefixOf(e.name) === "QEST",
	);
	await resolved(questsRoot, pass);
	await inTurn(folders, (e) => resolved(join(questsRoot, e.name), pass));
	await inTurn(quests, (e) => listed(join(questsRoot, e.name), pass));
	const files: string[] = [];
	const kinds: string[] = [];
	for (const quest of quests) {
		const questDir = join(questsRoot, quest.name);
		files.push(join(questDir, "README.md"));
		const entries = pass.listings.get(questDir) ?? [];
		for (const kind of CANONICAL_DOCUMENT_DIRS) {
			const present = entries.some(
				(e) => e.name === kind && (e.isDirectory() || e.isSymbolicLink()),
			);
			if (present) kinds.push(join(questDir, kind));
		}
	}
	await inTurn(kinds, (dir) => listed(dir, pass));
	for (const dir of kinds) {
		for (const doc of pass.listings.get(dir) ?? []) {
			if (doc.isFile()) files.push(join(dir, doc.name));
		}
	}
	await inTurn(files, (path) => hashed(path, pass));
	return { pass, rootStamp };
}

/** A folder's listing into the pass, undefined when it has none. */
async function listed(path: string, pass: Pass): Promise<Dirent[] | undefined> {
	let entries: Dirent[] | undefined;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		// No folder: the walk reads it as having none, as readEntries does.
		entries = undefined;
	}
	pass.listings.set(path, entries);
	return entries;
}

/** A folder's real path into the pass, undefined when it can't be had. */
async function resolved(path: string, pass: Pass): Promise<void> {
	try {
		pass.reals.set(path, await realpath(path));
	} catch {
		// Gone or unreadable; the walk reports the read error itself.
		pass.reals.set(path, undefined);
	}
}

/**
 * A file's hash into the pass: its stamp's when the stat still vouches
 * and its parsed record is the one kept, else its bytes', which the walk
 * then parses without reading it again.
 */
async function hashed(path: string, pass: Pass): Promise<void> {
	try {
		const st = await stat(path, { bigint: true });
		const vouched = vouchedHash(path, st);
		if (
			vouched !== undefined &&
			(!parseable(path) || recordFor(path, vouched))
		) {
			pass.hashes.set(path, vouched);
			return;
		}
		hashRead(path, st, await readFile(path), pass);
	} catch {
		// Missing or unreadable: the signature leaves it out, as it would.
		pass.absent.add(path);
	}
}

/** Whether the walk parses a file, so needs its bytes when no record is kept. */
function parseable(path: string): boolean {
	return path.endsWith(".md");
}

/** Run `each` over `items`, `AT_ONCE` at a time. */
async function inTurn<T>(
	items: readonly T[],
	each: (item: T) => Promise<unknown>,
): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next];
			next += 1;
			if (item !== undefined) await each(item);
		}
	};
	await Promise.all(Array.from({ length: AT_ONCE }, worker));
}
