/**
 * What `work record` would sweep in when no paths are named.
 *
 * With no paths, record stages everything, untracked files included, which
 * is right for the ordinary case: an untracked file is new work. It went
 * wrong on 12 October, when a branch lacked the `.gitignore` its sibling
 * had, and a Rust `target/` directory was committed and pushed before
 * anybody noticed. A build's output is never work, a commit of it reaches
 * whoever pulls, and taking it back out means rewriting a pushed branch.
 *
 * So a sweep that would take build output in, or a pile of untracked files
 * far past what a change usually adds, is refused before anything is
 * staged. The refusal names what it found and the two ways on: ignore it,
 * or name the paths to record. Naming paths is also how such files are
 * committed on purpose, since then nothing is being swept.
 */

import type { ChangedPath } from "../../../lib/core/work/index.ts";
import { count } from "../../../lib/ui/index.ts";

/**
 * Directory names that only ever hold what a build or a tool made.
 *
 * Each is a name its toolchain writes by default: Rust and Maven's
 * `target`, JavaScript's `node_modules`, `.next` and `.turbo`, Python's
 * caches and virtual environments, direnv's cache, Gradle's, Terraform's
 * and Zig's. Names that are just as often source, such as `build`, `dist`
 * and `out`, are left out, since refusing real work costs more than the
 * large-sweep limit below leaves uncaught.
 */
export const BUILD_OUTPUT: ReadonlySet<string> = new Set([
	"target",
	"node_modules",
	".next",
	".turbo",
	"__pycache__",
	".venv",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".direnv",
	".gradle",
	".terraform",
	".zig-cache",
	"zig-out",
]);

/**
 * How many untracked files one sweep may take in.
 *
 * Far past what a change adds by hand: the most new files any one commit
 * added is 107 in this harness's history and 204 in its core's, counted
 * on 22 October 2026. A vendored tree or an unignored cache is what goes
 * past it.
 */
export const SWEEP_LIMIT = 500;

/** How many directories a refusal names before saying how many more. */
const NAMED = 5;

/**
 * Why sweeping these changes in would be a mistake, or undefined when it
 * would not.
 */
export function sweepObjection(
	changed: readonly ChangedPath[],
): string | undefined {
	const untracked = changed.filter((c) => c.kind === "untracked");

	const output = new Map<string, number>();
	for (const { path } of untracked) {
		const at = outputDirectoryOf(path);
		if (at !== undefined) output.set(at, (output.get(at) ?? 0) + 1);
	}
	if (output.size > 0) {
		return `Nothing was recorded: with no paths named, record would also commit build output, ${named(output)}. Add ${output.size === 1 ? "it" : "them"} to .gitignore and record again, or name the paths to record, which is also how to commit such files on purpose.`;
	}

	if (untracked.length > SWEEP_LIMIT) {
		const tops = new Map<string, number>();
		for (const { path } of untracked) {
			const slash = path.indexOf("/");
			const top = slash === -1 ? path : `${path.slice(0, slash)}/`;
			tops.set(top, (tops.get(top) ?? 0) + 1);
		}
		return `Nothing was recorded: with no paths named, record would commit ${count(untracked.length, "untracked file")}, more than the ${SWEEP_LIMIT} a sweep may take in, most of them under ${named(tops)}. Ignore what is not work, or name the paths to record; paths ["."] records everything.`;
	}

	return undefined;
}

/** The path up to and including its first build-output directory. */
function outputDirectoryOf(path: string): string | undefined {
	const parts = path.split("/");
	// The last part is the file itself, which no directory name can match.
	for (let i = 0; i < parts.length - 1; i++) {
		if (BUILD_OUTPUT.has(parts[i] ?? "")) {
			return `${parts.slice(0, i + 1).join("/")}/`;
		}
	}
	return undefined;
}

/** The directories with the most files, each with its count. */
function named(counts: Map<string, number>): string {
	const ranked = [...counts].sort((a, b) => b[1] - a[1]);
	const shown = ranked
		.slice(0, NAMED)
		.map(([dir, n]) => `${dir} (${count(n, "file")})`);
	const more = ranked.length - shown.length;
	return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}
