/**
 * Taking back the snapshots a live session pinned and left, out of a
 * real repository, as the sweep's live tests do.
 */

import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SweepDeps } from "../../../lib/core/work/sweep.ts";
import { sweepEndedTrees } from "../../../lib/core/work/sweep.ts";
import { IDLE_HELD_MS } from "../../../lib/core/work/sweep-idle.ts";
import { git } from "../../support/git-fixture.ts";
import {
	disposeAll,
	exec,
	machine,
	pinnedWhereNoRefHolds,
	RUNNING,
	setUp,
} from "./support/sweep-live.ts";

afterEach(disposeAll);

/** The session a live snapshot's record names, which is still open. */
const OPEN_SESSION = "01open-session";

/**
 * A snapshot pinned by {@link RUNNING}, a session still open, left
 * alone `ago` milliseconds: its folder and its git, as a review that
 * read it and ended leaves it.
 */
async function leftAlone(
	setup: Awaited<ReturnType<typeof setUp>>,
	name: string,
	ago: number,
): Promise<{ tree: string; commit: string }> {
	const tree = join(setup.state, name);
	const commit = await pinnedWhereNoRefHolds(setup.main, setup.memory, tree, [
		RUNNING,
	]);
	const record = setup.memory.recall().find((one) => one.path === tree);
	if (record === undefined) throw new Error(`${tree} has no record`);
	setup.memory.remember({ ...record, sessions: [OPEN_SESSION] });
	await untouchedFor(tree, ago);
	return { tree, commit };
}

/** Put a tree's folder and the files its git moves `ago` milliseconds back. */
async function untouchedFor(tree: string, ago: number): Promise<void> {
	const gitDir = (await git(tree, "rev-parse", "--absolute-git-dir")).trim();
	const then = new Date(Date.now() - ago);
	for (const one of ["HEAD", "index", join("logs", "HEAD")]) {
		utimesSync(join(gitDir, one), then, then);
	}
	utimesSync(tree, then, then);
}

/** Sweep where the open session is live, told what `known` says besides. */
function sweepWhileOpen(
	setup: Awaited<ReturnType<typeof setUp>>,
	known: Pick<SweepDeps, "standingIn" | "openIn"> = {},
) {
	return sweepEndedTrees({
		exec,
		memory: setup.memory,
		claims: [],
		lockPath: setup.lockPath,
		facts: machine,
		liveSessions: async () => new Set([OPEN_SESSION]),
		...known,
	});
}

describe("taking the snapshots a live session pinned and left", () => {
	it("takes one an open session left unused past the idle window, saying whose and at what", async () => {
		const setup = await setUp();
		const { tree, commit } = await leftAlone(
			setup,
			"left",
			IDLE_HELD_MS + 60_000,
		);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken).toEqual([
			{
				path: tree,
				sessions: [OPEN_SESSION],
				commit,
				why: "unused for 4 h while its session stayed open",
			},
		]);
		expect(existsSync(tree), `${tree} is still there`).toBe(false);
		expect(setup.memory.recall().map((one) => one.path)).not.toContain(tree);
	});

	it("keeps one a session asked for within the window, though its files sat still", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(setup, "asked", IDLE_HELD_MS + 60_000);
		const record = setup.memory.recall().find((one) => one.path === tree);
		if (record === undefined) throw new Error(`${tree} has no record`);
		setup.memory.remember({ ...record, usedAt: Date.now() - 60 * 60 * 1000 });

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken, "a snapshot used an hour ago was taken").toEqual([]);
		expect(existsSync(tree), "a snapshot used an hour ago went").toBe(true);
	});

	it("keeps one used within the window by its git", async () => {
		const setup = await setUp();
		const { tree } = await leftAlone(
			setup,
			"read",
			IDLE_HELD_MS - 60 * 60 * 1000,
		);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken, "a snapshot used three hours ago was taken").toEqual(
			[],
		);
		expect(existsSync(tree), "a snapshot used three hours ago went").toBe(true);
	});

	it("keeps an idle one with a file nobody committed, or one staged", async () => {
		const setup = await setUp();
		const noted = (await leftAlone(setup, "noted", IDLE_HELD_MS + 60_000)).tree;
		writeFileSync(join(noted, "notes.txt"), "written here\n");
		await untouchedFor(noted, IDLE_HELD_MS + 60_000);
		const staged = (await leftAlone(setup, "staged", IDLE_HELD_MS + 60_000))
			.tree;
		writeFileSync(join(staged, "change.txt"), "staged here\n");
		await git(staged, "add", "change.txt");
		await untouchedFor(staged, IDLE_HELD_MS + 60_000);

		const outcome = await sweepWhileOpen(setup);

		expect(outcome.taken, "a snapshot holding work was taken").toEqual([]);
		expect(
			existsSync(join(noted, "notes.txt")),
			"an uncommitted file went",
		).toBe(true);
		expect(existsSync(join(staged, "change.txt")), "a staged file went").toBe(
			true,
		);
	});

	it("keeps an idle one a process works in, or holds a file open in", async () => {
		const setup = await setUp();
		const worked = (await leftAlone(setup, "worked", IDLE_HELD_MS + 60_000))
			.tree;
		const opened = (await leftAlone(setup, "opened", IDLE_HELD_MS + 60_000))
			.tree;

		const outcome = await sweepWhileOpen(setup, {
			standingIn: () => [join(worked, "src")],
			openIn: () => [join(opened, ".gitignore")],
		});

		expect(outcome.taken, "a snapshot in use was taken").toEqual([]);
		expect(existsSync(worked), "a tree a process works in went").toBe(true);
		expect(existsSync(opened), "a tree with a file held open went").toBe(true);
	});
});
