/**
 * Payloads a tool answered with, kept where they can be asked
 * about.
 *
 * A tool result has two audiences with opposite needs. The model
 * needs a few hundred bytes it can reason over; the caller who
 * then asks a precise question needs the whole thing. A store
 * settles the argument: the answer carries a bounded view and an
 * opaque handle, and the payload waits on disk until somebody
 * queries it.
 *
 * The store is its directory, not an object. Every family that
 * answers with a large payload puts it here, and the one tool that
 * queries them reads it back, and those are different extensions
 * in the same process holding different instances. So a handle
 * resolves against the directory rather than against whichever
 * instance happened to write it. An in-memory index would have
 * meant a handle cited by the browser tools was unreadable by the
 * query tool, which is the only thing a handle is for.
 *
 * The quota is what makes this safe to leave on everywhere. A long
 * session answering large questions would otherwise fill a disk
 * one honest payload at a time, so a put evicts the oldest
 * payloads until the directory fits again. It counts what is on
 * disk rather than what this instance remembers writing, for the
 * same reason handles resolve that way: several instances share
 * one directory, and a quota each of them enforced privately would
 * be a quota multiplied by however many there happened to be.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spillText } from "./spill.js";

/**
 * Raised when a handle no longer resolves: never issued, evicted
 * under quota, or its file has gone.
 */
export class HandleExpiredError extends Error {
	constructor(handle: string) {
		super(`result handle ${handle} is no longer available`);
		this.name = "HandleExpiredError";
	}
}

/** A payload on disk, and how to ask for it again. */
export interface StoredResult {
	handle: string;
	path: string;
	bytes: number;
}

/** A session's stored payloads, addressed by handle. */
export interface ResultStore {
	/** Keep a payload and return its handle, path and size. */
	put(text: string): StoredResult;
	/** Read a payload back, or throw HandleExpiredError if it is gone. */
	read(handle: string): string;
	/** Whether a handle still resolves. */
	has(handle: string): boolean;
	/** Forget every payload and delete every file. */
	clear(): void;
}

/**
 * The shape a handle must have to be looked up.
 *
 * A handle arrives from a language model, which means it can be
 * anything at all, including a relative path with enough parent
 * directories in it to leave the store. Handles are minted here
 * and this is what minting produces, so anything else is not a
 * handle and is refused before it reaches the filesystem.
 */
const HANDLE_PATTERN = /^result-[0-9a-f]{16}(?:-\d+)?$/;

/** The extension every stored payload is written under. */
const PAYLOAD_EXTENSION = ".json";

/**
 * Create a store backed by files under a directory.
 *
 * A payload larger than the whole quota is kept anyway, because it
 * is still the current result and the answer citing it must
 * resolve. That is the one case where the store knowingly sits
 * over its limit, and the next put brings it back down.
 */
export function createResultStore(deps: {
	dir: string;
	maxBytes?: number;
}): ResultStore {
	function pathFor(handle: string): string | undefined {
		if (!HANDLE_PATTERN.test(handle)) return undefined;
		return path.join(deps.dir, `${handle}${PAYLOAD_EXTENSION}`);
	}

	// By name, never by path: a spill reports the directory's real
	// path, the caller may have given us a symlinked one, and on macOS
	// those differ for anything under the temp directory. Comparing
	// paths there quietly evicted the payload we had just written and
	// were about to cite.
	function evictWhileOver(keepName: string): void {
		if (deps.maxBytes === undefined) return;
		let held = payloadsOnDisk(deps.dir);
		let total = held.reduce((sum, entry) => sum + entry.bytes, 0);
		// Oldest first, so what goes is what has had the longest
		// chance to be queried already.
		held = held.sort((a, b) => a.modifiedMs - b.modifiedMs);
		for (const entry of held) {
			if (total <= deps.maxBytes) break;
			if (path.basename(entry.path) === keepName) continue;
			try {
				fs.rmSync(entry.path, { force: true });
				total -= entry.bytes;
			} catch {
				// A file that will not delete still occupies disk, so its
				// bytes stay counted rather than the store claiming space it
				// did not reclaim.
			}
		}
	}

	return {
		put(text) {
			const written = spillText(text, deps.dir);
			const bytes = Buffer.byteLength(text, "utf-8");
			evictWhileOver(path.basename(written));
			return { handle: handleFor(written), path: written, bytes };
		},
		read(handle) {
			const file = pathFor(handle);
			if (!file) throw new HandleExpiredError(handle);
			try {
				return fs.readFileSync(file, "utf-8");
			} catch {
				throw new HandleExpiredError(handle);
			}
		},
		has(handle) {
			const file = pathFor(handle);
			return file !== undefined && fs.existsSync(file);
		},
		clear() {
			for (const entry of payloadsOnDisk(deps.dir)) {
				try {
					fs.rmSync(entry.path, { force: true });
				} catch {
					// Best effort: nothing further can be done about a stuck
					// file, and it will be reaped with the session directory.
				}
			}
		},
	};
}

/** Every payload currently in a store's directory, with its age and size. */
function payloadsOnDisk(
	dir: string,
): { path: string; bytes: number; modifiedMs: number }[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		// No directory yet means no payloads, which is not an error: the
		// first put is what creates it.
		return [];
	}
	const found: { path: string; bytes: number; modifiedMs: number }[] = [];
	for (const name of names) {
		if (!name.endsWith(PAYLOAD_EXTENSION)) continue;
		if (!HANDLE_PATTERN.test(name.slice(0, -PAYLOAD_EXTENSION.length)))
			continue;
		const full = path.join(dir, name);
		try {
			const stat = fs.statSync(full);
			if (!stat.isFile()) continue;
			found.push({ path: full, bytes: stat.size, modifiedMs: stat.mtimeMs });
		} catch {
			// It vanished between the listing and the stat, so it is not
			// holding any disk and does not belong in the tally.
		}
	}
	return found;
}

/** Derive a handle from a spilled file's path. */
function handleFor(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.replace(/\.[^.]+$/, "");
}
