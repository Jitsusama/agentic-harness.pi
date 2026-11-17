/**
 * What signing the quest tree reads, read off the thread: every listing,
 * stat, file and real path the signature and the walk would ask for,
 * through the filesystem's promises a few at a time, into a pass they
 * then read from memory. A host runs it so its conversations don't wait
 * on the disk while the tree is signed; `discovery.ts` decides when.
 */

import { type BigIntStats, type Dirent, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isId, prefixOf } from "../creation/id.ts";
import {
	CANONICAL_DOCUMENT_DIRS,
	hashRead,
	MAX_WALK_DEPTH,
	newPass,
	type Pass,
	recordFor,
	settled,
	vouchedHash,
} from "./discovery-reads.ts";

/**
 * How many calls a signing keeps with the disk at once. libuv serves
 * the filesystem's promises from four threads, so four keeps them busy
 * without queueing ahead of another conversation's own reads.
 */
const AT_ONCE = 4;

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

/** A folder's stat, read off the thread; undefined as `folderStampOf`. */
async function folderStampOffThread(path: string): Promise<string | undefined> {
	try {
		return stampOf(await stat(path, { bigint: true }));
	} catch {
		// No folder: one made later is seen, since nothing matches this.
		return undefined;
	}
}

function stampOf(st: BigIntStats): string | undefined {
	return settled(st) ? `${st.mtimeNs}:${st.ctimeNs}:${st.ino}` : undefined;
}

/** What one signing off the thread read, and the root's stat before it. */
export interface ReadOffThread {
	readonly pass: Pass;
	readonly rootStamp: string | undefined;
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
	const rootStamp = await folderStampOffThread(questsRoot);
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
	const questDirs = quests.map((e) => join(questsRoot, e.name));
	await inTurn(questDirs, (dir) => listed(dir, pass));
	await nestedListed(questDirs, pass);
	const files: string[] = [];
	const kinds: string[] = [];
	for (const questDir of questDirs) {
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

/**
 * The listings of quest folders nested inside quests, which the walk
 * reports as layout errors: each level's nested folders, to the walk's
 * own depth.
 */
async function nestedListed(questDirs: string[], pass: Pass): Promise<void> {
	let level = questDirs;
	for (let depth = 1; depth <= MAX_WALK_DEPTH && level.length > 0; depth++) {
		const nested = level.flatMap((dir) =>
			(pass.listings.get(dir) ?? [])
				.filter(
					(e) =>
						e.isDirectory() &&
						!e.isSymbolicLink() &&
						isId(e.name) &&
						prefixOf(e.name) === "QEST",
				)
				.map((e) => join(dir, e.name)),
		);
		await inTurn(nested, (dir) => listed(dir, pass));
		level = nested;
	}
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
 * and, for a file the walk parses, its parsed record is the one kept;
 * else its bytes', which the walk then parses without reading it again.
 */
async function hashed(path: string, pass: Pass): Promise<void> {
	try {
		const st = await stat(path, { bigint: true });
		const vouched = vouchedHash(path, st);
		if (
			vouched !== undefined &&
			(!parsedByTheWalk(path) || recordFor(path, vouched))
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

/**
 * Whether the walk parses a file: a quest's README, or a markdown file
 * named as a document. Any other file in a kind folder is only hashed,
 * so its stamp is enough.
 */
function parsedByTheWalk(path: string): boolean {
	const name = basename(path);
	if (name === "README.md") return true;
	if (!name.endsWith(".md")) return false;
	const base = name.slice(0, -3);
	return isId(base) && prefixOf(base) !== "QEST";
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
