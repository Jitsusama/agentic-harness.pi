/**
 * Replaying a branch onto a new base.
 *
 * The interesting outcome is not success, it is the halt. A rebase that stops
 * on a conflict leaves the tree in a state that is neither where it was nor
 * where it was going, and a tool that reports "failed" and says no more has
 * handed back a repository the caller now has to diagnose from scratch. So a
 * halt is a first-class answer that names the commit it stopped on, the paths
 * that disagree, and the two ways out.
 *
 * Nothing here decides for you. Continuing needs the conflicts resolved, which
 * is work only a person or an agent reading the code can do, and abandoning
 * throws away whatever replaying had achieved so far. Both are refusals to
 * guess rather than missing features.
 *
 * What resuming does take on is git's bookkeeping. A conflict is settled by
 * editing the file, and git also wants it added before it will carry on, a
 * step these tools give no way to take: a file edited clean but never added
 * halted resume again and again, until the agent left for raw git. So resume
 * stages a file that is plainly settled (see `settledIn`), and leaves every
 * other kind of conflict for the one resolving it to stage.
 *
 * The one conflict settled without being asked is two additions at the same
 * place in a Markdown file, which is how appended logs conflict on nearly
 * every replay (see `appends.ts`). A halt made only of those carries on by
 * itself, and says what it settled and which numbers it moved.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Exec } from "../exec/index.ts";
import {
	type Move,
	type SettledFile,
	type StaleCitation,
	settleAdditions,
	staleIn,
} from "./appends.ts";
import { unattended } from "./unattended.ts";

/**
 * What a replay settled by itself on the way: files where both sides only
 * added (see `appends.ts`), files whose citations it rewrote for a number an
 * earlier halt moved, and, once it finished, lines the branch added that
 * still cite a number one of its entries moved off. Each is absent when
 * there is nothing to say.
 */
export interface Settling {
	settled?: readonly SettledFile[];
	recited?: readonly string[];
	stale?: readonly StaleCitation[];
}

/** Only what a replay's settling has to say, without its empty keys. */
export function settlingOf(carried: Settling): Settling {
	return {
		...(carried.settled ? { settled: carried.settled } : {}),
		...(carried.recited ? { recited: carried.recited } : {}),
		...(carried.stale ? { stale: carried.stale } : {}),
	};
}

/** Where a replay got to. */
export type RebaseOutcome =
	| ({
			kind: "replayed";
			branch: string;
			onto: string;
			commits: number;
	  } & Settling)
	| { kind: "already-there"; branch: string; onto: string }
	| {
			kind: "halted";
			branch: string;
			onto: string;
			/** The commit being replayed when it stopped, when git says. */
			at?: string;
			/** Paths that disagree, which is what has to be settled. */
			conflicted: readonly string[];
			settled?: readonly SettledFile[];
			recited?: readonly string[];
	  }
	| { kind: "refused"; reason: string };

/** How a halted replay ends. */
export type ResumeOutcome =
	| ({ kind: "replayed"; branch: string } & Settling)
	| {
			kind: "halted";
			/**
			 * Which branch stopped, and onto what, when git's replay state says.
			 *
			 * Optional because a halt is reported from a tree whose HEAD is detached,
			 * so this is read from the replay in progress rather than from the tree,
			 * and a state git has half torn down may no longer say. It went unread
			 * for a while and the second halt of a stack printed no branch at all,
			 * which is the moment a reader most needs to know which one.
			 */
			branch?: string;
			onto?: string;
			at?: string;
			conflicted: readonly string[];
			settled?: readonly SettledFile[];
			recited?: readonly string[];
	  }
	| { kind: "abandoned"; branch: string }
	| { kind: "refused"; reason: string };

/** Replaying work in a tree. */
export interface WorkRebaser {
	rebase(treePath: string, onto: string): Promise<RebaseOutcome>;
	/** Carry on a halted replay, once the conflicts are settled. */
	resume(treePath: string): Promise<ResumeOutcome>;
	/** Put the tree back the way it was before the replay started. */
	abandon(treePath: string): Promise<ResumeOutcome>;
	/** Whether a replay is part-way through, which changes what is safe. */
	halted(treePath: string): Promise<boolean>;
}

/** Read one git value, scoped to the tree, or undefined when git says nothing. */
async function ask(
	exec: Exec,
	treePath: string,
	args: readonly string[],
): Promise<string | undefined> {
	const result = await exec("git", ["-C", treePath, ...args]);
	if (result.code !== 0) return undefined;
	const said = result.stdout.trim();
	return said === "" ? undefined : said;
}

