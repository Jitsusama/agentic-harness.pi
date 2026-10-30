/**
 * Where a bash call runs, decided once for the call, so the interceptor
 * that rewrites it and the mesh that reads it see the same command.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whereItRuns } from "../../../../lib/internal/priority/send.ts";

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
			"#!/bin/sh\nprintf 'tree\\napply\\nout\\nwants\\nfolder\\n'\n",
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
});
