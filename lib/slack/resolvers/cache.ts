/**
 * Shared file-based cache for name → ID mappings.
 *
 * Used by channel and user resolvers. Each resolver gets its
 * own cache file under ~/.pi/agent/slack/. Entries are keyed
 * by lowercase name to avoid case-sensitivity issues.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Directory for resolver caches. */
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "slack");

/** A single cache entry mapping a name to an ID. */
interface CacheEntry {
	id: string;
	name: string;
	updatedAt: number;
}

/** Shape of a cache file: entries keyed by lowercase name. */
type CacheData = Record<string, CacheEntry>;

/** Ensure the cache directory exists. */
function ensureDir(): void {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** Read a cache file, returning an empty object if missing or corrupt. */
function readCache(filename: string): CacheData {
	try {
		const raw = fs.readFileSync(path.join(CACHE_DIR, filename), "utf-8");
		return JSON.parse(raw) as CacheData;
	} catch {
		// File doesn't exist or is corrupt.
		return {};
	}
}

/** Write a cache file. */
function writeCache(filename: string, data: CacheData): void {
	ensureDir();
	fs.writeFileSync(
		path.join(CACHE_DIR, filename),
		JSON.stringify(data, null, "\t"),
		"utf-8",
	);
}

/**
 * Look up a cached ID by name.
 * Returns the ID if found, null otherwise.
 */
export function lookupId(filename: string, name: string): string | null {
	const data = readCache(filename);
	return data[name.toLowerCase()]?.id ?? null;
}

/**
 * Look up a cached name by ID.
 * Reverse lookup: scans all entries for a matching ID.
 */
export function lookupName(filename: string, id: string): string | null {
	const data = readCache(filename);
	for (const entry of Object.values(data)) {
		if (entry.id === id) return entry.name;
	}
	return null;
}

/**
 * Store a name → ID mapping in the cache.
 * Called opportunistically whenever we see name/ID pairs in API responses.
 */
export function cacheMapping(filename: string, name: string, id: string): void {
	const data = readCache(filename);
	data[name.toLowerCase()] = { id, name, updatedAt: Date.now() };
	writeCache(filename, data);
}

/**
 * List all cached entries, sorted by name.
 */
export function listCached(
	filename: string,
): Array<{ name: string; id: string }> {
	const data = readCache(filename);
	return Object.values(data)
		.map((e) => ({ name: e.name, id: e.id }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