/** Paths git reports as unmerged. */
async function conflictedIn(
	exec: Exec,
	treePath: string,
): Promise<readonly string[]> {
	const said = await ask(exec, treePath, [
		"diff",
		"--name-only",
		"--diff-filter=U",
	]);
	return said === undefined ? [] : said.split("\n").filter((one) => one !== "");
}

/** A conflict marker git writes at the start of a line; `=======` alone is a heading underline too. */
const MARKER = /^(?:<{7}|>{7}|\|{7})(?:[ \t]|$)/m;

/** How far into a file git looks for a NUL to call it binary. */
const BINARY_SNIFF = 8000;

/**
 * Which of these unmerged paths are plainly settled in the working tree.
 *
 * Plainly means a text file both sides changed, which is the one conflict
 * git writes markers into, with every marker gone. Anything else has no
 * marker to remove, so its file says nothing about whether anyone settled
 * it: a binary file holds one side's bytes untouched, and when one side
 * deleted or added the file, what is left is one side's version as git
 * left it. Staging any of those would choose a side nobody chose. A file
 * removed from the tree is left too, since removing it is a choice to
 * make with git rather than one to read off the disk.
 */
async function settledIn(
	exec: Exec,
	treePath: string,
	conflicted: readonly string[],
): Promise<readonly string[]> {
	if (conflicted.length === 0) return [];
	const top = await ask(exec, treePath, ["rev-parse", "--show-toplevel"]);
	const listed = await exec("git", [
		"-C",
		treePath,
		"ls-files",
		"-u",
		"-z",
		"--full-name",
		"--",
		":(top)",
	]);
	if (top === undefined || listed.code !== 0) return [];

	// Each entry is `mode object stage\tpath`; stages 2 and 3 are the two sides.
	const sides = new Map<string, Set<string>>();
	for (const entry of listed.stdout.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const stage = entry.slice(0, tab).split(" ")[2] ?? "";
		const path = entry.slice(tab + 1);
		sides.set(path, (sides.get(path) ?? new Set()).add(stage));
	}

	return conflicted.filter((path) => {
		const stages = sides.get(path);
		if (!stages?.has("2") || !stages.has("3")) return false;
		let content: Buffer;
		try {
			content = readFileSync(join(top, path));
		} catch {
			return false;
		}
		if (content.subarray(0, BINARY_SNIFF).includes(0)) return false;
		return !MARKER.test(content.toString("utf8"));
	});
}

/**
 * The file a halted replay keeps the name of what it is onto in.
 *
 * Git records only the commit, so a resumed halt had to guess the name back,
 * and guessed after whichever local branch sat there. Kept inside git's own
 * replay directory, the name lives exactly as long as the replay: git removes
 * the directory, and everything in it, when the replay ends either way.
 */
const ONTO_NAME = "agentic-harness-onto";

/**
 * Note the name a halted replay was started onto, so its resumed halts can
 * say it. Best-effort: a halt with the name unrecorded is named from the
 * commit, as before.
 */
export async function recordOnto(
	exec: Exec,
	treePath: string,
	onto: string,
): Promise<void> {
	const said = await ask(exec, treePath, [
		"rev-parse",
		"--git-path",
		"rebase-merge",
	]);
	if (said === undefined) return;
	const directory = isAbsolute(said) ? said : join(treePath, said);
	if (!existsSync(directory)) return;
	try {
		writeFileSync(join(directory, ONTO_NAME), `${onto}\n`);
	} catch {
		// Unrecorded is the fallback the halt already has.
	}
}

/** Git's own directory for the replay in progress, when there is one. */
async function replayDirectory(
	exec: Exec,
	treePath: string,
): Promise<string | undefined> {
	const said = await ask(exec, treePath, [
		"rev-parse",
		"--git-path",
		"rebase-merge",
	]);
	if (said === undefined) return undefined;
	const directory = isAbsolute(said) ? said : join(treePath, said);
	return existsSync(directory) ? directory : undefined;
}

/**
 * The numbers a replay moved, kept beside the replay for the same reason the
 * onto name is: a halt can be settled by hand and resumed in another call,
 * and the lines still citing an old number are only known once it finishes.
 */
const MOVES_NOTE = "agentic-harness-moves.json";

