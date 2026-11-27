/**
 * The program a signing's thread runs (tree-thread.ts): it reads what a
 * signing on the host's thread used to, in the same order: the root's
 * stat, its listing, real paths, each quest's stamps then listing,
 * nested quests to the walk's depth, kind folders, then each file, read
 * only where its stat doesn't match the key it may be skipped at. A
 * root that won't list is sent with how it stands (root-standing.mjs),
 * so the host's thread need not read it again.
 *
 * Every read is synchronous, so it holds only this thread. Through
 * promises it would take the process's filesystem threads, which every
 * conversation's own reads, lookups and compression wait on.
 *
 * Plain `.mjs` because node runs it directly as a thread, from where
 * consumers install this package, and won't strip types there. The
 * skip key is `statKey`'s format in discovery-reads.ts, and what it
 * picks to read is what discovery-walk.ts walks; off-thread.test.ts
 * holds both.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { rootStanding } from "./root-standing.mjs";

/** @typedef {import("./tree-thread.ts").StatRead} StatRead */
/** @typedef {import("./tree-thread.ts").EntryKind} EntryKind */
/** @typedef {[string, EntryKind]} Listed */

/**
 * @type {{
 *   root: string,
 *   skip: [string, string][],
 *   depth: number,
 *   kinds: readonly string[],
 *   id: string,
 * }}
 */
const { root, skip, depth, kinds, id } = workerData;
const skips = new Map(skip);
const isId = new RegExp(id);
const NS_PER_MS = 1_000_000n;
/** @type {[string, Listed[] | null][]} */
const listings = [];
/** @type {Map<string, Listed[] | undefined>} */
const listingOf = new Map();
/** @type {[string, string | null][]} */
const reals = [];
/** @type {[string, StatRead | null, StatRead | null][]} */
const pending = [];
/** @type {[string, StatRead | null, Uint8Array | null][]} */
const files = [];
/** @type {ArrayBuffer[]} */
const moved = [];

/** @param {string} name */
function quest(name) {
	return isId.test(name) && name.startsWith("QEST-");
}

/**
 * @param {import("node:fs").Dirent} entry
 * @returns {EntryKind}
 */
function kindOf(entry) {
	if (entry.isSymbolicLink()) return "l";
	if (entry.isDirectory()) return "d";
	return entry.isFile() ? "f" : "o";
}

/**
 * @param {string} path
 * @returns {{ st: StatRead, file: boolean } | undefined}
 */
function statOf(path) {
	try {
		const st = statSync(path, { bigint: true });
		const at = BigInt(Date.now()) * NS_PER_MS;
		const { size, mtimeNs, ctimeNs, ino } = st;
		return { st: { size, mtimeNs, ctimeNs, ino, at }, file: st.isFile() };
	} catch {
		// Not there or not readable: the caller records it as missing.
		return undefined;
	}
}

/**
 * @param {string} path
 * @returns {Listed[] | undefined}
 */
function listed(path) {
	/** @type {Listed[] | undefined} */
	let entries;
	try {
		const found = readdirSync(path, { withFileTypes: true });
		entries = found.map((entry) => [entry.name, kindOf(entry)]);
	} catch {
		// No folder to list: recorded as null, as the walk reads it.
		entries = undefined;
	}
	listingOf.set(path, entries);
	listings.push([path, entries ?? null]);
	return entries;
}

/** @param {string} path */
function resolved(path) {
	try {
		reals.push([path, realpathSync(path)]);
	} catch {
		// Recorded as null, which the walk takes as a folder it can't place.
		reals.push([path, null]);
	}
}

/** @param {string} dir */
function stamped(dir) {
	const folder = statOf(dir);
	const readme = folder ? statOf(join(dir, "README.md")) : undefined;
	pending.push([dir, folder ? folder.st : null, readme ? readme.st : null]);
}

/**
 * Its bytes, moved to the host rather than copied, where they own their
 * memory whole.
 *
 * @param {Buffer} bytes
 */
function sent(bytes) {
	const whole = bytes.byteOffset === 0;
	if (whole && bytes.byteLength === bytes.buffer.byteLength)
		moved.push(/** @type {ArrayBuffer} */ (bytes.buffer));
	return bytes;
}

/** @param {string} path */
function hashed(path) {
	const found = statOf(path);
	if (!found?.file) {
		files.push([path, null, null]);
		return;
	}
	const { st } = found;
	const key = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
	if (skips.get(path) === key) {
		files.push([path, st, null]);
		return;
	}
	try {
		files.push([path, st, sent(readFileSync(path))]);
	} catch {
		// Gone or unreadable since its stat: the signature leaves it out.
		files.push([path, null, null]);
	}
}

/** @param {string[]} level */
function nestedIn(level) {
	return level.flatMap((dir) =>
		(listingOf.get(dir) ?? [])
			.filter(([name, kind]) => kind === "d" && quest(name))
			.map(([name]) => join(dir, name)),
	);
}

/** @param {string[]} questDirs */
function kindFoldersOf(questDirs) {
	/** @type {string[]} */
	const found = [];
	for (const dir of questDirs) {
		const entries = listingOf.get(dir) ?? [];
		for (const k of kinds) {
			const there = entries.some(
				([name, kind]) => name === k && (kind === "d" || kind === "l"),
			);
			if (there) found.push(join(dir, k));
		}
	}
	return found;
}

function readTree() {
	const top = statOf(root);
	const rootEntries = listed(root);
	if (rootEntries) {
		const folders = rootEntries
			.filter(([name, kind]) => kind === "d" && !name.startsWith("."))
			.map(([name]) => name);
		const questDirs = folders
			.filter((name) => quest(name))
			.map((name) => join(root, name));
		resolved(root);
		for (const name of folders) resolved(join(root, name));
		// Stamped before it is listed, so a README made while this reads
		// leaves a stamp that no longer matches.
		for (const dir of questDirs) {
			stamped(dir);
			listed(dir);
		}
		let level = questDirs;
		for (let d = 1; d <= depth && level.length > 0; d++) {
			level = nestedIn(level);
			for (const dir of level) listed(dir);
		}
		const kindDirs = kindFoldersOf(questDirs);
		for (const dir of kindDirs) listed(dir);
		for (const dir of questDirs) hashed(join(dir, "README.md"));
		for (const dir of kindDirs) {
			for (const [name, kind] of listingOf.get(dir) ?? [])
				if (kind === "f") hashed(join(dir, name));
		}
	}
	// Read here, beside the listing it explains, rather than later on the
	// host's thread, where a first quest made meanwhile would read as a
	// fault in a root that had none. One made in the gap between the two
	// still does, until the root is next listed (root-standing.mjs).
	const unlisted = rootEntries ? null : rootStanding(root);
	const answer = {
		root: top ? top.st : null,
		unlisted,
		listings,
		reals,
		pending,
		files,
	};
	parentPort?.postMessage(answer, moved);
}

try {
	readTree();
} catch (error) {
	parentPort?.postMessage({ failed: String(error) });
}
