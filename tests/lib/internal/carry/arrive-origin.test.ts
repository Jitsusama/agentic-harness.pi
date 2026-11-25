/**
 * Arriving where a tree must reach origin, through real git: a tree
 * cloned from origin, a tree already here fetching its origin, and a
 * tree beside a twin fetching the commits the twin lacks, each within
 * the one hour its tree has, each fetch past a `--`, and only git's own
 * reason said where one fails.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import type { Clock } from "../../../../lib/internal/carry/arrive.ts";
import { doneFileOf } from "../../../../lib/internal/carry/handover.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	arrivals,
	boundedFetches,
	fakeClock,
	SESSION,
} from "./support/arriving.ts";
import {
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	removeAll(made);
});

/** Whether git's `args` fetch a needed commit's branch, past its `--`. */
const fetchesNeed = (args: readonly string[]) =>
	args.includes("fetch") && args.at(-3) === "--";

const { carried, needingOrigin, arriveAt } = arrivals(made);

/** Arrives at `home` from `from`, running its commands through `through`. */
function arriveThrough(
	home: string,
	from: string,
	through: Exec,
	clock: Clock = fakeClock(),
) {
	return arriveAt(home, from, clock, [], {}, through);
}

/** What is in `folder`, or nothing where it was never made. */
const leftIn = (folder: string) =>
	existsSync(folder) ? readdirSync(folder) : [];

/** An hour, as a call to origin is told, passing in a second. */
function hourInASecond() {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
		timeout(ms === 3_600_000 ? 1000 : ms),
	);
}

/** `exec`, but a git call `silenced` picks waits on a remote that never speaks. */
function silencing(silenced: (args: string[]) => boolean): Exec {
	return (command, args) => {
		if (command !== "git" || !silenced(args)) return exec(command, args);
		const at = args.indexOf("--") + 1;
		return exec(command, [
			"-c",
			"protocol.ext.allow=always",
			...args.slice(0, at),
			"ext::sh -c sleep% 30",
			...args.slice(at + 1),
		]);
	};
}

