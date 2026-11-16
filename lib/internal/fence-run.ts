/**
 * A command fenced for a caller outside pi (`scripts/pi-fence.ts`), such
 * as the mycelium node starting an agent's `mycelium run`: the same
 * fence pi's own commands get, so nothing outside keeps a copy of its
 * rules to drift (ISXEG8, a735ba8b).
 *
 * - **fence** is the agent fence as a fenced session's bash has it
 *   (`sandbox.ts`'s `wrapFor`): bubblewrap's root, then landrun with
 *   every path and only the listed sockets.
 * - **strict** is the strict profile's landrun, which reads and runs only
 *   what it lists and writes only the folder and its own, inside the
 *   fence's bubblewrap root: the runtime folder emptied, X's sockets
 *   gone, the home's secrets hidden. Either layer alone refuses the
 *   person's sockets on a current kernel; both stand, so an older
 *   kernel's Landlock that let a connect through still finds nothing
 *   there.
 *
 * The folder is where the command runs and what it may write, the
 * working directory when none is named. One that is the home folder,
 * holds it, or holds its repository's git folder is refused, since its
 * writes would reach what runs outside later. A machine without
 * bubblewrap or landrun in the system's own profile refuses too: nothing
 * runs unfenced because the fence couldn't be laid.
 */

import { mkdirSync } from "node:fs";
import { fenceArgs } from "./fence.ts";
import {
	SANDBOX_VARIABLE,
	type Sandbox,
	STRICT,
	sandboxedCommand,
	sandboxFolders,
	sandboxFor,
	strictRules,
	unfencedFolder,
	wrapFor,
} from "./sandbox.ts";
import { quoted } from "./sandbox-shell.ts";
import { sessionWorktrees } from "./sandbox-trees.ts";
import { real, worktreeRepository } from "./tree-git.ts";

/** The fences a caller may ask for, by the names pi's sessions use. */
export const FENCE_RUN_KINDS = ["fence", STRICT] as const;

/** A fence a caller may ask for. */
export type FenceRunKind = (typeof FENCE_RUN_KINDS)[number];

/** What a caller asked to run, and in which fence. */
export interface FenceRunAsk {
	readonly kind: FenceRunKind;
	/** Where it runs and what it may write, as asked. */
	readonly folder: string;
	/** The program and its arguments, as given after `--`. */
	readonly words: readonly string[];
}

/** How pi-fence is asked, said when it was asked wrongly. */
export const FENCE_RUN_USAGE =
	"usage: pi-fence --kind fence|strict [--folder DIR] -- PROGRAM [ARGUMENT...]";

/**
 * What `args` ask for, run from `cwd`, or what is wrong with them: a
 * kind is required, the folder is the working directory unless named,
 * and every word after `--` is the command's, flags included.
 */
export function fenceRunAsked(
	args: readonly string[],
	cwd: string,
): FenceRunAsk | { readonly wrong: string } {
	const split = args.indexOf("--");
	if (split === -1) return { wrong: `nothing follows --. ${FENCE_RUN_USAGE}` };
	const words = args.slice(split + 1);
	if (words.length === 0) {
		return { wrong: `no program follows --. ${FENCE_RUN_USAGE}` };
	}
	const options = args.slice(0, split);
	let kind: string | undefined;
	let folder: string | undefined;
	for (let at = 0; at < options.length; at += 2) {
		const [name, value] = [options[at], options[at + 1]];
		if (value === undefined) {
			return { wrong: `${name} needs a value. ${FENCE_RUN_USAGE}` };
		}
		if (name === "--kind") kind = value;
		else if (name === "--folder") folder = value;
		else return { wrong: `${name} is no option. ${FENCE_RUN_USAGE}` };
	}
	const known = FENCE_RUN_KINDS.find((each) => each === kind);
	if (known === undefined) {
		return {
			wrong: `--kind ${kind ?? "is missing"}: it is fence or strict. ${FENCE_RUN_USAGE}`,
		};
	}
	return { kind: known, folder: folder ?? cwd, words };
}

/** Where a fenced run takes its machine from; tests give their own. */
export interface FenceRunPlace {
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	/** The fence this machine can lay, `sandbox.ts`'s reading of it. */
	readonly sandbox?: Sandbox;
}

/**
 * The shell text that runs `ask` fenced, to be run by bash in its
 * folder, or why it can't be.
 */
export function fenceRunText(
	ask: FenceRunAsk,
	place: FenceRunPlace,
):
	| { readonly folder: string; readonly text: string }
	| { readonly refused: string } {
	const folder = real(ask.folder);
	const { home } = place;
	const env: NodeJS.ProcessEnv = {
		...place.env,
		[SANDBOX_VARIABLE]: "fence",
	};
	const unfenced = unfencedFolder(folder, home, `pi-fence --kind ${ask.kind}`);
	if (unfenced) return { refused: unfenced };
	const sandbox = place.sandbox ?? sandboxFor(env);
	if (sandbox.kind !== "fence") {
		return {
			refused:
				sandbox.kind === "refused"
					? sandbox.reason
					: "this machine lays no fence, so nothing runs",
		};
	}
	const command = ask.words.map(quoted).join(" ");
	if (ask.kind === "fence") {
		const wrap = wrapFor(sandbox, { cwd: folder, env }, home);
		return wrap
			? { folder, text: wrap(command) }
			: { refused: "this machine lays no fence, so nothing runs" };
	}
	// landrun skips a path that isn't there, and nothing inside could
	// make one, so the strict profile's own folders are made first.
	for (const own of Object.values(sandboxFolders(home))) {
		mkdirSync(own, { recursive: true, mode: 0o700 });
	}
	const runtimeDir = env.XDG_RUNTIME_DIR;
	const inner = sandboxedCommand(
		command,
		strictRules({
			home,
			runtimeDir,
			cwd: folder,
			repository: worktreeRepository(folder, home),
		}),
		sandbox.landrun,
	);
	const root = fenceArgs({
		home,
		runtimeDir,
		...sessionWorktrees(folder, undefined),
	});
	return {
		folder,
		text: [
			quoted(sandbox.bwrap),
			...root.map(quoted),
			"-- bash -c",
			quoted(inner),
		].join(" "),
	};
}
