/**
 * A folder told as the prompt tells it: from the nearest root, whose name
 * leads in text; outside any root, from home as `~`; and outside home, from
 * `/`, which leads muted since it says the least.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

export interface Told {
	/** Written before the first part: `/` for a folder told from the top. */
	readonly lead: string;
	/** The root's name or `~`, the folders between, then the folder itself. */
	readonly parts: readonly string[];
	/** How the first part reads. */
	readonly first: "text" | "muted";
}

/** The nearest folder at or above `dir` holding one of the markers. */
export function rootOf(
	dir: string,
	roots: readonly string[],
	exists: (file: string) => boolean = existsSync,
): string | null {
	let at = dir;
	while (true) {
		for (const marker of roots) {
			if (exists(path.join(at, marker))) return at;
		}
		const up = path.dirname(at);
		if (up === at) return null;
		at = up;
	}
}

function partsOf(relative: string): string[] {
	return relative.split("/").filter((part) => part.length > 0);
}

export function told(
	dir: string,
	roots: readonly string[],
	home: string,
	exists: (file: string) => boolean = existsSync,
): Told {
	const root = rootOf(dir, roots, exists);
	if (root && root !== "/") {
		return {
			lead: "",
			parts: [path.basename(root), ...partsOf(dir.slice(root.length))],
			first: "text",
		};
	}
	if (home && (dir === home || dir.startsWith(`${home}/`))) {
		return {
			lead: "",
			parts: ["~", ...partsOf(dir.slice(home.length))],
			first: "text",
		};
	}
	return { lead: "/", parts: partsOf(dir), first: "muted" };
}
