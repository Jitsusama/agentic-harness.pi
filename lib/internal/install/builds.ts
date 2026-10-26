/**
 * Which dependencies' build scripts an install skipped.
 *
 * pnpm 10 runs a dependency's install script only when the package
 * allows it in `pnpm.onlyBuiltDependencies`, and records each one it
 * skipped under `ignoredBuilds` in `node_modules/.modules.yaml`. A
 * native module skipped that way installs without its binding, and
 * nothing fails until it is imported. On 26 October pi updated the
 * harness with pnpm 10, sqlite3's binding was never built, and the
 * memory and observability extensions failed in every session that
 * reloaded onto it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isRecord } from "../record.ts";

/**
 * The dependencies whose builds the last install in `root` skipped, as
 * pnpm names them (`sqlite3@6.0.1`), or none when nothing says so.
 */
export function skippedBuilds(root: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(root, "node_modules", ".modules.yaml"), "utf8");
	} catch {
		// No pnpm install here, or none finished: nothing it skipped.
		return [];
	}
	let state: unknown;
	try {
		state = parseYaml(text);
	} catch {
		// A record pnpm is still writing, or one it no longer writes.
		return [];
	}
	if (!isRecord(state) || !Array.isArray(state.ignoredBuilds)) return [];
	return state.ignoredBuilds.filter(
		(name): name is string => typeof name === "string",
	);
}

/** A dependency's name without the version pnpm adds (`@a/b@1.0.0`). */
export function packageName(skipped: string): string {
	const at = skipped.lastIndexOf("@");
	return at > 0 ? skipped.slice(0, at) : skipped;
}