describe("arriving with a tree to clone from origin", () => {
	it("bounds the clone low-speed and by the hour its tree has", async () => {
		const { from, head } = await carried();
		const home = folder(made, "arriving");
		const { through, fetches } = boundedFetches();

		const { whole } = await arriveThrough(home, from, through);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(await git(join(home, "src", "app"), "rev-parse", "HEAD")).toBe(head);
		expect(fetches.filter(({ args }) => args.includes("clone"))).toEqual([
			{
				args: expect.arrayContaining(["http.lowSpeedTime=30", "clone"]),
				seconds: 3600,
			},
		]);
	});

	it("says a clone was stopped, and leaves nothing of it", async () => {
		const { from, origin } = await carried();
		const home = folder(made, "arriving");
		hourInASecond();
		const silent = silencing((args) => args.includes("clone"));

		const { whole, said } = await arriveThrough(home, from, silent);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `git couldn't clone ${origin}: git was stopped after 3600 seconds.`,
		});
		expect(existsSync(join(home, "src", "app")), "nothing is left").toBe(false);
		expect(leftIn(join(home, "src")), "nor what it cloned into").toEqual([]);
	});

	it("takes out only what a clone killed outright made", async () => {
		const { from, origin } = await carried();
		const home = folder(made, "arriving");
		const path = join(home, "src", "app");
		// Killed with SIGKILL partway, so git can't take out what it made,
		// as something else arrives where the tree goes.
		const killed: Exec = (command, args) => {
			if (command !== "git" || !args.includes("clone")) {
				return exec(command, args);
			}
			const into = args.at(-1) ?? "";
			mkdirSync(join(into, ".git"), { recursive: true });
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "theirs"), "kept\n");
			return Promise.resolve({
				code: 137,
				stdout: "",
				stderr: "git was killed by SIGKILL",
			});
		};

		const { whole, said } = await arriveThrough(home, from, killed);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `git couldn't clone ${origin}: git was killed by SIGKILL`,
		});
		expect(readFileSync(join(path, "theirs"), "utf8")).toBe("kept\n");
		expect(leftIn(join(home, "src")), "nothing of the clone is left").toEqual([
			"app",
		]);
	});

	it("never takes a clone another arrival left beside it as its twin", async () => {
		const { from, origin, head } = await carried();
		const home = folder(made, "arriving");
		await cloneAt(origin, join(home, "src", "app.cloning-1-2"));
		const { through, fetches } = boundedFetches();

		const { whole } = await arriveThrough(home, from, through);

		expect(whole, "every tree arrived whole").toBe(true);
		expect(await git(join(home, "src", "app"), "rev-parse", "HEAD")).toBe(head);
		expect(
			fetches
				.filter(({ args }) => args.includes("clone"))
				.map(({ args }) => args.at(-2)),
			"it is cloned from origin",
		).toEqual([origin]);
	});

	it("takes out what a killed arrival's clone left beside it, keeping one still under way", async () => {
		const { from, head } = await carried();
		const home = folder(made, "arriving");
		const src = join(home, "src");
		// A process of the test's own, so the sweep asks the machine whether
		// it runs rather than knowing its own pid.
		const under = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		// No process runs past the largest pid Linux or macOS gives out.
		const left = {
			killed: `app.cloning-999999999-${now}`,
			ancient: "app.cloning-999999999-1",
			running: `app.cloning-${under.pid}-${now}`,
			stale: `app.cloning-${under.pid}-${now - day - 60_000}`,
			another: "other.cloning-999999999-1",
			theirs: "app.cloning-999999999-2",
		};
		try {
			for (const name of Object.values(left)) {
				mkdirSync(join(src, name, ".git"), { recursive: true });
				writeFileSync(join(src, name, ".git", "HEAD"), "half made\n");
			}
			writeFileSync(join(src, left.theirs, "notes"), "kept\n");

			const { whole } = await arriveThrough(home, from, exec);

			expect(whole, "every tree arrived whole").toBe(true);
			expect(await git(join(src, "app"), "rev-parse", "HEAD")).toBe(head);
			expect(
				leftIn(src).sort(),
				"only the killed arrivals' clones and the day-old one go",
			).toEqual(["app", left.running, left.another, left.theirs].sort());
			expect(readFileSync(join(src, left.theirs, "notes"), "utf8")).toBe(
				"kept\n",
			);
		} finally {
			under.kill();
		}
	});

	it("clones nothing once its tree's hour has run out", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		const other = join(home, "src", "other");
		mkdirSync(other, { recursive: true });
		const { through, fetches } = boundedFetches();
		const clock = fakeClock();
		// Looking beside the tree for a twin, as the clock reads it, takes the hour.
		const slow: Exec = async (command, args) => {
			if (args.includes(other)) await clock.sleep(3_600_000);
			return through(command, args);
		};

		const { whole, said } = await arriveThrough(home, from, slow, clock);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(fetches.filter(({ args }) => args.includes("clone"))).toEqual([]);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: "It wasn't cloned, since the 3600 seconds its tree had to reach origin all told ran out.",
		});
	});

	it("leaves what arrived where the tree goes while it cloned", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		const path = join(home, "src", "app");
		const racing: Exec = async (command, args) => {
			const done = await exec(command, args);
			if (command === "git" && args.includes("clone")) {
				mkdirSync(path);
				writeFileSync(join(path, "theirs"), "kept\n");
			}
			return done;
		};

		const { whole, said } = await arriveThrough(home, from, racing);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: "Something arrived there while it was cloned.",
		});
		expect(readFileSync(join(path, "theirs"), "utf8")).toBe("kept\n");
		expect(leftIn(join(home, "src")), "and nothing of the clone").toEqual([
			"app",
		]);
	});

	it("refuses a tree whose done file names a branch git could read as a flag, and only that tree", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		const file = doneFileOf(from, SESSION);
		const done = JSON.parse(readFileSync(file, "utf8"));
		const other = {
			...done.trees[0],
			path: done.trees[0].path.replace(/app$/, "other"),
		};
		done.trees[0].branch = "topic/--orphan";
		done.trees.push(other);
		writeFileSync(file, JSON.stringify(done));
		const { through, fetches } = boundedFetches();

		const { whole, said } = await arriveThrough(home, from, through);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: "Its done file names topic/--orphan, which git could read as an option, so it isn't given to git.",
		});
		expect(said[1], "the tree beside it still arrives").toMatchObject({
			path: join(home, "src", "other"),
			did: "cloned",
		});
		expect(
			fetches.filter(({ args }) =>
				args.some(
					(arg) => arg.includes("--orphan") || arg.includes("/src/app"),
				),
			),
			"git is asked nothing for the refused one",
		).toEqual([]);
	});
});

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
		[
			"keeps what ssh said before git's own line, not git's advice after",
			[
				"ssh: Could not resolve hostname forge.example: Name or service not known",
				"fatal: Could not read from remote repository.",
				"",
				"Please make sure you have the correct access rights",
				"and the repository exists.",
			].join("\n"),
			"ssh: Could not resolve hostname forge.example: Name or service not known fatal: Could not read from remote repository.",
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
		hourInASecond();
		const silent = silencing(
			(args) => args.slice(-3).join(" ") === "-- origin topic",
		);

		const { whole, said } = await arriveThrough(home, from, silent);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed.topic} from origin/topic, but git couldn't fetch it: git was stopped after 3600 seconds.`,
		});
	});

	it("bounds the fetch of origin's branches past the twin, fed through sh, by its own quarter hour", async () => {
		const home = folder(made, "arriving");
		const { from, head } = await carried(undefined, {}, async (tree) => {
			const url = await git(tree, "remote", "get-url", "origin");
			await cloneAt(url, join(home, "src", "twin"));
			const other = await cloneAt(url, join(folder(made, "elsewhere"), "o"));
			await commit(other, "main.txt", "moved on, never here\n");
			await git(other, "push", "-q", "origin", "main");
		});
		const { through, fetches } = boundedFetches();

		const { whole } = await arriveThrough(home, from, through);

		expect(whole, "it arrived whole").toBe(true);
		expect(await git(join(home, "src", "app"), "rev-parse", "HEAD")).toBe(head);
		const aside = fetches.filter(({ args }) => args.includes("--stdin"));
		expect(aside, "one fetch of main, past the twin").toHaveLength(1);
		expect(aside[0]?.args.slice(-2)).toEqual(["--stdin", "origin"]);
		expect(aside[0]?.seconds, "within its quarter hour").toBe(900);
	});

	it("says git's own reason where a needed commit's fetch fails, refusing the tree", async () => {
		const home = folder(made, "arriving");
		const { from, pushed } = await needingOrigin(home);
		const failing: Exec = (command, args) =>
			fetchesNeed(args)
				? Promise.resolve({
						code: 128,
						stdout: "",
						stderr: "fatal: Could not read from remote repository.\n",
					})
				: exec(command, args);

		const { whole, said } = await arriveThrough(home, from, failing);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed.topic} from origin/topic, but git couldn't fetch it: fatal: Could not read from remote repository.`,
		});
		expect(
			existsSync(join(home, "src", "app")),
			"the tree cloned here is taken out",
		).toBe(false);
	});

	it("says no remote gave a needed commit where its fetch went but didn't bring it", async () => {
		const home = folder(made, "arriving");
		const { from, pushed } = await needingOrigin(home);
		const empty: Exec = (command, args) =>
			fetchesNeed(args)
				? Promise.resolve({ code: 0, stdout: "", stderr: "" })
				: exec(command, args);

		const { whole, said } = await arriveThrough(home, from, empty);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed.topic} from origin/topic, which no remote here gave.`,
		});
	});

	it("shares one hour among every commit a tree needs, naming the one it ran out before", async () => {
		const home = folder(made, "arriving");
		const { from, pushed } = await needingOrigin(home, ["one", "two"]);
		const { through, fetches } = boundedFetches();
		const clock = fakeClock();
		// The first needed fetch, as the clock reads it, takes the hour.
		const slow: Exec = async (command, args) => {
			const done = await through(command, args);
			if (fetchesNeed(args)) await clock.sleep(3_600_000);
			return done;
		};

		const { whole, said } = await arriveThrough(home, from, slow, clock);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		const needed = fetches.filter(({ args }) => fetchesNeed(args));
		expect(needed, "the second is never asked for").toHaveLength(1);
		const second = needed[0]?.args.at(-1) === "one" ? "two" : "one";
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed[second]} from origin/${second}, but the 3600 seconds its tree had to reach origin all told ran out before it was asked for.`,
		});
	});

	it("bounds each call by what is left of the hour", async () => {
		const home = folder(made, "arriving");
		const { from } = await needingOrigin(home, ["one", "two"]);
		const { through, fetches } = boundedFetches();
		const clock = fakeClock();
		// The first needed fetch, as the clock reads it, takes 1000 seconds.
		let first = true;
		const slow: Exec = async (command, args) => {
			const done = await through(command, args);
			if (fetchesNeed(args) && first) {
				first = false;
				await clock.sleep(1_000_000);
			}
			return done;
		};

		await arriveThrough(home, from, slow, clock);

		expect(
			fetches
				.filter(({ args }) => fetchesNeed(args))
				.map(({ seconds }) => seconds),
		).toEqual([3600, 2600]);
	});

	it("shares that hour with the fetch of origin a tree already here makes", async () => {
		const home = folder(made, "arriving");
		const { from, origin, pushed } = await needingOrigin(home);
		const tree = await cloneAt(
			join(home, "src", "twin"),
			join(home, "src", "app"),
		);
		await git(tree, "remote", "set-url", "origin", origin);
		const { through, fetches } = boundedFetches();
		const clock = fakeClock();
		// Its fetch of origin takes the hour, and brings nothing.
		const slow: Exec = async (command, args) => {
			if (args.includes("fetch") && args.at(-1) === "origin") {
				await clock.sleep(3_600_000);
				return { code: 0, stdout: "", stderr: "" };
			}
			return through(command, args);
		};

		const { whole, said } = await arriveThrough(home, from, slow, clock);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(
			fetches.filter(({ args }) => fetchesNeed(args)),
			"its needed commit is never asked for",
		).toEqual([]);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `It needs ${pushed.topic} from origin/topic, but the 3600 seconds its tree had to reach origin all told ran out before it was asked for.`,
		});
	});
});
