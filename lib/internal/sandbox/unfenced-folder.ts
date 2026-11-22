/**
 * Folders a sandbox won't let a command take as its own to write, since
 * what's written there is read later outside every sandbox: the home
 * folder's startup files, a repository's git folder, the records a
 * machine's mycelium node trusts, and the code pi's host compiled for
 * the next one. Strict makes a command's folder writable, on Linux and the Mac
 * alike, and pi's file tools write it, so each asks here first. Closing
 * these to the fence's other commands is its own lists' work: the node's
 * records and pi's state are read-only there, and node's and jiti's
 * caches in the temporary folder are the fence's own
 * (fence-temp-caches.ts).
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { compileCacheFolder } from "../fence/compile-cache-place.ts";
import { tempCodeCaches } from "../fence/fence-temp-caches.ts";
import { cacheDir, stateDir } from "../paths.ts";
import { within } from "./tree-git.ts";

/**
 * What a session's own refusal of its folder names as refusing: the
 * sandbox's variable set to strict, as `sandbox.ts` names them.
 */
export const ASKED = "PI_SANDBOX=strict";

/**
 * Where a machine's node reads what it trusts: pi's host records, which
 * say each hosted session's fence, and the node's own state. A command
 * that could write one could tell the node a session is fenced tighter
 * than it is (ISXEG8, 19 November). Strict refuses both as a command's
 * folder, and the agent fence keeps both read-only (fence-home.ts).
 */
export function nodeRecords(home: string): string[] {
	return unique([
		join(home, ".local/state/pi/agentic-harness.pi/hosts"),
		join(home, ".local/state/mycelium"),
		stateDir("hosts"),
	]);
}

/**
 * Where pi and its host keep the code they compiled, which the next one
 * started outside every sandbox runs as its own (ISXEG8, 19 November):
 * the host's cache and node's in pi's state, where they now lie, and
 * in the cache folder, where an older install kept the host's, and
 * node's and jiti's in the temporary folder, where a pi left to itself
 * keeps them. The fence holds each closed to its other commands but
 * the older install's, in the cache folder, which every fenced command
 * may write: this install compiles into pi's state, so only a rollback
 * to one that compiled there would run what a command left. Strict
 * would make any of them writable as a command's own folder.
 */
export function compiledCode(home: string): string[] {
	return unique([
		join(home, ".local/state/pi/agentic-harness.pi/host-compile"),
		join(home, ".local/state/pi/agentic-harness.pi/node-compile-cache"),
		stateDir("host-compile"),
		compileCacheFolder(),
		join(home, ".cache/pi/agentic-harness.pi/host-compile"),
		cacheDir("host-compile"),
		...tempCodeCaches(),
	]);
}

function unique(paths: string[]): string[] {
	return [...new Set(paths)];
}

/**
 * Why the sandbox can't let commands write `cwd`, when it can't: its
 * writes would reach what runs outside the sandbox later, as `asker` says.
 */
export function unfencedFolder(cwd: string, home: string, asker = ASKED) {
	const refusing = (holds: string) =>
		`${asker} won't let commands write ${cwd}, which holds ${holds}, so no command runs. Start it in the folder it works on.`;
	if (within(home, cwd)) {
		return refusing(
			"the home folder and the startup files that run outside the sandbox",
		);
	}
	const records = nodeRecords(home);
	if (records.some((folder) => within(folder, cwd) || within(cwd, folder))) {
		return refusing(
			"or lies in the records this machine's node trusts (its own and pi's host records)",
		);
	}
	const code = compiledCode(home);
	if (code.some((folder) => within(folder, cwd) || within(cwd, folder))) {
		return refusing(
			"or lies in the code pi and its host compiled, which the next one runs outside the sandbox",
		);
	}
	try {
		if (statSync(join(cwd, ".git")).isDirectory()) {
			return `${asker} won't let commands write ${cwd}, which holds its repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Work in a tree the work tool cuts (\`work tree\`) or a snapshot, whose git folder lies elsewhere; a plain clone won't do.`;
		}
	} catch {
		// No git folder here, or a worktree's .git file pointing elsewhere.
	}
	return undefined;
}
