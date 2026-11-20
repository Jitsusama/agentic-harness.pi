/**
 * What signing the quest tree reads, read off the thread: every listing,
 * stat, file and real path the signature and the walk would ask for,
 * read on a thread of its own (`tree-thread.ts`) into a pass they then
 * read from memory. A host runs it so its conversations don't wait on
 * the disk, nor the disk on them, while the tree is signed;
 * `discovery.ts` decides when.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isId, prefixOf } from "../creation/id.ts";
import {
	type Entry,
	hashRead,
	newPass,
	type Pass,
	recordFor,
	type StatOf,
	settled,
	skippable,
	vouchedHash,
} from "./discovery-reads.ts";
import {
	type EntryKind,
	readTreeInThread,
	type StatRead,
	type TreeRead,
} from "./tree-thread.ts";

/**
 * The longest a signing's thread may read before its disk is taken to
 * hang and the thread is ended, as `discovery.ts` frees a hung
 * signing's root after as long.
 */
const READ_HANGS_AFTER_MS = 5 * 60_000;

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

function stampOf(st: StatOf): string | undefined {
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
	let readme: StatOf | undefined;
	try {
		readme = statSync(join(dir, "README.md"), { bigint: true });
	} catch {
		// No README: the folder's own stat moves when one is made.
		readme = undefined;
	}
	return joined(folder, readme);
}

/** A folder's stamp with its README's, "none" for a README not there. */
function joined(
	folder: string,
	readme: StatOf | undefined,
): string | undefined {
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
 * Read everything signing `questsRoot` and walking it would, on a
 * thread of its own, reading again no file whose stamp still vouches.
 * The root's stat is taken first, so a quest made while it reads leaves
 * a stamp that no longer matches and the next ask signs at once.
 * Rejects when the thread fails or its disk hangs.
 */
export async function readTreeOffThread(
	questsRoot: string,
): Promise<ReadOffThread> {
	const skip = skippable(
		(path, hash) => !parsedByTheWalk(path) || recordFor(path, hash),
	);
	const read = await readTreeInThread(questsRoot, skip, READ_HANGS_AFTER_MS);
	const pass = newPass();
	const rootStamp = read.root ? stampOf(read.root) : undefined;
	for (const [path, entries] of read.listings) {
		pass.listings.set(
			path,
			entries?.map(([name, kind]) => entryOf(name, kind)),
		);
	}
	for (const [path, real] of read.reals)
		pass.reals.set(path, real ?? undefined);
	for (const [dir, folder, readme] of read.pending) {
		const stamp = folder ? stampOf(folder) : undefined;
		pass.pending.set(
			dir,
			stamp === undefined ? undefined : joined(stamp, readme ?? undefined),
		);
	}
	await filesInto(read, pass);
	return { pass, rootStamp };
}

/**
 * Each file the thread read into the pass: a hash its stamp vouches
 * for, else its bytes', else missing. A file the thread skipped whose
 * stamp no longer vouches, since the memo moved on while it read, is
 * read here, off the thread.
 */
async function filesInto(read: TreeRead, pass: Pass): Promise<void> {
	for (const [path, st, bytes] of read.files) {
		if (!st) {
			pass.absent.add(path);
			continue;
		}
		if (bytes) {
			hashRead(path, st, bufferOf(bytes), pass);
			continue;
		}
		const vouched = vouchedHash(path, st);
		const enough =
			vouched !== undefined &&
			(!parsedByTheWalk(path) || recordFor(path, vouched));
		if (vouched !== undefined && enough) {
			pass.hashes.set(path, vouched);
			continue;
		}
		await readAgain(path, st, pass);
	}
}

/** A skipped file's bytes, read once its stamp no longer vouches. */
async function readAgain(
	path: string,
	st: StatRead,
	pass: Pass,
): Promise<void> {
	try {
		hashRead(path, st, await readFile(path), pass);
	} catch {
		// Missing or unreadable: the signature leaves it out, as it would.
		pass.absent.add(path);
	}
}

/** Bytes a thread sent, as the Buffer the walk hashes and parses. */
function bufferOf(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A listed entry rebuilt from the name and kind a thread sent. */
function entryOf(name: string, kind: EntryKind): Entry {
	return {
		name,
		isDirectory: () => kind === "d",
		isFile: () => kind === "f",
		isSymbolicLink: () => kind === "l",
	};
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
