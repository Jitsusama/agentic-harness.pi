/**
 * What signing the quest tree reads, read off the thread: every listing,
 * stat, file and real path the signature and the walk would ask for,
 * read on a thread of its own (`tree-thread.ts`) into a pass they then
 * read from memory. A host runs it so its conversations don't wait on
 * the disk, nor the disk on them, while the tree is signed;
 * `discovery.ts` decides when.
 */

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isId, prefixOf } from "../creation/id.ts";
import {
	type Entry,
	hashRead,
	memo,
	newPass,
	type Pass,
	type Skipped,
	type StatOf,
	settled,
	skippable,
} from "./discovery-reads.ts";
import {
	type EntryKind,
	readTreeInThread,
	type TreeRead,
} from "./tree-thread.ts";

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
	/**
	 * For a signing that is kept, before its walk: put back the record of
	 * each file it skipped that a walk let go meanwhile, and answer each
	 * one's hash as the walk will find its record. A signing dropped
	 * never calls it, so it changes nothing a newer walk decided.
	 */
	readonly keep: () => void;
}

/**
 * Read everything signing `questsRoot` and walking it would, on a
 * thread of its own, reading again no file whose stamp still vouches.
 * The root's stat is taken first, so a quest made while it reads leaves
 * a stamp that no longer matches and the next ask signs at once.
 * Undefined when the memo was let go while it read, as a reload does,
 * since what it skipped is then vouched for by nothing the walk keeps.
 * Rejects when the thread fails, or reads past `hangsAfterMs`.
 */
export async function readTreeOffThread(
	questsRoot: string,
	hangsAfterMs: number,
): Promise<ReadOffThread | undefined> {
	const m = memo();
	const skip = skippable(parsedByTheWalk);
	const keys = new Map([...skip].map(([path, { stat }]) => [path, stat]));
	const read = await readTreeInThread(questsRoot, keys, hangsAfterMs);
	if (memo() !== m) return undefined;
	const pass = newPass();
	const rootStamp = read.root ? stampOf(read.root) : undefined;
	if (read.unlisted) pass.unlisted.set(questsRoot, read.unlisted);
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
	const keep = filesInto(read, skip, pass);
	return { pass, rootStamp, keep };
}

/**
 * Each file the thread read into the pass: its bytes' hash, or missing.
 * One it skipped holds the hash its stamp vouched for when the signing
 * began until the answer, `keep`, says which record the walk will find.
 * Nothing is read here, so the host's thread waits on no disk.
 */
function filesInto(
	read: TreeRead,
	skip: ReadonlyMap<string, Skipped>,
	pass: Pass,
): () => void {
	const skipped: [string, Skipped][] = [];
	for (const [path, st, bytes] of read.files) {
		if (!st) {
			pass.absent.add(path);
			continue;
		}
		if (bytes) {
			hashRead(path, st, bufferOf(bytes), pass);
			continue;
		}
		const vouched = skip.get(path);
		if (!vouched) throw new Error(`the thread skipped ${path} unasked`);
		pass.hashes.set(path, vouched.hash);
		skipped.push([path, vouched]);
	}
	return () => {
		for (const [path, vouched] of skipped)
			pass.hashes.set(path, vouched.keep());
	};
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
 * named as a document. Any other file in a kind folder, a README there
 * among them, is only hashed, so its stamp is enough.
 */
function parsedByTheWalk(path: string): boolean {
	const name = basename(path);
	if (name === "README.md") {
		const quest = basename(dirname(path));
		return isId(quest) && prefixOf(quest) === "QEST";
	}
	if (!name.endsWith(".md")) return false;
	const base = name.slice(0, -3);
	return isId(base) && prefixOf(base) !== "QEST";
}
