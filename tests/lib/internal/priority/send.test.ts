/**
 * Where a bash call runs, decided once for the call, so the interceptor
 * that rewrites it and the mesh that reads it see the same command.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Far,
	placedFarKnown,
	placesFar,
	placesNow,
	refusedHere,
	sendsWholeRun,
	whereItRuns,
} from "../../../../lib/internal/priority/send.ts";

describe("where a call runs", () => {
	it("is as written for a command that sends nothing", async () => {
		expect(await whereItRuns("call-1", "ls -la", "/")).toBeUndefined();
	});

	it("is decided once a call, so every reader of it gets the one answer", () => {
		const first = whereItRuns("call-2", "nix build .#x", "/");
		expect(whereItRuns("call-2", "nix build .#x", "/")).toBe(first);
		expect(whereItRuns("call-3", "nix build .#x", "/")).not.toBe(first);
	});
});

describe("where a copy of a tree's VM check runs", () => {
	let root: string;
	let before: { path?: string; config?: string };

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "send-"));
		const config = join(root, "config", "pi", "agentic-harness.pi");
		mkdirSync(config, { recursive: true });
		writeFileSync(
			join(config, "config.json"),
			JSON.stringify({
				version: 1,
				sections: { "remote-checks": { repos: ["Owner/public"] } },
			}),
		);
		// A stand-in for an nix-offload that takes folders.
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "nix-offload"),
			"#!/bin/sh\nprintf 'tree\\napply\\nout\\nwants\\nfolder\\nchanged\\n'\n",
			{ mode: 0o755 },
		);
		before = { path: process.env.PATH, config: process.env.XDG_CONFIG_HOME };
		process.env.PATH = `${bin}:${before.path ?? ""}`;
		process.env.XDG_CONFIG_HOME = join(root, "config");
	});

	afterEach(() => {
		process.env.PATH = before.path;
		if (before.config === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = before.config;
		rmSync(root, { recursive: true, force: true });
	});

	it("goes as the folder, as QGB4ON made its copies on 30 October", async () => {
		const copy = join(root, "copy");
		mkdirSync(copy);
		writeFileSync(join(copy, "flake.nix"), "{ }\n");
		execFileSync("git", ["init", "-q"], { cwd: copy });
		execFileSync("git", ["add", "-A"], { cwd: copy });
		const built = await whereItRuns(
			"copy-build",
			`d=${copy}; nix build --no-link -L "path:$d#checks.x86_64-linux.vm-a" > $d/log 2>&1`,
			root,
		);
		expect(built).toContain(
			`nix-offload there -L path:${copy} checks.x86_64-linux.vm-a`,
		);
		const ran = await whereItRuns(
			"copy-run",
			`cd ${copy} && nix develop "path:${copy}" -c run-subtests vm-a "one"`,
			root,
		);
		expect(ran).toContain("run-subtests --there vm-a");
	});

	const repoWith = (name: string, origin: string) => {
		const repo = join(root, name);
		mkdirSync(repo);
		writeFileSync(join(repo, "flake.nix"), "{ }\n");
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q");
		git("add", "-A");
		git(
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"one",
		);
		git("remote", "add", "origin", origin);
		return repo;
	};
	// A loop's variable is one the interceptor can't read.
	const LOOP =
		'for c in a b; do nix build --no-link -L ".#checks.x86_64-linux.vm-$c"; done';

	it("refuses a public repo's VM check it can't send, saying how to send it", async () => {
		const repo = repoWith("public", "https://github.com/Owner/public.git");
		expect(await whereItRuns("loop", LOOP, repo)).toBeUndefined();
		const refused = await refusedHere("loop", LOOP, repo);
		expect(refused).toContain("nix-offload there");
		expect(refused).toContain("run-subtests --there");
	});

	it("leaves a World tree's VM tests here, and a run that needs this machine", async () => {
		const world = repoWith("world", "https://delta.example/world.git");
		expect(await refusedHere("world", LOOP, world)).toBeUndefined();
		const repo = repoWith("public", "https://github.com/Owner/public.git");
		expect(
			await refusedHere("prompt", "run-subtests -I vm-a", repo),
		).toBeUndefined();
		expect(await refusedHere("ls", "ls -la", repo)).toBeUndefined();
	});

	it("leaves a build asked for here on purpose, with --here", async () => {
		const repo = repoWith("public", "https://github.com/Owner/public.git");
		const here =
			'for c in a b; do nix-offload there --here -L . "checks.x86_64-linux.vm-$c"; done';
		expect(await whereItRuns("here", here, repo)).toBeUndefined();
		expect(await refusedHere("here", here, repo)).toBeUndefined();
		expect(
			await refusedHere("cc-here", "changed-checks --build --here", repo),
		).toBeUndefined();
	});

	it("leaves changed-checks to send its own run, when it can", async () => {
		const repo = repoWith("public", "https://github.com/Owner/public.git");
		const cc = "direnv exec . changed-checks --build";
		expect(await refusedHere("cc", cc, repo)).toBeUndefined();
		expect(await refusedHere("cc-loop", `${cc} && ${LOOP}`, repo)).toContain(
			"nix-offload there",
		);
	});
});

describe("whether a changed-checks run sends itself to the builder", () => {
	const TAKES = {
		tree: true,
		subtests: true,
		wants: true,
		folder: true,
		changed: true,
	};
	const committed = () => true;

	it("does when nix-offload takes it and nothing keeps it here", () => {
		expect(
			sendsWholeRun(
				"timeout 3600 direnv exec . changed-checks > $TMPDIR/cc.log 2>&1",
				"/tree",
				TAKES,
				committed,
			),
			"a committed tree's changed-checks run goes to the builder",
		).toBe(true);
	});

	it("doesn't before nix-offload says what it takes, or when it can't take it", () => {
		const cc = "direnv exec . changed-checks";
		expect(
			sendsWholeRun(cc, "/tree", undefined, committed),
			"nothing is sent before nix-offload says what it takes",
		).toBe(false);
		expect(
			sendsWholeRun(cc, "/tree", { ...TAKES, changed: false }, committed),
			"nothing is sent when nix-offload cannot take changed-checks",
		).toBe(false);
	});

	it("doesn't when asked to run here, or given a base that may stay here", () => {
		for (const cc of [
			"direnv exec . changed-checks --build --here",
			"CHANGED_CHECKS_HERE=1 changed-checks",
			"direnv exec . changed-checks --base jitsusama/greeter",
			"direnv exec . changed-checks --base=origin/main",
		]) {
			expect(
				sendsWholeRun(cc, "/tree", TAKES, committed),
				`${cc} stays here`,
			).toBe(false);
		}
	});

	it("asks the folder each step runs in whether its tree is committed", () => {
		const asked: string[] = [];
		const sent = sendsWholeRun(
			"cd /other && direnv exec . changed-checks 2>&1 | grep -v direnv",
			"/tree",
			TAKES,
			(folder) => {
				asked.push(folder);
				return false;
			},
		);
		expect(sent, "a run whose folder is uncommitted stays here").toBe(false);
		expect(asked).toEqual(["/other"]);
	});

	it("doesn't when the command does other heavy work beside it", () => {
		expect(
			sendsWholeRun(
				"nix build .#checks.x86_64-linux.boot && changed-checks",
				"/tree",
				TAKES,
				committed,
			),
			"a changed-checks run behind a nix build stays here",
		).toBe(false);
		expect(
			sendsWholeRun("nix build .#x", "/tree", TAKES, committed),
			"a nix build with no changed-checks is not sent",
		).toBe(false);
	});

	it("does for a nix-offload there that builds here only while idle", () => {
		const check =
			"env -u SSH_AUTH_SOCK nix-offload there --here-when-idle . checks.x86_64-linux.every-long-file-says-why";
		expect(
			sendsWholeRun(check, "/tree", undefined, () => false),
			"it is sent whatever nix-offload takes and however the tree stands",
		).toBe(true);
		expect(
			sendsWholeRun(
				"nix-offload there --here-when-idle . checks.x86_64-linux.vm-boot && changed-checks",
				"/tree",
				TAKES,
				committed,
			),
			"beside a changed-checks that sends itself, the whole run is sent",
		).toBe(true);
	});

	describe("for an elsewhere run", () => {
		const asked: string[] = [];
		beforeEach(() => {
			asked.length = 0;
		});
		const far: Far = {
			quest: "QEST-X",
			placedFar: (kind: string) => {
				asked.push(kind);
				return kind !== "stays";
			},
		};
		const sent = (run: string, with_: Far = far) =>
			sendsWholeRun(run, "/tree", undefined, () => false, "/home", with_);

		it("does when a quest session's run is placed on another machine", () => {
			for (const run of [
				"elsewhere run harness-check -- pnpm exec vitest run tests/lib/internal/priority",
				"timeout 900 elsewhere run harness-check -- pnpm typecheck > $TMPDIR/tc.log 2>&1",
				"cd /tree && env -u SSH_AUTH_SOCK CI=1 elsewhere run delta-spec -- cargo test",
			]) {
				expect(sent(run), `${run} is sent whatever nix-offload takes`).toBe(
					true,
				);
			}
			expect(asked).toEqual(["harness-check", "harness-check", "delta-spec"]);
		});

		it("doesn't where elsewhere would run it here", () => {
			const run = "elsewhere run harness-check -- pnpm typecheck";
			expect(sent(run, { placedFar: far.placedFar }), "with no quest").toBe(
				false,
			);
			expect(
				sent("elsewhere run harness-check --here -- pnpm typecheck"),
				"asked to stay with --here",
			).toBe(false);
			expect(
				sent("elsewhere run stays -- pnpm typecheck"),
				"placed on no other machine",
			).toBe(false);
			expect(
				sent("PI_QUEST= elsewhere run harness-check -- pnpm typecheck"),
				"with the quest cleared for the step",
			).toBe(false);
			expect(
				sent("unset PI_QUEST; elsewhere run harness-check -- pnpm typecheck"),
				"with the quest cleared by an earlier step",
			).toBe(false);
			expect(
				sent(
					"export PATH=/tmp/x:$PATH; elsewhere run harness-check -- pnpm test",
				),
				"with PATH changed by an earlier step",
			).toBe(false);
			expect(
				sent(
					"elsewhere run harness-check -- pnpm test && nix-offload there --here-when-idle . checks.x86_64-linux.x",
				),
				"beside an idle-only build, which may build here",
			).toBe(false);
			expect(asked).toEqual(["stays"]);
		});

		it("doesn't for local heavy work that only mentions it", () => {
			for (const run of [
				"elsewhere run harness-check -- pnpm test && pnpm exec vitest run",
				"pnpm exec vitest run -t 'elsewhere run harness-check'",
				'cargo test -- "elsewhere run delta-spec"',
				"elsewhere where harness-check && pnpm exec vitest run",
			]) {
				expect(sent(run), `${run} runs heavy work here`).toBe(false);
			}
		});
	});

	describe("placedFarKnown", () => {
		const answers = () => {
			const pending: ((far: boolean) => void)[] = [];
			const ask = (_kind: string) =>
				new Promise<boolean>((resolve) => {
					pending.push(resolve);
				});
			return { ask, pending };
		};
		const settled = () => new Promise((resolve) => setImmediate(resolve));

		it("says here until elsewhere first answers far, then far", async () => {
			const { ask, pending } = answers();
			const now = Date.now();
			expect(
				placedFarKnown("first-answer", now, ask),
				"here before any answer",
			).toBe(false);
			expect(pending).toHaveLength(1);
			expect(
				placedFarKnown("first-answer", now + 1_000, ask),
				"still here while the ask is out",
			).toBe(false);
			expect(pending, "asked once a minute at most").toHaveLength(1);
			pending[0]?.(true);
			await settled();
			expect(
				placedFarKnown("first-answer", Date.now(), ask),
				"far once elsewhere answered far",
			).toBe(true);
		});

		it("stops believing far once the answer outlives two asks", async () => {
			const { ask, pending } = answers();
			const now = Date.now();
			placedFarKnown("goes-stale", now, ask);
			pending[0]?.(true);
			await settled();
			expect(
				placedFarKnown("goes-stale", now + 61_000, ask),
				"a minute-old answer of far still holds",
			).toBe(true);
			expect(pending, "a minute on, it asks again").toHaveLength(2);
			expect(
				placedFarKnown("goes-stale", Date.now() + 121_000, ask),
				"the ask still out leaves the old answer too old",
			).toBe(false);
		});

		it("believes a later answer of here at once", async () => {
			const { ask, pending } = answers();
			const now = Date.now();
			placedFarKnown("turns-here", now, ask);
			pending[0]?.(true);
			await settled();
			placedFarKnown("turns-here", now + 61_000, ask);
			pending[1]?.(false);
			await settled();
			expect(
				placedFarKnown("turns-here", now + 62_000, ask),
				"a later answer of here holds at once",
			).toBe(false);
		});

		// An agent runs a check, edits for minutes and runs it again, so an
		// answer kept warm only by its runs would nearly always be stale.
		it("has a fresh answer waited for before a run is queued", async () => {
			const { ask, pending } = answers();
			const now = Date.now();
			const run = "cd x && elsewhere run waits-first -- pnpm test";
			let done = false;
			const placed = placesNow(run, "/tree", "/home", ask, now, "Q").then(
				() => {
					done = true;
				},
			);
			await settled();
			expect(done, "waits for elsewhere's answer").toBe(false);
			pending[0]?.(true);
			await placed;
			expect(
				placedFarKnown("waits-first", Date.now(), ask),
				"the answer waited for is kept",
			).toBe(true);

			const later = now + 5 * 60_000;
			let doneAgain = false;
			const again = placesNow(run, "/tree", "/home", ask, later, "Q").then(
				() => {
					doneAgain = true;
				},
			);
			expect(pending, "five minutes on, it asks again").toHaveLength(2);
			await settled();
			expect(doneAgain, "and waits, the old answer being stale").toBe(false);
			pending[1]?.(true);
			await again;
			expect(
				placedFarKnown("waits-first", Date.now(), ask),
				"the fresh answer is kept",
			).toBe(true);
		});

		it("waits for nothing when no step is an elsewhere run, or the answer is fresh", async () => {
			const { ask, pending } = answers();
			const now = Date.now();
			const run = "elsewhere run fresh-already -- pnpm test";
			for (const [command, quest] of [
				["pnpm test # elsewhere later", "Q"],
				["echo elsewhere run x -- y", "Q"],
				[`unset PI_QUEST; ${run}`, "Q"],
				[run, ""],
			] as const) {
				await placesNow(command, "/tree", "/home", ask, now, quest);
			}
			expect(pending, "no answer could make these sent").toHaveLength(0);
			const first = placesNow(run, "/tree", "/home", ask, now, "Q");
			pending[0]?.(true);
			await first;
			await placesNow(run, "/tree", "/home", ask, Date.now() + 1_000, "Q");
			expect(pending, "asked once").toHaveLength(1);
		});
	});

	describe("placesFar", () => {
		it("reads elsewhere's where answer, and anything else as here", () => {
			expect(
				placesFar(
					'{"because":"placed","here":false,"kind":"harness-check","machine":"equilibrius","programs":["pnpm"],"schema":"elsewhere.where/1"}',
				),
				"an answer placed on another machine is far",
			).toBe(true);
			for (const answer of [
				'{"here":true,"kind":"harness-check"}',
				'{"kind":"harness-check"}',
				'{"here":"false"}',
				"null",
				"here",
				"",
			]) {
				expect(placesFar(answer), answer).toBe(false);
			}
		});
	});

	it("doesn't for a nix-offload there that may build here when unsent", () => {
		for (const check of [
			"nix-offload there --here . checks.x86_64-linux.boot",
			"nix-offload there --here-when-idle --here . checks.x86_64-linux.boot",
			"nix-offload there --here-when-idle . checks.x86_64-linux.boot && nix build .#x",
		]) {
			expect(
				sendsWholeRun(check, "/tree", TAKES, committed),
				`${check} may build here`,
			).toBe(false);
		}
	});

	it("reads a tree with a change git tracks as uncommitted, as changed-checks does", () => {
		const tree = mkdtempSync(join(tmpdir(), "send-committed-"));
		try {
			execFileSync("git", ["-C", tree, "init", "-q"], { stdio: "ignore" });
			writeFileSync(join(tree, "flake.nix"), "{}\n");
			expect(
				sendsWholeRun("changed-checks", tree, TAKES),
				"a tree whose only file git does not track reads as committed",
			).toBe(true);
			execFileSync("git", ["-C", tree, "add", "flake.nix"], {
				stdio: "ignore",
			});
			expect(
				sendsWholeRun("changed-checks", tree, TAKES),
				"a tree with a staged change reads as uncommitted",
			).toBe(false);
			expect(
				sendsWholeRun("changed-checks", join(tree, "gone"), TAKES),
				"a folder that is not there is never sent",
			).toBe(false);
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});
});
