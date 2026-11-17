import { describe, expect, it } from "vitest";
import {
	JOINS_FOR_MS,
	type Job,
	kindOf,
	MAC_RULES,
	needsGibOf,
	needsGibOfCommand,
	nextTurn,
	QUICK_OUTRUN_MS,
	RAMP_MS,
	skipsWorldPushHooks,
	WALKS_AT_ONCE,
	waitingInOrder,
	waitReasons,
	walkOf,
	whatOf,
} from "../../../../lib/internal/priority/queue.ts";
import { job, NOW, ROOMY, startedAgo } from "./queue-line.ts";

describe("a walk of World's objects", () => {
	const home = "/home/j";
	const tree = `${home}/world/trees/w-main/src`;
	const inWorld = { cwd: tree, home };
	const elsewhere = { cwd: `${home}/src/core.nix`, home };

	it("reads git's object walks run in a World checkout as a walk", () => {
		// 11-04, 08:04 to 08:22: six OOM kills while 3 to 5 of these ran at
		// once from different sessions' World trees, each mapping 3 to 6 GB
		// of packs, with no turn.
		for (const walking of [
			"git push delta HEAD:refs/heads/x",
			"timeout 3600 git push --force-with-lease origin x > $L 2>&1",
			"git fetch origin main",
			"git pull --rebase",
			"git gc --auto",
			"git repack -ad",
			"git rev-list --objects --all | git pack-objects --stdout > p.pack",
			"git -c core.askPass=true fetch delta",
		]) {
			expect(kindOf(walking, inWorld), walking).toBe("world-walk");
		}
		expect(kindOf("git push", { cwd: `${home}/world`, home })).toBe(
			"world-walk",
		);
	});

	it("reads a walk against World from wherever the command names it", () => {
		for (const walking of [
			"git -C ~/world/trees/w-main/src push origin x",
			`git -C ${tree} fetch`,
			"git -C $HOME/world/trees/a/src -C ../../b/src push",
			"cd ~/world/trees/w-main/src && git push",
			"T=$HOME/world/trees/a/src; cd $T && git fetch origin",
			"git clone ~/world/git /tmp/copy",
			"git fetch file:///home/j/world/git main",
			"git --git-dir=/home/j/world/git fetch origin",
		]) {
			expect(kindOf(walking, elsewhere), walking).toBe("world-walk");
		}
		// Named outright, it needs no folder to be read from.
		expect(kindOf("cd ~/world/trees/a/src && git push", { home })).toBe(
			"world-walk",
		);
		// The step said is the walk, not the `cd` before it.
		expect(
			whatOf("cd ~/world/trees/a/src && timeout 3600 git push origin x"),
		).toBe("timeout 3600 git push origin x");
		// A build in the same call takes the turn as a build.
		expect(kindOf("git push && nix build .#tool", inWorld)).toBe("build");
		expect(whatOf("git push && nix build .#tool")).toBe("nix build .#tool");
	});

	it("leaves every other repo's git, and git's reads of history, alone", () => {
		for (const other of [
			"git push",
			"git fetch origin main",
			"cd ~/src/dotfiles && git pull",
		]) {
			expect(kindOf(other, elsewhere), other).toBeUndefined();
		}
		expect(kindOf("cd ~/src/core.nix && git push", inWorld)).toBeUndefined();
		for (const reading of [
			"git log --oneline -20",
			"git diff origin/main",
			"git rev-parse HEAD",
			"git rev-list --objects HEAD | wc -l",
			"git status",
			"git -c push.default=current status",
			"git log --grep push",
			"echo git push",
			"gh pr create --title 'git push it'",
			"rg 'git fetch' scripts",
		]) {
			expect(kindOf(reading, inWorld), reading).toBeUndefined();
		}
	});

	it("holds a walk to 6 GiB", () => {
		expect(
			needsGibOf(job("walk", { kind: "world-walk", what: "git push" })),
		).toBe(6);
		expect(needsGibOfCommand("world-walk", "cd x && git push")).toBe(6);
	});

	it("runs at most two at once, whatever memory reads, and lets others past", () => {
		const long = startedAgo(RAMP_MS + 60_000);
		const walk = (id: string, over: Partial<Job> = {}) =>
			job(id, { kind: "world-walk", what: "git push", ...over });
		const running = [
			walk("one", { started: long }),
			walk("two", { started: long }),
		];
		const jobs = [
			...running,
			walk("third", { since: startedAgo(9_000) }),
			job("build", { since: startedAgo(8_000) }),
		];
		const plenty = { ...ROOMY, availableGib: 100 };

		expect(WALKS_AT_ONCE).toBe(2);
		expect(nextTurn(jobs, plenty, NOW)?.id).toBe("build");
		expect(Object.fromEntries(waitReasons(jobs, plenty, NOW))).toEqual({
			third: "walks",
			build: "order",
		});
		// With one of them done, the next starts.
		const after = jobs.filter((one) => one.id !== "two");
		expect(nextTurn(after, plenty, NOW)?.id).toBe("third");
		expect(waitReasons(after, plenty, NOW).get("third")).toBe("order");
	});

	it("runs one at a time on a Mac, whose memory has no floors to hold the rest", () => {
		// Equilibrius on 16 November: 48 GiB, swap 77% used, with 43
		// sessions and their pushes of World each mapping its packs.
		const long = startedAgo(RAMP_MS + 60_000);
		const walk = (id: string, over: Partial<Job> = {}) =>
			job(id, { kind: "world-walk", what: "git push", ...over });
		const jobs = [
			walk("one", { started: long }),
			walk("two", { since: startedAgo(9_000) }),
		];
		const plenty = { ...ROOMY, availableGib: 100 };

		expect(MAC_RULES.walksAtOnce).toBe(1);
		expect(nextTurn(jobs, plenty, NOW, MAC_RULES)).toBeUndefined();
		expect(waitReasons(jobs, plenty, NOW, MAC_RULES).get("two")).toBe("walks");
		expect(nextTurn(jobs, plenty, NOW)?.id).toBe("two");
	});

	describe("a quick push on a Mac", () => {
		const long = startedAgo(RAMP_MS + 60_000);
		const plenty = { ...ROOMY, availableGib: 100 };
		const push = (id: string, over: Partial<Job> = {}) =>
			job(id, {
				kind: "world-walk",
				what: "git push",
				walk: "push",
				quick: true,
				cappable: true,
				...over,
			});

		it("waits for another quick push, and lets other work past", () => {
			const jobs = [
				push("first", { started: startedAgo(30_000) }),
				push("second", { since: startedAgo(9_000) }),
				job("build", { since: startedAgo(8_000) }),
			];

			expect(nextTurn(jobs, plenty, NOW, MAC_RULES)?.id).toBe("build");
			expect(waitReasons(jobs, plenty, NOW, MAC_RULES).get("second")).toBe(
				"walks",
			);
			// Elsewhere quick pushes pass each other, as they always have.
			expect(nextTurn(jobs, plenty, NOW)?.id).toBe("second");
		});

		it("stops waiting for one that has run past its quick time", () => {
			const jobs = [
				push("hung", { started: startedAgo(QUICK_OUTRUN_MS + 1_000) }),
				push("next", { since: startedAgo(9_000) }),
			];

			expect(nextTurn(jobs, plenty, NOW, MAC_RULES)?.id).toBe("next");
		});

		it("passes a fetch that may run for minutes", () => {
			const jobs = [
				job("fetch", { kind: "world-walk", what: "git fetch", started: long }),
				push("push", { since: startedAgo(9_000) }),
			];

			expect(nextTurn(jobs, plenty, NOW, MAC_RULES)?.id).toBe("push");
		});

		it("keeps to the usual rule where a machine's rules name the usual count", () => {
			const jobs = [
				push("first", { started: startedAgo(30_000) }),
				push("second", { since: startedAgo(9_000) }),
			];
			const usual = { ...MAC_RULES, walksAtOnce: WALKS_AT_ONCE };

			expect(nextTurn(jobs, plenty, NOW, usual)?.id).toBe("second");
		});
	});

	it("waits on memory like any job when its 6 GiB isn't free", () => {
		const jobs = [job("walk", { kind: "world-walk", what: "git fetch" })];
		const tight = { ...ROOMY, availableGib: 5 };
		expect(nextTurn(jobs, tight, NOW)).toBeUndefined();
		expect(waitReasons(jobs, tight, NOW).get("walk")).toBe("memory");
	});

	it("isn't a build, so it never waits for a VM check or a builder being lent", () => {
		const jobs = [
			job("check", { kind: "vm-check", started: startedAgo(RAMP_MS + 60_000) }),
			job("beside", { started: startedAgo(RAMP_MS + 60_000) }),
			job("walk", { kind: "world-walk", what: "git push" }),
		];
		const lending = { ...ROOMY, lendingSince: NOW - 10_000 };
		expect(nextTurn(jobs, lending, NOW)?.id).toBe("walk");
		expect(nextTurn(jobs, lending, NOW)?.capped).toBeUndefined();
	});
});

