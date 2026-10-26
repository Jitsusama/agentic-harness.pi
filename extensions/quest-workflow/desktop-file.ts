/**
 * The files quest-workflow keeps for the desktop to read: written by
 * a rename so a reader never sees half of one, and only when what
 * they say changed, since the launcher watches them.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../lib/internal/quest/io.ts";

/** Write a desktop file when its text differs; answers whether it wrote. */
export function writeWhenChanged(path: string, value: unknown): boolean {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (readOr(path) === text) return false;
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteFile(path, text);
	return true;
}

function readOr(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// No file yet: there is nothing to compare, so it is written.
		return undefined;
	}
}
