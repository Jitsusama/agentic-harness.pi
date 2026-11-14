/**
 * How a fenced command reaches GitHub through the GitHub door: the
 * session's own folder of the door's bound in and let through, the
 * door's control socket kept out, and the shell text that opens the
 * session outside and points gh and git at the door inside, run here
 * through stand-ins for bubblewrap, landrun and the door.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fenceArgs,
	fencedCommand,
	fenceRules,
	GITHUB_PLACEHOLDER,
	githubDoorFolder,
	NEVER_THROUGH,
} from "../../../lib/internal/fence.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";

const runtimeDir = "/run/user/1000";
const folder = "/run/user/1000/pi-github/sessions/s-1";
const nothing: Disk = { kind: () => undefined, entries: () => [] };

describe("the session's folder of the GitHub door's", () => {
	it("is named for the session in the runtime folder", () => {
		expect(githubDoorFolder(runtimeDir, "s-1")).toBe(folder);
	});

	it("is nothing for a session whose id could name another folder, or without a runtime folder", () => {
		for (const session of ["", "../s", "a/b", "s 1", "x".repeat(65)])
			expect(
				githubDoorFolder(runtimeDir, session),
				`${JSON.stringify(session)} named a folder`,
			).toBeUndefined();
		expect(githubDoorFolder(runtimeDir, undefined)).toBeUndefined();
		expect(githubDoorFolder(undefined, "s-1")).toBeUndefined();
	});

	it("is bound in read-only, tried since the door makes it just before, after the runtime folder is emptied", () => {
		const args = fenceArgs(
			{ home: "/home/someone", runtimeDir, githubDoor: folder },
			nothing,
		);
		const at = args.indexOf("--ro-bind-try");
		expect(args.slice(at, at + 3), "the folder isn't bound").toEqual([
			"--ro-bind-try",
			folder,
			folder,
		]);
		expect(at, "bound before the runtime folder is emptied").toBeGreaterThan(
			args.indexOf(runtimeDir),
		);
		expect(
			fenceArgs({ home: "/home/someone", runtimeDir }, nothing),
			"a folder was bound where the door isn't",
		).not.toContain("--ro-bind-try");
	});

	it("is let through Landlock, while the door's control socket is not", () => {
		const rules = fenceRules({
			home: "/home/someone",
			runtimeDir,
			githubDoor: folder,
		});
		const through = rules.flatMap((rule, at) =>
			rule === "--unix" ? [rules[at + 1]] : [],
		);
		expect(through).toContain(folder);
		expect(through).not.toContain(join(runtimeDir, "pi-github/control.sock"));
		expect(NEVER_THROUGH).toContain("pi-github/control.sock");
	});
});

describe("a fenced command with the GitHub door", () => {
	let base: string;
	let session: string;
	let opened: string;
	let door: string;
	let skip: string;
	let server: Server | undefined;
	const POINTED = [
		"HTTPS_PROXY",
		"https_proxy",
		"GH_TOKEN",
		"SSL_CERT_FILE",
		"GIT_SSL_CAINFO",
		"NIX_SSL_CERT_FILE",
		"NODE_EXTRA_CA_CERTS",
	];

	beforeAll(() => {
		// Not resolved, since a Unix socket's path may be at most 107
		// bytes and a temporary folder can sit behind a long link.
		base = mkdtempSync(join(tmpdir(), "fg-"));
		session = join(base, "s");
		mkdirSync(session);
		opened = join(base, "opened");
		door = join(base, "door");
		writeFileSync(
			door,
			[
				"#!/usr/bin/env bash",
				`case $1 in open) echo "$@" >> ${opened};; relay) echo 4242;; esac`,
			].join("\n"),
		);
		// bubblewrap and landrun alike: what follows their first `--` runs.
		skip = join(base, "skip");
		writeFileSync(
			skip,
			[
				"#!/usr/bin/env bash",
				'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
				'shift; exec "$@"',
			].join("\n"),
		);
		chmodSync(door, 0o755);
		chmodSync(skip, 0o755);
	});

	afterAll(async () => {
		await new Promise((settle) =>
			server ? server.close(settle) : settle(undefined),
		);
		rmSync(base, { recursive: true, force: true });
	});

	/** What `env` prints run as a fenced command, by name. */
	function fencedEnv(): Map<string, string> {
		const text = fencedCommand("env", {
			bwrap: skip,
			landrun: skip,
			args: [],
			rules: [],
			github: { program: door, session: "s-1", folder: session },
		});
		const ran = spawnSync("bash", ["-c", text], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(ran.status, ran.stderr).toBe(0);
		return new Map(
			ran.stdout
				.split("\n")
				.map((line) => line.split("=", 2) as [string, string])
				.filter(([name]) => POINTED.includes(name)),
		);
	}

	it("sets nothing for gh while the door hasn't made the session's folder, so gh fails as it did", () => {
		expect([...fencedEnv().keys()], "gh was pointed at no door").toEqual([]);
	});

	it("asks the door for the session outside, and points gh and git at its relay inside once the folder is there", async () => {
		const bundle = join(session, "bundle.pem");
		writeFileSync(bundle, "");
		server = createServer();
		await new Promise<void>((settle) =>
			server?.listen(join(session, "door.sock"), settle),
		);
		const env = fencedEnv();
		expect(env.get("HTTPS_PROXY")).toBe("http://127.0.0.1:4242");
		expect(env.get("https_proxy")).toBe("http://127.0.0.1:4242");
		expect(env.get("GH_TOKEN")).toBe(GITHUB_PLACEHOLDER);
		for (const name of [
			"SSL_CERT_FILE",
			"GIT_SSL_CAINFO",
			"NIX_SSL_CERT_FILE",
			"NODE_EXTRA_CA_CERTS",
		])
			expect(env.get(name), `${name} doesn't trust the session's bundle`).toBe(
				bundle,
			);
		expect(
			spawnSync("cat", [opened], { encoding: "utf8" }).stdout,
			"the session wasn't opened outside",
		).toContain("open s-1");
	});
});
