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
 * The quota is what makes this safe to use everywhere. A long
 * session answering large questions would otherwise fill a disk
 * one honest payload at a time, so the oldest entries are evicted
 * once the total is over, and the payload just added is never the
 * one evicted: it is the current answer, and a handle cited in
 * the same breath must resolve.
 */

import * as fs from "node:fs";
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
 * Create a store backed by files under a directory.
 *
 * A payload larger than the whole quota is kept anyway, because
 * it is still the current result and must be readable. That is
 * the one case where the store knowingly sits over its limit, and
 * the next put brings it back down.
 */
export function createResultStore(deps: {
	dir: string;
	maxBytes?: number;
}): ResultStore {
	const entries = new Map<string, { path: string; bytes: number }>();
	let totalBytes = 0;

	function evictWhileOver(keep: string): void {
		if (deps.maxBytes === undefined) return;
		for (const [handle, entry] of entries) {
			if (totalBytes <= deps.maxBytes) break;
			if (handle === keep) continue;
			try {
				fs.rmSync(entry.path, { force: true });
				totalBytes -= entry.bytes;
				entries.delete(handle);
			} catch {
				// A file that will not delete still occupies disk, so its
				// bytes stay counted and its handle stays live rather than
				// the store lying about space it did not reclaim.
			}
		}
	}

	return {
		put(text) {
			const path = spillText(text, deps.dir);
			const bytes = Buffer.byteLength(text, "utf-8");
			const handle = handleFor(path);
			entries.set(handle, { path, bytes });
			totalBytes += bytes;
			evictWhileOver(handle);
			return { handle, path, bytes };
		},
		read(handle) {
			const entry = entries.get(handle);
			if (!entry) throw new HandleExpiredError(handle);
			try {
				return fs.readFileSync(entry.path, "utf-8");
			} catch {
				// The file is gone, so the handle is too. Forgetting it here
				// keeps a later has() honest instead of hopeful.
				entries.delete(handle);
				totalBytes -= entry.bytes;
				throw new HandleExpiredError(handle);
			}
		},
		has(handle) {
			const entry = entries.get(handle);
			return entry !== undefined && fs.existsSync(entry.path);
		},
		clear() {
			for (const entry of entries.values()) {
				try {
					fs.rmSync(entry.path, { force: true });
				} catch {
					// Best effort: nothing further can be done about a stuck
					// file, and the handle is being forgotten regardless.
				}
			}
			entries.clear();
			totalBytes = 0;
		},
	};
}

/** Derive a stable handle from a spilled file's name. */
function handleFor(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.replace(/\.[^.]+$/, "");
}