/** The moves noted so far, or none when nothing is noted or it will not read. */
function notedMoves(directory: string | undefined): Move[] {
	if (directory === undefined) return [];
	try {
		const read: unknown = JSON.parse(
			readFileSync(join(directory, MOVES_NOTE), "utf8"),
		);
		return Array.isArray(read) ? read.filter(isMove) : [];
	} catch {
		return [];
	}
}

/** Whether a noted value is a move as `appends.ts` writes it. */
function isMove(value: unknown): value is Move {
	if (typeof value !== "object" || value === null) return false;
	const { path, prefix, from, to } = value as Record<string, unknown>;
	return (
		typeof path === "string" &&
		typeof prefix === "string" &&
		typeof from === "number" &&
		typeof to === "number"
	);
}

/** Bound on halts settled in one call, far past any branch's commit count. */
const CARRY_ON_LIMIT = 10_000;

/** How carrying on from a halt went. */
export type CarriedOn =
	/** Nothing could be settled without a judgement, so nothing was done. */
	| { kind: "untouched" }
	| ({ kind: "replayed" } & Settling)
	| {
			kind: "halted";
			conflicted: readonly string[];
			settled?: readonly SettledFile[];
			recited?: readonly string[];
	  }
	| { kind: "refused"; reason: string };

/**
 * Carry a halted replay on as far as it goes without anyone's judgement:
 * settle what only added, stage what was plainly settled, and continue,
 * halt after halt, until a conflict needs someone or the replay ends.
 *
 * `onlyIfSettled` is for a halt just reached, where carrying on is worth it
 * only when something was settled; a resume always carries on.
 */
export async function carryOn(
	exec: Exec,
	treePath: string,
	options: { onlyIfSettled: boolean },
): Promise<CarriedOn> {
	const first = await replayDirectory(exec, treePath);
	const moves = notedMoves(first);
	const onto =
		first === undefined
			? undefined
			: (() => {
					try {
						return (
							readFileSync(join(first, "onto"), "utf8").trim() || undefined
						);
					} catch {
						return undefined;
					}
				})();
	const settled: SettledFile[] = [];
	const recited = new Set<string>();
	const some = () => ({
		...(settled.length > 0 ? { settled } : {}),
		...(recited.size > 0 ? { recited: [...recited] } : {}),
	});

	for (let round = 0; round < CARRY_ON_LIMIT; round += 1) {
		const now = await settleAdditions(exec, treePath, moves);
		settled.push(...now.settled);
		moves.push(...now.moves);
		for (const path of now.recited) recited.add(path);
		if (
			round === 0 &&
			options.onlyIfSettled &&
			now.settled.length === 0 &&
			now.recited.length === 0
		)
			return { kind: "untouched" };

		const conflicted = await conflictedIn(exec, treePath);
		const plain = await settledIn(exec, treePath, conflicted);
		if (plain.length > 0) {
			const added = await exec("git", [
				"-C",
				treePath,
				"add",
				"--",
				...plain.map((path) => `:(top,literal)${path}`),
			]);
			if (added.code !== 0) {
				return {
					kind: "refused",
					reason: added.stderr.trim() || `git add exited ${added.code}`,
				};
			}
		}
		const left =
			plain.length > 0 ? await conflictedIn(exec, treePath) : conflicted;

		// Kept while git's directory still exists, so a later resume knows them.
		const directory = await replayDirectory(exec, treePath);
		if (directory !== undefined && moves.length > 0) {
			try {
				writeFileSync(join(directory, MOVES_NOTE), JSON.stringify(moves));
			} catch {
				// Unnoted, a later resume only names fewer stale citations.
			}
		}
		if (left.length > 0) return { kind: "halted", conflicted: left, ...some() };

		// Continuing a conflicted pick commits with `-e`, so without this git
		// opens an editor on a stdin nobody is attached to and waits for a human
		// who will never arrive.
		const result = await exec(
			"git",
			unattended(["-C", treePath, "rebase", "--continue"]),
		);
		if (result.code === 0) {
			const stale =
				moves.length > 0 && onto !== undefined
					? staleIn(
							(await ask(exec, treePath, [
								"-c",
								"core.quotepath=off",
								"diff",
								"-U0",
								"--no-color",
								"--no-ext-diff",
								onto,
								"HEAD",
							])) ?? "",
							moves,
						)
					: [];
			return {
				kind: "replayed",
				...some(),
				...(stale.length > 0 ? { stale } : {}),
			};
		}
		const still = await conflictedIn(exec, treePath);
		if (still.length === 0) {
			return {
				kind: "refused",
				reason:
					result.stderr.trim() || `git rebase --continue exited ${result.code}`,
			};
		}
		// The next commit halted too; see whether it only added as well.
	}
	return {
		kind: "halted",
		conflicted: await conflictedIn(exec, treePath),
		...some(),
	};
}

