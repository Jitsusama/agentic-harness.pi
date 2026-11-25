/**
 * Finishing removals that stopped part way where the broker cuts its
 * trees: a release whose `git worktree remove` was stopped leaves a
 * folder with no `.git` and no record, and a take stopped after its move
 * leaves one named `.going-`. Neither is a tree any longer, so nothing
 * else judges them; on 24 November 54 such folders held 3.1 GiB.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepEndedTrees } from "../../../../lib/core/work/sweep.ts";
import { STOPPED_REMOVAL_MS } from "../../../../lib/core/work/sweep-orphan.ts";
import {
	disposeAll,
	ENDED,
	exec,
	machine,
	setUp,
} from "../support/sweep-live.ts";

afterEach(disposeAll);

const DAY = 24 * 60 * 60 * 1000;

/** A folder named `name` in `dir` holding a file, left alone for `ms`. */
function leftover(dir: string, name: string, ms: number): string {
	const path = join(dir, name);
	const modules = join(path, "modules");
	const file = join(modules, "left.lua");
	mkdirSync(modules, { recursive: true });
	writeFileSync(file, "-- left\n");
	const then = (Date.now() - ms) / 1000;
	for (const one of [file, modules, path]) utimesSync(one, then, then);
	return path;
}

describe("removals stopped part way", () => {
	it("finishes one no record names and nothing has touched for a day, and a take's moved-aside folder", async () => {
		const { memory, state } = await setUp();
		const stopped = leftover(state, "snapshot-github-o-r-abc123", 2 * DAY);
		const going = leftover(state, "worktree-github-o-r.going-1a2b", 2 * DAY);
		const fresh = leftover(state, "snapshot-github-o-r-def456", DAY / 2);
		const recorded = leftover(state, "snapshot-github-o-r-0a0b0c", 2 * DAY);
		memory.remember({
			identity: { key: "snapshot-github-o-r-0a0b0c", shareable: false },
			path: recorded,
			providerId: "git-worktree",
			owners: [ENDED],
		});
		const worked = leftover(state, "snapshot-github-o-r-111111", 2 * DAY);
		const strange = leftover(state, "raw", 2 * DAY);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: async () => new Set([worked]),
		});

		const taken = outcome.taken.map((tree) => tree.path).sort();
		const finished = [stopped, going].sort();
		expect(taken, "what the sweep finished removing").toEqual(finished);
		expect(existsSync(stopped), "a stopped removal stayed").toBe(false);
		expect(existsSync(going), "a take's moved-aside folder stayed").toBe(false);
		expect(existsSync(fresh), "one touched within the day went").toBe(true);
		expect(existsSync(recorded), "one a record names went").toBe(true);
		expect(existsSync(worked), "one something works in went").toBe(true);
		expect(existsSync(strange), "one not named as a tree went").toBe(true);
		expect(
			outcome.kept.find((one) => one.path === worked)?.why,
			"why the worked-in folder stayed",
		).toMatch(/something works in it/);
		expect(
			readdirSync(state).filter((name) => name.includes(".going-")),
			"what a finished removal left",
		).toEqual([]);
		expect(STOPPED_REMOVAL_MS, "a day untouched before finishing").toBe(DAY);
	});

	it("keeps every one when the machine can't say what works in them", async () => {
		const { memory, state } = await setUp();
		const stopped = leftover(state, "snapshot-github-o-r-abc123", 2 * DAY);

		const outcome = await sweepEndedTrees({
			exec,
			memory,
			claims: [],
			lockPath: join(state, "sweep.lock"),
			facts: machine,
			treesDir: state,
			busyAmong: async () => undefined,
		});

		expect(outcome.taken, "taken on a blind reading").toEqual([]);
		expect(existsSync(stopped), "one went on a blind reading").toBe(true);
		expect(
			outcome.kept.find((one) => one.path === stopped)?.why,
			"why it stayed",
		).toMatch(/can't say/);
	});
});
