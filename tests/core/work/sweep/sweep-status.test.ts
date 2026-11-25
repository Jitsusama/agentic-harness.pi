/**
 * What a sweep asks git's status of. On 25 November each hourly sweep
 * asked it of every worktree beside the ones it judged, about 2,000
 * across core.nix, the harness and World, eight at once, while Joel's
 * browser waited up to 11 s on the file system's commits.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	disposeAll,
	exec,
	machine,
	RUNNING,
	setUp,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

/** An exec that notes which trees git's status was asked of, and how many at once. */
function watching() {
	const asked: string[] = [];
	let running = 0;
	let most = 0;
	const watched: Exec = async (command, args) => {
		if (command !== "git" || !args.includes("status")) {
			return await exec(command, args);
		}
		asked.push(args[args.indexOf("-C") + 1] ?? "");
		running += 1;
		most = Math.max(most, running);
		try {
			await new Promise((done) => setTimeout(done, 20));
			return await exec(command, args);
		} finally {
			running -= 1;
		}
	};
	return { asked, most: () => most, watched };
}

describe("what a sweep asks git's status of", () => {
	it("asks only the trees it could take, one at a time", async () => {
		const { main, memory, lockPath, state, cut } = await setUp();
		// One after another: worktrees added at once race on the
		// repository's own locks.
		const ended: string[] = [];
		for (const key of ["one", "two", "three"]) {
			ended.push(await cut(key, ["-b", key, "@", "main"]));
		}
		const live = await cut("live", ["-b", "live", "@", "main"], [RUNNING]);
		const unrecorded = join(state, "someone-elses");
		await git(main, "worktree", "add", "-q", "-b", "theirs", unrecorded);
		const { asked, most, watched } = watching();

		await sweepEndedTrees({
			exec: watched,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		const trees = new Set([...ended, live, unrecorded, main]);
		const surveyed = asked.filter((path) => trees.has(path));
		expect(
			[...new Set(surveyed)].sort(),
			"the trees asked their status",
		).toEqual([...ended].sort());
		expect(most(), "how many statuses ran at once").toBe(1);
	});
});
