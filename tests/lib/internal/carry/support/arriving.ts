/**
 * A session carried from one machine and arrived on another, through
 * real git, for the tests of arriving: what the leaving machine puts in
 * its handover, and the arrival that takes it up.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, vi } from "vitest";
import type { Exec } from "../../../../../lib/core/exec/index.ts";
import {
	type ArrivalLine,
	type Arriving,
	arrive,
	type Clock,
} from "../../../../../lib/internal/carry/arrive.ts";
import {
	type Carrying,
	carryAway,
} from "../../../../../lib/internal/carry/carry-away.ts";
import type { CarriedNote } from "../../../../../lib/internal/carry/notes.ts";
import { sessionFolderOf } from "../../../../../lib/internal/quest/reopening/carried.ts";
import { git } from "../../../../support/git-fixture.ts";
import { bareOrigin, cloneAt, commit, exec, folder } from "./machines.ts";

/** The quest every carried session here belongs to. */
export const QUEST = "QEST-20261107-CARRY1";

/** The session carried. */
export const SESSION = "01a19111-arrive";

/** A clock that moves only as it is slept on, calling `at` each time. */
export function fakeClock(at: (now: number) => void = () => {}): Clock {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			at(now);
		},
	};
}

/**
 * An exec that keeps each git fetch's or clone's arguments and the seconds it was
 * bounded to, read from the clock its call was given just before it, or
 * none where it had none. The clock is read through a spy on
 * `AbortSignal.timeout`, which a test's `vi.restoreAllMocks` ends.
 * A fetch fed its refs through sh, as origin-view's `fed` runs one, is
 * kept too, with sh's arguments, which end in git's own.
 */
export function boundedFetches(): {
	through: Exec;
	fetches: { args: string[]; seconds?: number }[];
} {
	let bound: number | undefined;
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		bound = ms / 1000;
		return timeout(ms);
	});
	const fetches: { args: string[]; seconds?: number }[] = [];
	const through: Exec = (command, args) => {
		if (
			(command === "git" || (command === "sh" && runsGit(args))) &&
			(args.includes("fetch") || args.includes("clone"))
		) {
			fetches.push(bound === undefined ? { args } : { args, seconds: bound });
		}
		bound = undefined;
		return exec(command, args);
	};
	return { through, fetches };
}

/** Whether sh's `args` run a script that runs git. */
function runsGit(args: readonly string[]): boolean {
	return args[0] === "-c" && /\bgit\b/.test(args[1] ?? "");
}

/** The quest's scratch the handover folder `from` lies in. */
export function scratchOf(from: string): string {
	return dirname(dirname(from));
}

/** The `cwd` the session file placed for `cwd` in `store` names. */
export function placedCwd(store: string, cwd: string): string {
	const placed = join(
		sessionFolderOf(store, cwd),
		`2026-11-07_${SESSION}.jsonl`,
	);
	return JSON.parse(readFileSync(placed, "utf8").split("\n")[0] ?? "").cwd;
}

/** Carrying and arriving, each folder made kept in `made` for removal. */
export function arrivals(made: string[]) {
	/**
	 * The leaving machine's session, carried: a tree at `~/src/app` on a
	 * branch with a commit no remote has, a change, a file never added
	 * and a session file, put in a handover folder. The session ran in
	 * the tree, or in the folder `ranIn` names under the leaving home.
	 */
	async function carried(
		ranIn?: string,
		moved: Pick<Carrying, "fence" | "notes" | "largestFile"> = {},
		shaped: (tree: string) => Promise<void> = async () => {},
	) {
		const origin = await bareOrigin(made);
		const leaving = folder(made, "leaving");
		const tree = await cloneAt(origin, join(leaving, "src", "app"));
		await git(tree, "checkout", "-q", "-b", "topic");
		await shaped(tree);
		const head = await commit(tree, "work.txt", "unpushed\n");
		writeFileSync(join(tree, "README.md"), "changed, never committed\n");
		writeFileSync(join(tree, "draft.txt"), "never added\n");
		const cwd = ranIn === undefined ? tree : join(leaving, ranIn);
		mkdirSync(cwd, { recursive: true });
		const sessionFile = join(
			folder(made, "sessions"),
			`2026-11-07_${SESSION}.jsonl`,
		);
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: SESSION, cwd })}\n${'{"type":"message"}\n'.repeat(500)}`,
		);
		const from = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
		await carryAway({
			exec,
			into: from,
			home: leaving,
			quest: QUEST,
			session: { id: SESSION, cwd, file: sessionFile },
			trees: [tree],
			...moved,
		});
		return { origin, from, head };
	}

	/**
	 * A session carried from a tree whose commits on `branches` were
	 * pushed to origin after a twin was cloned beside the arriving tree at
	 * `home`, so it needs each from origin. A branch but `topic` is cut
	 * from it and merged back into it. Answers the commit each was pushed
	 * at, too.
	 */
	async function needingOrigin(
		home: string,
		branches: readonly string[] = ["topic"],
	) {
		const pushed: Record<string, string> = {};
		const sent = await carried(undefined, {}, async (tree) => {
			const url = await git(tree, "remote", "get-url", "origin");
			await cloneAt(url, join(home, "src", "twin"));
			for (const branch of branches) {
				await git(tree, "checkout", "-q", "-B", branch, "topic");
				pushed[branch] = await commit(tree, `${branch}.txt`, "pushed\n");
				await git(tree, "push", "-q", "origin", branch);
				await git(tree, "checkout", "-q", "topic");
			}
			const cut = branches.filter((branch) => branch !== "topic");
			if (cut.length > 0) await git(tree, "merge", "-q", "--no-edit", ...cut);
		});
		return { ...sent, pushed };
	}

	/**
	 * Arrives on a machine whose home is `home`, keeping every line said,
	 * running its commands through `through`.
	 */
	async function arriveAt(
		home: string,
		from: string,
		clock: Clock = fakeClock(),
		taken: CarriedNote[][] = [],
		limits: Pick<Arriving, "largestUnzipped"> = {},
		through: Exec = exec,
	) {
		const said: ArrivalLine[] = [];
		const store = folder(made, "store");
		const whole = await arrive({
			takeNotes: async (quest, notes) => {
				expect(quest, "notes are taken up for the carried quest").toBe(QUEST);
				taken.push([...notes]);
				return notes.length;
			},
			exec: through,
			from,
			session: SESSION,
			home,
			scratch: scratchOf(from),
			sessions: store,
			clock,
			say: (line) => said.push(line),
			...limits,
		});
		return { whole, said, store };
	}

	return { carried, needingOrigin, arriveAt };
}
