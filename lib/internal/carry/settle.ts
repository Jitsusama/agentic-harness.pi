/**
 * Letting go of the place a carried session left, once it has arrived:
 * `pi-carry settle`, run by the mycelium node on the machine it left,
 * only after the arrival is confirmed and the carry has passed the
 * launcher's Carried day, so a Carry Back within the day lands on trees
 * still whole (KP0L6A, 16 Nov).
 *
 * Each tree the session's done file names goes only when it holds
 * nothing the carry lacks: on the branch it was carried on, at the
 * commit carried, with uncommitted changes the same as the patch that
 * went. One holding anything since keeps every tree where it is, named
 * with why, since its work went nowhere. Only a worktree is let go, and
 * by git, which leaves its branch naming its commits; a checkout of its
 * own stays, being the person's. Files git ignores go with the worktree,
 * as the carry left them out: build output, never work.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { patchChanges } from "./changes.ts";
import {
	doneFileOf,
	type HandedTree,
	readHandover,
	underHome,
} from "./handover.ts";

/** One line settling says, as `pi-carry settle` prints it. */
export type SettleLine =
	| {
			readonly kind: "tree";
			/** Within home, as the done file names it. */
			readonly path: string;
			readonly did: "let go" | "gone" | "stays" | "kept";
			readonly why?: string;
	  }
	| { readonly kind: "settled"; readonly session: string; readonly let: number }
	| { readonly kind: "failed"; readonly why: string };

/** What settling needs. */
export interface Settling {
	readonly exec: Exec;
	/** This machine's handover folder for the quest, holding the done file. */
	readonly from: string;
	readonly session: string;
	readonly home: string;
	/** Whether a pi runs the session on this machine again. */
	readonly runsHere: boolean;
	readonly say: (line: SettleLine) => void;
}

/** What one tree's judgement found. */
type Judged =
	| { readonly kind: "gone" | "stays" }
	| { readonly kind: "whole"; readonly folder: string; readonly gitDir: string }
	| { readonly kind: "kept"; readonly why: string };

/**
 * Lets go of each worktree the session's done file names, or of none
 * when any holds work the carry lacks; answers whether it settled.
 */
export async function settle(settling: Settling): Promise<boolean> {
	const { exec, from, session, home, say } = settling;
	const done = readHandover(doneFileOf(from, session));
	if (done === undefined) {
		say({
			kind: "failed",
			why: `No done file in ${from} names session ${session}, so nothing here was carried to let go.`,
		});
		return false;
	}
	if (settling.runsHere) {
		say({
			kind: "failed",
			why: `Session ${session} runs on this machine again, so its place here is still in use.`,
		});
		return false;
	}
	const judged: [HandedTree, Judged][] = [];
	for (const tree of done.trees) {
		judged.push([tree, await judge(exec, tree, from, home)]);
	}
	const held = judged.filter(([, one]) => one.kind === "kept").length;
	if (held > 0) {
		for (const [tree, one] of judged) {
			say(
				one.kind === "whole"
					? {
							kind: "tree",
							path: tree.path,
							did: "kept",
							why: "Another of its trees holds work the carry lacks, so none is let go.",
						}
					: treeLine(tree, one),
			);
		}
		say({
			kind: "failed",
			why: `${held} of session ${session}'s trees hold work the carry lacks; carry it again or record it, then settle.`,
		});
		return false;
	}
	let let_ = 0;
	let whole = true;
	for (const [tree, one] of judged) {
		if (one.kind !== "whole") {
			say(treeLine(tree, one));
			continue;
		}
		const removed = await exec("git", [
			`--git-dir=${one.gitDir}`,
			"worktree",
			"remove",
			"--force",
			one.folder,
		]);
		if (removed.code === 0) {
			let_++;
			say({ kind: "tree", path: tree.path, did: "let go" });
		} else {
			whole = false;
			say({
				kind: "tree",
				path: tree.path,
				did: "kept",
				why: `git wouldn't let it go: ${removed.stderr.trim()}`,
			});
		}
	}
	if (!whole) {
		say({
			kind: "failed",
			why: `git kept some of session ${session}'s trees; settle again once it says why no longer holds.`,
		});
		return false;
	}
	say({ kind: "settled", session, let: let_ });
	return true;
}

function treeLine(
	tree: HandedTree,
	one: Exclude<Judged, { kind: "whole" }>,
): SettleLine {
	return one.kind === "kept"
		? { kind: "tree", path: tree.path, did: "kept", why: one.why }
		: { kind: "tree", path: tree.path, did: one.kind };
}

/** Whether a carried tree holds only what went, and so may go. */
async function judge(
	exec: Exec,
	tree: HandedTree,
	from: string,
	home: string,
): Promise<Judged> {
	const folder = underHome(tree.path, home);
	if (!existsSync(folder)) return { kind: "gone" };
	const ask = async (...args: string[]) => {
		const said = await exec("git", ["-C", folder, ...args]);
		return said.code === 0 ? said.stdout.trim() : undefined;
	};
	const gitDir = await ask("rev-parse", "--path-format=absolute", "--git-dir");
	const common = await ask(
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	);
	if (gitDir === undefined || common === undefined) {
		return { kind: "kept", why: "git couldn't say what it is." };
	}
	if (gitDir === common) return { kind: "stays" };
	const branch = await ask("symbolic-ref", "--short", "-q", "HEAD");
	if (branch !== tree.branch) {
		return {
			kind: "kept",
			why: `It is on ${branch ?? "no branch"} now, not ${tree.branch} as carried.`,
		};
	}
	if ((await ask("rev-parse", "HEAD")) !== tree.head) {
		return {
			kind: "kept",
			why: `It has commits since the carry, which stood at ${tree.head.slice(0, 12)}.`,
		};
	}
	const changes = await sameChanges(exec, folder, tree, from);
	return changes === true
		? { kind: "whole", folder, gitDir: common }
		: { kind: "kept", why: changes };
}

/**
 * Whether the tree's uncommitted changes are the patch that went, byte
 * for byte, or none when none went; else why not.
 */
async function sameChanges(
	exec: Exec,
	folder: string,
	tree: HandedTree,
	from: string,
): Promise<true | string> {
	const scratch = mkdtempSync(join(tmpdir(), "pi-carry-settle-"));
	try {
		const now = await patchChanges(exec, folder, scratch, "now");
		if (now.kind === "refused") return now.reason;
		const went =
			tree.patch === undefined
				? undefined
				: readFileSync(join(from, tree.patch));
		const here =
			now.kind === "patched"
				? readFileSync(join(scratch, now.patch))
				: undefined;
		const same =
			went === undefined || here === undefined
				? went === here
				: went.equals(here);
		return same
			? true
			: "Its uncommitted changes differ from the ones carried.";
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
