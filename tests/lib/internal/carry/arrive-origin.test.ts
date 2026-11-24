/**
 * Arriving where a tree must reach origin, through real git: a tree
 * already here fetching its origin, and a tree beside a twin fetching
 * the commits the twin lacks, each within the hour it has, each fetch
 * past a `--`, and only git's own reason said where one fails.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { git } from "../../../support/git-fixture.ts";
import { arrivals, boundedFetches, fakeClock } from "./support/arriving.ts";
import { cloneAt, exec, folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	removeAll(made);
});

const { carried, needingOrigin, arriveAt } = arrivals(made);

/** Arrives at `home` from `from`, running its commands through `through`. */
function arriveThrough(home: string, from: string, through: Exec) {
	return arriveAt(home, from, fakeClock(), [], {}, through);
}

describe("arriving with a tree already here", () => {
	it("gives it an hour to fetch its origin, as one far behind may need", async () => {
		const { origin, from, head } = await carried();
		const home = folder(made, "arriving");
		const tree = await cloneAt(origin, join(home, "src", "app"));
		const { through, fetches } = boundedFetches();

		const { whole } = await arriveThrough(home, from, through);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(await git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(
			fetches.filter(({ args }) => args.at(-1) === "origin"),
			"one fetch of all origin, bounded low-speed and by the hour",
		).toEqual([
			{
				args: expect.arrayContaining(["http.lowSpeedTime=30", "fetch"]),
				seconds: 3600,
			},
		]);
	});

	it.each([
		["says how git ended where it said nothing", "", "git exited 1"],
		[
			"keeps git's own lines, not the server's or its hints",
			[
				"remote: Internal error, ticket 7",
				"remote: see the status page",
				"error: RPC failed; HTTP 500 curl 22",
				"fatal: expected flush after ref listing",
				"hint: try again later",
			].join("\n"),
			"error: RPC failed; HTTP 500 curl 22 fatal: expected flush after ref listing",
		],
	])(
		"refuses it where its origin won't fetch, and %s",
		async (_, stderr, why) => {
			const { origin, from } = await carried();
			const home = folder(made, "arriving");
			const tree = await cloneAt(origin, join(home, "src", "app"));
			const failing: Exec = (command, args) =>
				command === "git" && args.at(-1) === "origin" && args.includes("fetch")
					? Promise.resolve({ code: 1, stdout: "", stderr })
					: exec(command, args);

			const { whole, said } = await arriveThrough(home, from, failing);

			expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
			expect(said[0]).toEqual({
				kind: "tree",
				path: tree,
				branch: "topic",
				did: "refused",
				why: `git couldn't fetch its origin: ${why}`,
			});
		},
	);
});

describe("arriving beside a twin that lacks what a tree needs", () => {
	it("fetches a needed commit's branch past a `--`, so no name of it reads as a flag, within an hour", async () => {
		const home = folder(made, "arriving");
		const { from, head } = await needingOrigin(home);
		const { through, fetches } = boundedFetches();

		const { whole } = await arriveThrough(home, from, through);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(join(home, "src", "app"), "rev-parse", "HEAD")).toBe(head);
		const needed = fetches.filter(({ args }) => args.at(-1) === "topic");
		expect(needed, "one fetch of the needed commit's branch").toHaveLength(1);
		expect(needed[0]?.args.slice(-3)).toEqual(["--", "origin", "topic"]);
		expect(needed[0]?.seconds, "within an hour, all its needs told").toBe(3600);
	});

	it("says a needed commit's fetch was stopped, not that no remote gave it", async () => {
		const home = folder(made, "arriving");
		const { from, pushed } = await needingOrigin(home);
		// An hour, as the fetch is told, passes in a second.
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			timeout(ms === 3_600_000 ? 1000 : ms),
		);
		const silent: Exec = (command, args) =>
			command === "git" && args.slice(-3).join(" ") === "-- origin topic"
				? exec(command, [
						...args.slice(0, 2),
						"-c",
						"protocol.ext.allow=always",
						...args.slice(2, -2),
						"ext::sh -c sleep% 30",
						"topic",
					])
				: exec(command, args);

		const { whole, said } = await arriveThrough(home, from, silent);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed.topic} from origin/topic, but git couldn't fetch it: git was stopped after 3600 seconds.`,
		});
	});

	it("shares one hour among every commit a tree needs, naming the one it ran out before", async () => {
		const home = folder(made, "arriving");
		const { from, pushed } = await needingOrigin(home, ["one", "two"]);
		const { through, fetches } = boundedFetches();
		vi.useFakeTimers({ toFake: ["Date"] });
		// The first needed fetch, as the clock reads it, takes the hour.
		const slow: Exec = async (command, args) => {
			const done = await through(command, args);
			if (args.at(-3) === "--") vi.setSystemTime(Date.now() + 3_600_000);
			return done;
		};

		const { whole, said } = await arriveThrough(home, from, slow);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		const needed = fetches.filter(({ args }) => args.at(-3) === "--");
		expect(needed, "the second is never asked for").toHaveLength(1);
		const second = needed[0]?.args.at(-1) === "one" ? "two" : "one";
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed[second]} from origin/${second}, but the 3600 seconds its needs had all told ran out before it was asked for.`,
		});
	});
});