/** Replay with plain git. */
export function createGitRebaser(deps: { exec: Exec }): WorkRebaser {
	const { exec } = deps;

	async function isHalted(treePath: string): Promise<boolean> {
		// Git keeps a directory while a rebase is in progress, and asking for it
		// is cheaper and more certain than parsing status output.
		//
		// Looked at directly rather than through `test -d`. A subprocess runs in
		// the process's own working directory, and git reports this path relative
		// to the tree, so the probe was asking about a directory beside whatever
		// directory pi happened to be started in. It answered "not rebasing" for
		// a tree that was mid-rebase, which is the answer that makes resume and
		// abandon refuse to work at the exact moment they are needed.
		for (const what of ["rebase-merge", "rebase-apply"]) {
			const said = await ask(exec, treePath, ["rev-parse", "--git-path", what]);
			if (said === undefined) continue;
			if (existsSync(isAbsolute(said) ? said : join(treePath, said)))
				return true;
		}
		return false;
	}

	/**
	 * What the replay in progress is doing, as far as git's state says.
	 *
	 * Read from the replay rather than from the tree, because a tree part-way
	 * through one has a detached HEAD: every ordinary way of asking which branch
	 * you are on answers "HEAD", which is why this went unreported for so long.
	 * Git writes the answer down, so the fix is to read what it wrote.
	 *
	 * Every field is best-effort. Nothing here is worth failing a halt over: a
	 * halt with no branch named is thin, and a halt that errored while trying to
	 * name one is worse.
	 */
	async function replaying(treePath: string): Promise<{
		branch?: string;
		onto?: string;
		at?: string;
	}> {
		const read = async (what: string): Promise<string | undefined> => {
			const said = await ask(exec, treePath, [
				"rev-parse",
				"--git-path",
				`rebase-merge/${what}`,
			]);
			if (said === undefined) return undefined;
			const where = isAbsolute(said) ? said : join(treePath, said);
			if (!existsSync(where)) return undefined;
			try {
				const text = readFileSync(where, "utf8").trim();
				return text === "" ? undefined : text;
			} catch {
				// Unreadable is the same as unsaid here: the halt is still a halt.
				return undefined;
			}
		};

		const head = await read("head-name");
		const onto = await read("onto");
		const named = await read(ONTO_NAME);
		const at = await ask(exec, treePath, [
			"rev-parse",
			"--short",
			"REBASE_HEAD",
		]);
		return {
			// Git records the full ref; a reader wants the branch.
			...(head ? { branch: head.replace(/^refs\/heads\//, "") } : {}),
			...(onto ? { onto: await nameFor(treePath, onto, named) } : {}),
			...(at ? { at } : {}),
		};
	}

	/**
	 * What to call the commit a replay is heading for.
	 *
	 * Git records the target as a commit, because by then the ref that named it is
	 * beside the point: the replay is onto that commit whatever anybody does to the
	 * branch afterwards. But a halt reported from a resume then said "onto fc00dccd"
	 * where the same halt from starting the replay said "onto main", and the two are
	 * the same event to the person reading them.
	 *
	 * So a replay these tools started records the name it was given (see
	 * `recordOnto`), and that name is used, with the commit beside it once the ref
	 * has moved on, since the replay is still onto where the ref was.
	 *
	 * A replay started with raw git has no name recorded, so its commit is named
	 * after a branch when exactly one branch is sitting on it. Exactly one, because
	 * more than one is genuinely ambiguous, and picking one would be inventing the
	 * answer rather than reading it. The commit is the honest fallback, and it is
	 * what git had.
	 */
	async function nameFor(
		treePath: string,
		commit: string,
		named: string | undefined,
	): Promise<string> {
		const short = commit.slice(0, 8);
		if (named !== undefined) {
			const now = await ask(exec, treePath, [
				"rev-parse",
				"--verify",
				"--quiet",
				`${named}^{commit}`,
			]);
			return now === commit ? named : `${named} at ${short}`;
		}
		const said = await ask(exec, treePath, [
			"for-each-ref",
			"--format=%(refname:short)",
			"--points-at",
			commit,
			"refs/heads",
		]);
		if (said === undefined) return short;
		const names = said.split("\n").filter((one) => one !== "");
		return names.length === 1 && names[0] !== undefined ? names[0] : short;
	}

	return {
		halted: isHalted,

		async rebase(treePath, onto) {
			if (await isHalted(treePath)) {
				return {
					kind: "refused",
					reason:
						"A replay is already part-way through in this tree. Settle it first: resume it once the conflicts are resolved, or abandon it to put the tree back.",
				};
			}

			const branch = await ask(exec, treePath, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			]);
			if (branch === undefined || branch === "HEAD") {
				return {
					kind: "refused",
					reason:
						"This tree is not on a branch, so there is nothing to replay.",
				};
			}

			// Uncommitted work and a rebase do not mix, and git's own autostash
			// would hide the problem rather than state it. A caller who wants
			// the changes kept should commit them; one who does not should say
			// so out loud.
			const dirty = await ask(exec, treePath, ["status", "--porcelain"]);
			if (dirty !== undefined) {
				return {
					kind: "refused",
					reason: `This tree has uncommitted changes, and replaying would have to move them. Record them first, or set them aside deliberately.\n\n${dirty}`,
				};
			}

			const before = await ask(exec, treePath, [
				"rev-list",
				"--count",
				`${onto}..HEAD`,
			]);
			// No commit of its own is not the same as being there: a branch cut
			// from main and asked onto a branch built on main has none, yet the
			// base holds commits it lacks, and the rebase moves it up to them.
			// Only a base the branch already holds leaves nothing to do.
			if (
				before === "0" &&
				(
					await exec("git", [
						"-C",
						treePath,
						"merge-base",
						"--is-ancestor",
						onto,
						"HEAD",
					])
				).code === 0
			) {
				return { kind: "already-there", branch, onto };
			}

			const result = await exec(
				"git",
				unattended(["-C", treePath, "rebase", onto]),
			);
			if (result.code === 0) {
				return {
					kind: "replayed",
					branch,
					onto,
					commits: Number.parseInt(before ?? "0", 10) || 0,
				};
			}

			const conflicted = await conflictedIn(exec, treePath);
			if (conflicted.length > 0 || (await isHalted(treePath))) {
				await recordOnto(exec, treePath, onto);
				const carried = await carryOn(exec, treePath, { onlyIfSettled: true });
				if (carried.kind === "replayed") {
					const { kind: _, ...settling } = carried;
					return {
						kind: "replayed",
						branch,
						onto,
						commits: Number.parseInt(before ?? "0", 10) || 0,
						...settling,
					};
				}
				if (carried.kind === "refused") return carried;
				const at = await ask(exec, treePath, [
					"rev-parse",
					"--short",
					"REBASE_HEAD",
				]);
				return {
					kind: "halted",
					branch,
					onto,
					...(at === undefined ? {} : { at }),
					...(carried.kind === "halted"
						? { conflicted: carried.conflicted, ...settlingOf(carried) }
						: { conflicted }),
				};
			}

			const said = [result.stderr.trim(), result.stdout.trim()]
				.filter((stream) => stream !== "")
				.join("\n");
			return {
				kind: "refused",
				reason: said || `git rebase exited ${result.code}`,
			};
		},

		async resume(treePath) {
			if (!(await isHalted(treePath))) {
				return {
					kind: "refused",
					reason: "No replay is part-way through in this tree.",
				};
			}
			const carried = await carryOn(exec, treePath, { onlyIfSettled: false });
			if (carried.kind === "halted") {
				return { ...carried, ...(await replaying(treePath)) };
			}
			if (carried.kind === "refused") return carried;
			const settling = carried.kind === "replayed" ? settlingOf(carried) : {};
			const branch =
				(await ask(exec, treePath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
				"HEAD";
			return { kind: "replayed", branch, ...settling };
		},

		async abandon(treePath) {
			if (!(await isHalted(treePath))) {
				return {
					kind: "refused",
					reason: "No replay is part-way through in this tree.",
				};
			}
			const result = await exec(
				"git",
				unattended(["-C", treePath, "rebase", "--abort"]),
			);
			if (result.code !== 0) {
				return {
					kind: "refused",
					reason:
						result.stderr.trim() || `git rebase --abort exited ${result.code}`,
				};
			}
			const branch =
				(await ask(exec, treePath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
				"HEAD";
			return { kind: "abandoned", branch };
		},
	};
}
