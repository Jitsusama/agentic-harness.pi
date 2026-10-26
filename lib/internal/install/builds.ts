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
 *
 * The record alone is not the answer, though. It says what the last
 * install skipped, and a build run since (by hand, or by a pnpm that
 * found nothing else to do and left the record alone) does not clear
 * it: at 13:30 that day every session was told sqlite3 was unbuilt
 * beside a binding built at 12:28. So a skipped package counts as
 * unbuilt only while no native binding sits in its folder.
 */

import { readdirSync, readFileSync } from "node:fs";
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

/** Where a native module's install puts what it built or fetched. */
const BINDING_DIRS = ["build", "prebuilds"];

/** Whether a package's folder holds a native binding, a `.node` file. */
function hasBinding(dir: string): boolean {
	return BINDING_DIRS.some((sub) => {
		try {
			return readdirSync(join(dir, sub), { recursive: true }).some((entry) =>
				String(entry).endsWith(".node"),
			);
		} catch {
			// No such folder: nothing built there.
			return false;
		}
	});
}

/**
 * The folders pnpm may have put a skipped package in: the link at the
 * top of `node_modules`, and its own folder in the store beside it,
 * named with `+` for a scope's slash.
 */
function packageDirs(root: string, skipped: string): string[] {
	const name = packageName(skipped);
	return [
		join(root, "node_modules", name),
		join(
			root,
			"node_modules",
			".pnpm",
			skipped.replace("/", "+"),
			"node_modules",
			name,
		),
	];
}

/**
 * The dependencies an install skipped building that still have no
 * binding, by name (`sqlite3`): what imports them fails.
 */
export function unbuiltDependencies(root: string): string[] {
	return skippedBuilds(root)
		.filter((skipped) => !packageDirs(root, skipped).some(hasBinding))
		.map(packageName);
}

/** A dependency's name without the version pnpm adds (`@a/b@1.0.0`). */
export function packageName(skipped: string): string {
	const at = skipped.lastIndexOf("@");
	return at > 0 ? skipped.slice(0, at) : skipped;
}
