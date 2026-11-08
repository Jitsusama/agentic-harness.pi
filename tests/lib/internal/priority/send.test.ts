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
