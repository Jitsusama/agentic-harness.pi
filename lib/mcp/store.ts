import * as fs from "node:fs";
import { spillToFile } from "./content.js";

/** Raised when a result handle no longer resolves: unknown, evicted, or its file vanished. */
export class HandleExpiredError extends Error {
	constructor(handle: string) {
		super(`result handle ${handle} is no longer available`);
		this.name = "HandleExpiredError";
	}
}

/** A payload spilled to disk under an opaque handle. */
export interface StoredResult {
	handle: string;
	path: string;
	bytes: number;
}

/** A session-scoped store of spilled tool-result payloads, addressed by handle. */
export interface ResultStore {
	/** Spill a payload and return its handle, path and size. */
	put(text: string): StoredResult;
	/** Read a payload back by handle, or throw HandleExpiredError if it is gone. */
	read(handle: string): string;
	/** Whether a handle still resolves. */
	has(handle: string): boolean;
	/** Delete every spilled file and forget every handle. */
	clear(): void;
}

/**
 * Create a session-scoped result store backed by files under `dir`.
 *
 * Each `put` spills the payload and registers a handle. When the total spilled
 * size exceeds `maxBytes`, the oldest entries are evicted (their files deleted)
 * until the store fits again, so a run of large results cannot grow the store
 * without bound. A handle that was never issued, was evicted, or whose file
 * vanished raises HandleExpiredError rather than returning stale or empty text.
 */
export function createResultStore(deps: {
	dir: string;
	maxBytes?: number;
}): ResultStore {
	const entries = new Map<string, { path: string; bytes: number }>();
	let totalBytes = 0;

	// Evict oldest entries while over quota, never the one just added: a payload
	// larger than the whole quota is still the current result and must remain
	// readable, so it is kept even though it alone exceeds maxBytes. Disk is only
	// counted as reclaimed when the file is actually removed.
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
				// A file we cannot remove still occupies disk, so leave its byte count
				// standing and its handle live rather than lying about reclaimed space.
			}
		}
	}

	return {
		put(text) {
			const path = spillToFile(text, deps.dir);
			const bytes = Buffer.byteLength(text, "utf-8");
			const handle = fileHandle(path);
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
					// Best-effort cleanup; nothing else can be done about a stuck file.
				}
			}
			entries.clear();
			totalBytes = 0;
		},
	};
}

/** Derive a stable handle from a spilled file's name. */
function fileHandle(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.replace(/\.txt$/, "");
}
