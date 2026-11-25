/**
 * What a sweep asks git's status of. On 25 November each hourly sweep
 * asked it of every worktree beside the ones it judged, about 2,000
 * across core.nix, the harness and World, eight at once, while Joel's
 * browser waited up to 11 s on the file system's commits.
 */

import { existsSync, writeFileSync } from "node:fs";
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
			// Held a moment, so statuses allowed to run at once overlap and
			// `most` sees it; without it three quick ones might never meet.
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

	it("keeps a dirty tree whose survey answered clean, as its take asks git again", async () => {
		const { memory, lockPath, cut } = await setUp();
		const dirty = await cut("dirty", ["-b", "dirty", "@", "main"]);
		writeFileSync(join(dirty, "notes.txt"), "unsaved\n");
		// A remembered answer gone stale: every tree reads clean.
		const stale: Exec = async (command, args) =>
			command === "git" && args.includes("status")
				? { code: 0, stdout: "", stderr: "" }
				: await exec(command, args);

		const outcome = await sweepEndedTrees({
			exec,
			statusExec: stale,
			memory,
			claims: [],
			lockPath,
			facts: machine,
		});

		expect(
			outcome.refused.map((tree) => tree.path),
			"the trees whose take git refused",
		).toEqual([dirty]);
		expect(existsSync(join(dirty, "notes.txt")), "the unsaved file").toBe(true);
	});
});
