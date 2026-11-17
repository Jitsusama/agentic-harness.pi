/**
 * Whether a held conversation's session file is gone for good, which a
 * start drops the hold for, since nothing could ever resume it.
 *
 * The drop can't be undone, so only a file the disk says isn't there,
 * in a folder that is, counts as gone. A folder missing too may be a
 * disk not yet mounted, and a file that can't be looked at (no
 * permission, a fault) may be there after all: the hold stays, and its
 * resume says what is wrong.
 */

import { statSync } from "node:fs";
import { dirname } from "node:path";

/** True only when `file` is missing from a folder that is there. */
export function sessionFileGone(file: string): boolean {
	if (lookAt(file) !== "missing") return false;
	return lookAt(dirname(file)) === "there";
}

function lookAt(path: string): "there" | "missing" | "unknown" {
	try {
		statSync(path);
		return "there";
	} catch (error) {
		return codeOf(error) === "ENOENT" ? "missing" : "unknown";
	}
}

function codeOf(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}
