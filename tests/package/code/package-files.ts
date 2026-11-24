/**
 * The package's files, as code-health reads them, for the count rules
 * beside this: what git keeps or would keep, or, with no git at the root,
 * as in the copy of a head merge-gate.sh judges, every file. merge-gate.sh
 * runs main's copy of this with main's copies of the rules, so a head
 * can't hide a file from them by changing it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The files under `root`, by their path from it. Links are passed by, not
 * followed, so one to / can't walk the disk.
 */
export function packageFiles(root: string): string[] {
	const git = (...args: string[]) =>
		spawnSync("git", args, { cwd: root, encoding: "utf8" });
	const top = git("rev-parse", "--show-toplevel");
	if (
		top.status !== 0 ||
		realpathSync(top.stdout.trim()) !== realpathSync(root)
	) {
		return filesUnder(root, root);
	}
	const kept = git(
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
	);
	return kept.stdout.split("\0").filter((file) => {
		const path = join(root, file);
		return file !== "" && existsSync(path) && !lstatSync(path).isSymbolicLink();
	});
}

/** Every file under `dir` but git's own, by its path from `root`. */
function filesUnder(root: string, dir: string): string[] {
	return readdirSync(dir)
		.filter((entry) => entry !== ".git")
		.flatMap((entry) => {
			const path = join(dir, entry);
			const kind = lstatSync(path);
			if (kind.isSymbolicLink()) return [];
			return kind.isDirectory()
				? filesUnder(root, path)
				: [relative(root, path)];
		});
}

/** What code-health reads as code, by extension, as its measure.rs lists it. */
const CODE = new Set([
	"bash",
	"c",
	"cc",
	"cjs",
	"cpp",
	"go",
	"h",
	"js",
	"lua",
	"mjs",
	"nix",
	"py",
	"qml",
	"rb",
	"rs",
	"sh",
	"tf",
	"ts",
	"tsx",
]);

/**
 * A file's extension as measure.rs takes it: what follows the last dot of
 * its name, so `lib/.ts` is a `ts` file, where node's extname finds none.
 */
export function extensionOf(file: string): string {
	const name = file.slice(file.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1);
}

/** Whether a file is code code-health counts: of its extensions, and not generated. */
export function isCode(file: string): boolean {
	const generated =
		file.endsWith(".min.js") || file.split("/").includes("node_modules");
	return !generated && CODE.has(extensionOf(file));
}