describe("walks of World's objects among themselves", () => {
	const home = "/home/j";
	const inWorld = { cwd: `${home}/world/trees/w-main/src`, home };
	const long = startedAgo(RAMP_MS + 60_000);
	const plenty = { ...ROOMY, availableGib: 100 };
	const walk = (id: string, over: Partial<Job> = {}) =>
		job(id, { kind: "world-walk", what: "git fetch", ...over });

	it("reads a plain fetch of origin's main as one, however it is written", () => {
		// Each as an agent ran it on 4 and 5 November.
		for (const fetching of [
			"git fetch -q origin main 2>&1 | tail -2",
			"timeout 300 git fetch origin main 2>&1 | tail -1",
			"git fetch -q --no-tags origin main",
			"git fetch origin main 2>&1 | grep -v '^remote: *$'",
			"timeout 250 git fetch --no-tags origin refs/heads/main 2>&1 | tail -3",
			"git -c fetch.uriProtocols=https fetch --no-tags origin refs/heads/main",
			"git fetch -q origin refs/heads/main:refs/remotes/origin/main",
			"git fetch origin main > $L 2>&1",
		]) {
			expect(walkOf(fetching, inWorld), fetching).toBe("main-fetch");
		}
		expect(
			walkOf("cd ~/world/trees/a/src && git fetch origin main", { home }),
		).toBe("main-fetch");
	});

	it("reads a push, alone or after a fetch of main, as a push", () => {
		expect(walkOf("git push origin x", inWorld)).toBe("push");
		// One that leaves out the stale-cutoff hook runs through the queue's
		// hooks too, which is where it is left out (push-hooks.mjs).
		expect(
			walkOf("PI_PUSH_SKIPS_STALE_CUTOFF=1 git push origin x", inWorld),
		).toBe("push");
		expect(
			walkOf("git fetch origin main && git push origin HEAD:x", inWorld),
		).toBe("push");
	});

	it("knows a push of World that skips its pre-push hooks", () => {
		// Each as an agent ran it on 6 November.
		for (const skipping of [
			"git push --no-verify -u origin jitsusama/refscale-replay 2>&1",
			"(git push --no-verify -u origin jitsusama/refscale-replay > $TMPDIR/push.log 2>&1)",
			"timeout 3000 git -c protocol.version=2 -c push.negotiate=true push --no-verify origin HEAD:refs/heads/x",
			"git fetch origin main && git push origin x --no-verify",
		]) {
			expect(skipsWorldPushHooks(skipping, inWorld), skipping).toBe(true);
		}
		for (const keeping of [
			"git push origin x",
			// A dry run, for a push.
			"git push -n origin x",
			"git push --no-verify --verify origin x",
			"git commit --no-verify -m wip",
			"echo 'git push --no-verify origin x'",
		]) {
			expect(skipsWorldPushHooks(keeping, inWorld), keeping).toBe(false);
		}
		expect(
			skipsWorldPushHooks("git push --no-verify origin x", {
				cwd: `${home}/src/core.nix`,
				home,
			}),
			"a push that skips hooks outside World is none of this",
		).toBe(false);
	});

	it("reads every other walk as other, and nothing outside World", () => {
		for (const other of [
			"timeout 300 git fetch origin river/deferred-metadata",
			"git fetch origin main river/deferred-metadata",
			// Every branch, not main alone.
			"git fetch origin",
			"git fetch --prune origin main",
			"git fetch --depth 1 origin main",
			"git fetch delta main",
			// A git by its path never finds the queue's first on the PATH.
			"/run/current-system/sw/bin/git fetch origin main",
			"git --git-dir=/home/j/world/git fetch origin main",
			"git pull origin main",
			"git fetch origin main && git fetch origin x",
			"git push origin x && git fetch origin x",
			"git gc --auto",
		]) {
			expect(walkOf(other, inWorld), other).toBe("other");
		}
		expect(
			walkOf("git fetch origin main", { cwd: `${home}/src/core.nix`, home }),
		).toBeUndefined();
		expect(walkOf("git log origin/main", inWorld)).toBeUndefined();
	});

	it("puts pushes and fetches of main ahead of other walks, leaving other work its place", () => {
		// 5 November: a push waited 61 minutes behind review fetches.
		const jobs = [
			walk("review", { walk: "other", since: startedAgo(9_000) }),
			job("build", { since: startedAgo(8_000) }),
			walk("review2", { walk: "other", since: startedAgo(7_000) }),
			walk("push", { walk: "push", since: startedAgo(6_000) }),
			walk("main", { walk: "main-fetch", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs).map((one) => one.id)).toEqual([
			"push",
			"build",
			"main",
			"review",
			"review2",
		]);
		const busy = [
			...jobs,
			walk("one", { started: long }),
			walk("two", { started: long }),
		];
		const after = busy.filter((one) => one.id !== "two" && one.id !== "build");
		expect(nextTurn(after, plenty, NOW)?.id).toBe("push");
	});

	it("holds a fetch of main while one runs, letting other walks past", () => {
		// 5 November, 21:03: four fetches of main waited behind one running.
		const jobs = [
			walk("fetching", { walk: "main-fetch", started: long }),
			walk("main", { walk: "main-fetch", since: startedAgo(9_000) }),
			walk("review", { walk: "other", since: startedAgo(8_000) }),
		];
		expect(nextTurn(jobs, plenty, NOW)?.id).toBe("review");
		expect(waitReasons(jobs, plenty, NOW).get("main")).toBe("walks");
		// One running too long holds it no longer.
		const hung = jobs.map((one) =>
			one.id === "fetching"
				? { ...one, started: startedAgo(JOINS_FOR_MS + 1_000) }
				: one,
		);
		expect(nextTurn(hung, plenty, NOW)?.id).toBe("main");
		// Nor does one that was itself answered, nor one of older rules.
		for (const running of [
			walk("fetching", { walk: "main-fetch", started: long, answered: true }),
			walk("fetching", { started: long }),
		]) {
			const others = [running, ...jobs.slice(1)];
			expect(nextTurn(others, plenty, NOW)?.id).toBe("main");
		}
	});

	it("counts an answered fetch as no walk, no memory and no turn to space out", () => {
		const answered = (id: string) =>
			walk(id, {
				walk: "main-fetch",
				started: startedAgo(1_000),
				answered: true,
			});
		const jobs = [
			answered("a"),
			answered("b"),
			walk("review", { walk: "other", since: startedAgo(9_000) }),
		];
		const six = { ...ROOMY, availableGib: 6 };
		expect(nextTurn(jobs, six, NOW)?.id).toBe("review");
	});
});
